/**
 * DataCacheService — shared data layer for APRS positions, alerts, spots, and summits.
 *
 * Key strategies:
 * - In-flight request deduplication: concurrent calls for the same resource share
 *   one HTTP request (no N×parallel requests from multiple components).
 * - Stale-while-revalidate for fast-changing data (APRS, alerts, spots):
 *   returns cached data immediately, then refreshes in background.
 * - IndexedDB persistence for summits (changes once daily): survives navigation
 *   and browser sessions. Per-association files reduce download size by ~90%.
 * - Configurable TTLs so the map's 60 s refresh and the alerts page's 30 s
 *   refresh both read from cache without duplicate network calls.
 */

import { Injectable, inject } from '@angular/core';
import {
  HttpClient,
  HttpHeaders,
} from '@angular/common/http';
import {
  Observable,
  from,
  of,
  Subject,
  switchMap,
  tap,
  shareReplay,
  finalize,
  firstValueFrom,
} from 'rxjs';
import { fetchAuthSession } from 'aws-amplify/auth';
import { environment } from '../../environments/environment';
import { AprsPosition, SotaAlert, SotaSpot } from './api.service';

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

const IDB_DB_NAME    = 'sota-watchtower-cache';
const IDB_DB_VERSION = 1;
const IDB_STORE      = 'summits';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror   = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch {
    // Non-fatal: just skip caching if IndexedDB is unavailable
  }
}

async function idbDeleteKeysWithPrefix(prefix: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req   = store.getAllKeys();
      req.onsuccess = () => {
        const keys = req.result as string[];
        keys.filter(k => k.startsWith(prefix)).forEach(k => store.delete(k));
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-fatal
  }
}

// ─── Cache entry types ────────────────────────────────────────────────────────

interface MemCacheEntry<T> {
  data: T;
  fetchedAt: number;
}

// ─── Summit fetch configuration ────────────────────────────────────────────────

/**
 * Build a key for the per-association S3 summit file.
 * The RefreshSummitsFunction writes files at:
 *   summits/<ASSOC>.json  (gzip-encoded, same bucket/pattern as summits.json)
 *
 * summitsUrl points to:  https://bucket.s3.region.amazonaws.com/summits.json
 * Per-assoc URL becomes: https://bucket.s3.region.amazonaws.com/summits/<ASSOC>.json
 */
function buildAssocSummitsUrl(baseUrl: string, assoc: string): string {
  // Replace trailing "summits.json" with "summits/<ASSOC>.json"
  return baseUrl.replace(/summits\.json$/, `summits/${assoc}.json`);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class DataCacheService {
  private http = inject(HttpClient);
  private base = environment.apiBaseUrl;

  /** TTLs in milliseconds */
  private readonly APRS_TTL    = 30_000;
  private readonly ALERTS_TTL  = 30_000;
  private readonly SPOTS_TTL   = 30_000;

  // ─── In-memory caches ───────────────────────────────────────────────────────

  private aprsCache:    MemCacheEntry<AprsPosition[]> | null  = null;
  private alertsCache:  MemCacheEntry<SotaAlert[]>    | null  = null;
  private spotsCache:   MemCacheEntry<SotaSpot[]>     | null  = null;
  private summitsCache: GeoJSON.FeatureCollection     | null  = null;

  // ─── In-flight observables (request dedup) ──────────────────────────────────

  private aprsInFlight$:    Observable<AprsPosition[]>           | null = null;
  private alertsInFlight$:  Observable<SotaAlert[]>              | null = null;
  private spotsInFlight$:   Observable<SotaSpot[]>               | null = null;
  private summitsInFlight$: Promise<GeoJSON.FeatureCollection>   | null = null;

  // ─── Subject so components can subscribe to background refreshes ────────────

  private aprsRefresh$   = new Subject<AprsPosition[]>();
  private alertsRefresh$ = new Subject<SotaAlert[]>();
  private spotsRefresh$  = new Subject<SotaSpot[]>();

  /** Emit here when config changes to force summits cache invalidation. */
  private configuredAssociations: string[] | null = null;

  // ─── Auth helpers ────────────────────────────────────────────────────────────

  private authHeaders(): Observable<HttpHeaders> {
    return from(fetchAuthSession()).pipe(
      switchMap(session => {
        const token = session.tokens?.idToken?.toString() ?? '';
        return [new HttpHeaders({ Authorization: token })];
      })
    );
  }

  // ─── APRS Positions ─────────────────────────────────────────────────────────

  /**
   * Returns APRS positions.
   *
   * Stale-while-revalidate:
   * - If cache is fresh (< APRS_TTL) → return cache immediately.
   * - If cache is stale but exists → return cache immediately AND trigger
   *   a background refresh that emits on aprsRefresh$.
   * - If no cache → fetch, block until data arrives.
   */
  getAprsPositions(forceRefresh = false): Observable<AprsPosition[]> {
    const now = Date.now();
    const fresh = this.aprsCache && (now - this.aprsCache.fetchedAt) < this.APRS_TTL;

    if (!forceRefresh && fresh) {
      return of(this.aprsCache!.data);
    }

    // Stale cache exists → return it immediately and refresh in background
    if (!forceRefresh && this.aprsCache && !fresh) {
      this.refreshAprsInBackground();
      return of(this.aprsCache.data);
    }

    // No cache or force refresh → fetch (dedup if in-flight)
    if (!this.aprsInFlight$) {
      this.aprsInFlight$ = this.http.get<AprsPosition[]>(`${this.base}/aprs-positions`).pipe(
        tap(data => { this.aprsCache = { data, fetchedAt: Date.now() }; }),
        finalize(() => { this.aprsInFlight$ = null; }),
        shareReplay(1),
      );
    }
    return this.aprsInFlight$;
  }

  private refreshAprsInBackground(): void {
    if (this.aprsInFlight$) return; // already refreshing
    this.aprsInFlight$ = this.http.get<AprsPosition[]>(`${this.base}/aprs-positions`).pipe(
      tap(data => {
        this.aprsCache = { data, fetchedAt: Date.now() };
        this.aprsRefresh$.next(data);
      }),
      finalize(() => { this.aprsInFlight$ = null; }),
      shareReplay(1),
    );
    // Subscribe to trigger the request
    this.aprsInFlight$.subscribe({ error: () => {} });
  }

  // ─── Alerts ─────────────────────────────────────────────────────────────────

  getAlerts(forceRefresh = false): Observable<SotaAlert[]> {
    const now   = Date.now();
    const fresh = this.alertsCache && (now - this.alertsCache.fetchedAt) < this.ALERTS_TTL;

    if (!forceRefresh && fresh) {
      return of(this.alertsCache!.data);
    }

    if (!forceRefresh && this.alertsCache && !fresh) {
      this.refreshAlertsInBackground();
      return of(this.alertsCache.data);
    }

    if (!this.alertsInFlight$) {
      this.alertsInFlight$ = this.authHeaders().pipe(
        switchMap(headers => this.http.get<SotaAlert[]>(`${this.base}/alerts`, { headers })),
        tap(data => { this.alertsCache = { data, fetchedAt: Date.now() }; }),
        finalize(() => { this.alertsInFlight$ = null; }),
        shareReplay(1),
      );
    }
    return this.alertsInFlight$;
  }

  private refreshAlertsInBackground(): void {
    if (this.alertsInFlight$) return;
    this.alertsInFlight$ = this.authHeaders().pipe(
      switchMap(headers => this.http.get<SotaAlert[]>(`${this.base}/alerts`, { headers })),
      tap(data => {
        this.alertsCache = { data, fetchedAt: Date.now() };
        this.alertsRefresh$.next(data);
      }),
      finalize(() => { this.alertsInFlight$ = null; }),
      shareReplay(1),
    );
    this.alertsInFlight$.subscribe({ error: () => {} });
  }

  // ─── Spots ──────────────────────────────────────────────────────────────────

  getSpots(forceRefresh = false): Observable<SotaSpot[]> {
    const now   = Date.now();
    const fresh = this.spotsCache && (now - this.spotsCache.fetchedAt) < this.SPOTS_TTL;

    if (!forceRefresh && fresh) {
      return of(this.spotsCache!.data);
    }

    if (!forceRefresh && this.spotsCache && !fresh) {
      this.refreshSpotsInBackground();
      return of(this.spotsCache.data);
    }

    if (!this.spotsInFlight$) {
      this.spotsInFlight$ = this.authHeaders().pipe(
        switchMap(headers => this.http.get<SotaSpot[]>(`${this.base}/spots`, { headers })),
        tap(data => { this.spotsCache = { data, fetchedAt: Date.now() }; }),
        finalize(() => { this.spotsInFlight$ = null; }),
        shareReplay(1),
      );
    }
    return this.spotsInFlight$;
  }

  private refreshSpotsInBackground(): void {
    if (this.spotsInFlight$) return;
    this.spotsInFlight$ = this.authHeaders().pipe(
      switchMap(headers => this.http.get<SotaSpot[]>(`${this.base}/spots`, { headers })),
      tap(data => {
        this.spotsCache = { data, fetchedAt: Date.now() };
        this.spotsRefresh$.next(data);
      }),
      finalize(() => { this.spotsInFlight$ = null; }),
      shareReplay(1),
    );
    this.spotsInFlight$.subscribe({ error: () => {} });
  }

  // ─── Summits (IndexedDB + per-association S3 partitioning) ──────────────────

  /**
   * Load summit GeoJSON with multi-layer caching:
   *   1. In-memory (fastest — already parsed)
   *   2. IndexedDB (fast — survives navigation; keyed by date + associations)
   *   3. Network (S3 per-association files, falling back to full summits.json)
   *
   * @param associations Configured associations (e.g. ['DL','OE']). If provided,
   *   downloads per-association files in parallel. Falls back to full file on 404.
   */
  async getSummits(associations?: string[]): Promise<GeoJSON.FeatureCollection> {
    // Return in-memory result if associations haven't changed
    if (this.summitsCache && this.isSameAssociations(associations)) {
      return this.summitsCache;
    }

    // Dedup concurrent calls
    if (this.summitsInFlight$) {
      return this.summitsInFlight$;
    }

    this.summitsInFlight$ = this.loadSummitsWithCache(associations).finally(() => {
      this.summitsInFlight$ = null;
    });

    const result = await this.summitsInFlight$;
    this.summitsCache = result;
    this.configuredAssociations = associations ?? null;
    return result;
  }

  private isSameAssociations(associations?: string[]): boolean {
    if (!associations && !this.configuredAssociations) return true;
    if (!associations || !this.configuredAssociations) return false;
    if (associations.length !== this.configuredAssociations.length) return false;
    return associations.every((a, i) => a === this.configuredAssociations![i]);
  }

  private async loadSummitsWithCache(
    associations?: string[],
  ): Promise<GeoJSON.FeatureCollection> {
    const summitsUrl = (environment as { summitsUrl?: string }).summitsUrl ?? '';
    const hasS3Url   = summitsUrl && !summitsUrl.startsWith('${');

    // Build cache key: date + sorted associations (invalidates daily)
    const today    = new Date().toISOString().slice(0, 10);
    const assocKey = associations?.slice().sort().join(',') ?? 'all';
    const cacheKey = `summits:${today}:${assocKey}`;

    // 1. Try IndexedDB
    const cached = await idbGet<GeoJSON.FeatureCollection>(cacheKey);
    if (cached?.features?.length) {
      return cached;
    }

    // 2. Fetch from network
    let geojson: GeoJSON.FeatureCollection;

    if (hasS3Url && associations?.length) {
      // Try per-association files in parallel for faster/smaller downloads
      geojson = await this.fetchPerAssociation(summitsUrl, associations);
    } else if (hasS3Url) {
      // Full worldwide file from S3
      geojson = await fetch(summitsUrl).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GeoJSON.FeatureCollection>;
      });
    } else {
      // Fallback: Lambda API
      geojson = await firstValueFrom(
        this.http.get<GeoJSON.FeatureCollection>(`${this.base}/summits`)
      );
    }

    // 3. Persist in IndexedDB (evict old keys for this prefix first)
    await idbDeleteKeysWithPrefix('summits:');
    await idbPut(cacheKey, geojson);

    return geojson;
  }

  /**
   * Fetch per-association S3 files in parallel.
   * Falls back to the full summits.json if any per-association file is missing.
   */
  private async fetchPerAssociation(
    baseUrl: string,
    associations: string[],
  ): Promise<GeoJSON.FeatureCollection> {
    const fetches = associations.map(async assoc => {
      const url = buildAssocSummitsUrl(baseUrl, assoc);
      const r   = await fetch(url);
      if (!r.ok) {
        // 404 or not-yet-deployed → fall back to full file
        return null;
      }
      return r.json() as Promise<GeoJSON.FeatureCollection>;
    });

    const results = await Promise.all(fetches);

    // If any per-association file is missing, fall back to the full file
    if (results.some(r => r === null)) {
      return fetch(baseUrl).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GeoJSON.FeatureCollection>;
      });
    }

    // Merge all association feature collections
    const allFeatures = (results as GeoJSON.FeatureCollection[]).flatMap(
      fc => fc.features
    );
    return { type: 'FeatureCollection', features: allFeatures };
  }

  // ─── Cache management ────────────────────────────────────────────────────────

  /**
   * Call this when the user saves new config (especially association changes).
   * Clears the summits cache so the next load fetches the correct associations.
   */
  invalidateSummitsCache(): void {
    this.summitsCache = null;
    this.configuredAssociations = null;
    // Don't await — IndexedDB cleanup can happen asynchronously
    idbDeleteKeysWithPrefix('summits:').catch(() => {});
  }

  /** Force-expire all in-memory caches. Useful on logout. */
  clearAll(): void {
    this.aprsCache    = null;
    this.alertsCache  = null;
    this.spotsCache   = null;
    this.summitsCache = null;
    this.configuredAssociations = null;
  }

  // ─── Background refresh observables ─────────────────────────────────────────

  /**
   * Components can subscribe to these to receive background-refresh results
   * when the service proactively updates stale data while returning cached data.
   */
  readonly onAprsRefresh$   = this.aprsRefresh$.asObservable();
  readonly onAlertsRefresh$ = this.alertsRefresh$.asObservable();
  readonly onSpotsRefresh$  = this.spotsRefresh$.asObservable();
}
