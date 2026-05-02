import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import * as L from 'leaflet';
import { forkJoin, interval, Subscription } from 'rxjs';
import { catchError, of } from 'rxjs';
import { ApiService, AprsPosition, SotaSpot } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { EventLogService } from '../../services/event-log.service';
import { environment } from '../../../environments/environment';
import { getCallsignFlag } from '../../shared/callsign-flag.util';

// ─── Summit point colors — exact SOTLAS color scheme ────────────────────────
// SOTA only assigns 1, 2, 4, 6, 8, 10 points (no odd increments 3/5/7/9).
// Source: sotlas-frontend/src/assets/swisstopo.json  summits_circles layer.

const SUMMIT_COLORS: Record<number, string> = {
  1:  '#4D7A20',   // dark olive green
  2:  '#6DA536',   // medium green
  4:  '#AEA727',   // yellow-green
  6:  '#EFA818',   // amber
  8:  '#DC5D04',   // dark orange
  10: '#C8101E',   // red
};

function summitColor(pts: number): string {
  // Round up to the nearest valid SOTA point value
  if (pts <= 1)  return SUMMIT_COLORS[1];
  if (pts <= 2)  return SUMMIT_COLORS[2];
  if (pts <= 4)  return SUMMIT_COLORS[4];
  if (pts <= 6)  return SUMMIT_COLORS[6];
  if (pts <= 8)  return SUMMIT_COLORS[8];
  return SUMMIT_COLORS[10];
}

// ─── Activator freshness ─────────────────────────────────────────────────────

interface Freshness {
  ageMin: number;
  color: string;
  opacity: number;
  label: string;
  pulse: boolean;
}

/**
 * Parse ISO-8601 timestamps safely.
 * Python stores DynamoDB timestamps with microseconds (6 decimal places, e.g.
 * "2026-05-01T19:35:49.412395+00:00") but the ECMAScript date parser only
 * guarantees 3 decimal places — extra digits may return NaN in some engines.
 * Truncate to milliseconds before parsing.
 */
function parseTimestamp(ts: string): Date {
  return new Date(ts.replace(/(\.\d{3})\d+/, '$1'));
}

function activatorFreshness(lastSeen: string): Freshness {
  const ageMs  = Date.now() - parseTimestamp(lastSeen).getTime();
  const ageMin = ageMs / 60_000;
  if (ageMin < 5)  return { ageMin, color: '#00e676', opacity: 1.0,  label: `${Math.round(ageMin)}m ago`, pulse: true  };
  if (ageMin < 15) return { ageMin, color: '#ffeb3b', opacity: 0.90, label: `${Math.round(ageMin)}m ago`, pulse: false };
  if (ageMin < 30) return { ageMin, color: '#ff9800', opacity: 0.75, label: `${Math.round(ageMin)}m ago`, pulse: false };
  const h = Math.floor(ageMin / 60);
  const m = Math.round(ageMin % 60);
  return { ageMin, color: '#9e9e9e', opacity: 0.55, label: h > 0 ? `${h}h ${m}m ago` : `${Math.round(ageMin)}m ago`, pulse: false };
}

// ─── Activator icon ──────────────────────────────────────────────────────────

function makeActivatorIcon(callsign: string, freshness: Freshness, hasActiveAlert: boolean): L.DivIcon {
  const pulse = freshness.pulse
    ? `<div class="walker-pulse" style="border-color:${freshness.color}"></div>`
    : '';
  const alertBadge = hasActiveAlert
    ? '<span class="walker-marker__alert-badge" title="Active alert">🔔</span>'
    : '';
  const callsignFlag = getCallsignFlag(callsign);
  return L.divIcon({
    className: '',
    html: `
      <div class="walker-marker" style="opacity:${freshness.opacity}">
        ${alertBadge}
        <div class="walker-marker__badge" style="border-color:${freshness.color};background:${freshness.color}33;box-shadow:0 0 8px ${freshness.color}66">
          ${pulse}
          <span class="walker-marker__emoji">🚶</span>
        </div>
        <span class="walker-marker__label" style="border-color:${freshness.color}66">${callsignFlag ? `${callsignFlag} ` : ''}${callsign}</span>
      </div>`,
    iconSize:    [52, 56],
    iconAnchor:  [26, 22],
    popupAnchor: [0, -28],
  });
}

// ─── Summit raw data (stored in memory, no marker reference) ─────────────────

interface SummitRecord {
  code:       string;
  name:       string;
  elevationM: number;
  assoc:      string;
  region:     string;
  points:     number;
  color:      string;
  radius:     number;
  lat:        number;
  lon:        number;
}

// ─── Activator state ─────────────────────────────────────────────────────────

interface ActivatorState {
  callsign:  string;
  positions: AprsPosition[];
  marker:    L.Marker;
  trace:     L.Polyline;
}

interface ActiveAlert {
  callsign: string;
  baseCallsign: string;
  summit: string;
  alertTimeMs: number | null;
}

interface SearchSuggestion {
  id: string;
  type: 'summit' | 'activator';
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
  zoom: number;
}

interface ProximityEntry {
  callsign: string;
  summitCode: string;
  summitName: string;
  summitLat: number;
  summitLon: number;
  distanceKm: number | null;
  progressPct: number | null;
  hasAprs: boolean;
  activatorLat: number | null;
  activatorLon: number | null;
  ageMin: number | null;
  alertTimeMs: number | null;
}

interface TacticalLineEntry {
  source: 'alert' | 'candidate' | 'spot';
  callsign: string;
  summitCode: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  ageMin: number;
}

interface RecentSpotLink {
  callsign: string;
  baseCallsign: string;
  summitCode: string;
  ageMin: number;
}

// ─── Viewport pan/zoom debounce ───────────────────────────────────────────────

/** How much to pad beyond the visible bounds when deciding which summits to render (fraction). */
const VIEWPORT_PAD = 0.5;

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector:    'app-map',
  standalone:  true,
  imports:     [CommonModule, FormsModule, LeafletModule],
  templateUrl: './map.component.html',
  styleUrl:    './map.component.scss',
})
export class MapComponent implements OnInit, OnDestroy {
  private api      = inject(ApiService);
  private ws       = inject(WebSocketService);
  private eventLog = inject(EventLogService);
  private route    = inject(ActivatedRoute);

  // Canvas renderer — all CircleMarkers share a single <canvas> element
  private canvasRenderer = L.canvas({ padding: VIEWPORT_PAD });
  // SVG renderer is used for animated glow rings (CSS animation targets SVG paths)
  private svgRenderer = L.svg({ padding: VIEWPORT_PAD });

  // Map internals
  private map!:           L.Map;
  private tileLayer!:     L.TileLayer;
  private glowLayer      = L.layerGroup();   // alert glow rings (behind summits)
  private summitLayer    = L.layerGroup();   // active CircleMarkers
  private activatorLayer = L.layerGroup();
  private tacticalLineLayer = L.layerGroup();
  private labelLayer     = L.layerGroup();   // zoom-dependent summit labels

  private activators     = new Map<string, ActivatorState>();
  private aprsByBaseCallsign = new Map<string, AprsPosition>();
  private activeAlerts: ActiveAlert[] = [];
  private activeAlertBaseCallsigns = new Set<string>();
  private recentSpotSummits = new Set<string>();
  private recentSpotLinks: RecentSpotLink[] = [];
  private summitByCode = new Map<string, SummitRecord>();
  private tacticalLines: TacticalLineEntry[] = [];

  /**
   * All summit data received from the API, held in memory.
   * CircleMarkers are created on demand when a summit enters the viewport.
   */
  private allSummits:      SummitRecord[]                    = [];
  private todayPlannedSummits = new Set<string>();

  /**
   * Index of currently rendered markers by summit code.
   * Each entry is [circleMarker, glowMarker|null].
   */
  private renderedMarkers  = new Map<string, [L.CircleMarker, L.CircleMarker | null]>();

  /** Debounce timer for viewport updates. */
  private viewportTimer?: ReturnType<typeof setTimeout>;

  // Subscriptions
  private refreshSub?: Subscription;
  private wsSub?:      Subscription;

  // Signals
  readonly loading            = signal(true);
  readonly summitCount        = signal(0);
  readonly activatorCount     = signal(0);
  readonly traceDurationHours = signal(2);
  readonly searchSuggestions  = signal<SearchSuggestion[]>([]);
  readonly alertedApproaching = signal<ProximityEntry[]>([]);
  readonly upcomingAlerts = signal<ProximityEntry[]>([]);
  readonly candidatesApproaching = signal<ProximityEntry[]>([]);
  readonly tacticalMode = signal(false);
  readonly tacticalSourceAlerts = signal(true);
  readonly tacticalSourceSpots = signal(true);
  readonly tacticalSourceCandidates = signal(true);

  searchQuery = '';

  readonly APPROACHING_DISTANCE_KM = 2;
  readonly MAP_ALERT_MAX_OVERDUE_MINUTES = 60;
  readonly RECENT_SPOT_WINDOW_MINUTES = 60;

  readonly LABEL_ZOOM = 12;

  mapOptions: L.MapOptions = {
    center:             [47.5, 11.0],
    zoom:               7,
    zoomControl:        true,
    attributionControl: true,
    preferCanvas:       true,   // use canvas for all vector layers
  };

  /** Query params set when navigating from the Alerts page */
  private pendingCenter?: { lat: number; lon: number; zoom: number; label?: string };

  ngOnInit(): void {
    const saved = localStorage.getItem('traceDurationHours');
    if (saved) this.traceDurationHours.set(Number(saved));

    // Read optional query params lat/lon/zoom/label set by AlertsComponent.jumpTo*
    this.route.queryParamMap.subscribe(params => {
      const lat  = parseFloat(params.get('lat') ?? '');
      const lon  = parseFloat(params.get('lon') ?? '');
      const zoom = parseInt(params.get('zoom') ?? '14', 10);
      const label = params.get('label') ?? undefined;
      if (!isNaN(lat) && !isNaN(lon)) {
        this.pendingCenter = { lat, lon, zoom, label };
        // If the map is already ready, apply immediately
        if (this.map) this.applyPendingCenter();
      }
    });
  }

  private applyPendingCenter(): void {
    if (!this.pendingCenter) return;
    const { lat, lon, zoom, label } = this.pendingCenter;
    this.pendingCenter = undefined;
    this.map.setView([lat, lon], zoom, { animate: true });
    if (label) {
      // Show a brief popup marker at the target location
      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="jump-marker"><span>${label}</span></div>`,
          iconSize: [80, 28],
          iconAnchor: [40, 28],
        }),
        zIndexOffset: 2000,
      }).addTo(this.map);
      setTimeout(() => this.map.removeLayer(marker), 5000);
    }
    this.eventLog.info('Map', `Jumped to ${label ?? `${lat},${lon}`}`);
  }

  private focusMap(lat: number, lon: number, zoom = 14, label?: string): void {
    if (!this.map) return;
    this.map.setView([lat, lon], zoom, { animate: true });
    if (label) {
      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="jump-marker"><span>${label}</span></div>`,
          iconSize: [80, 28],
          iconAnchor: [40, 28],
        }),
        zIndexOffset: 2000,
      }).addTo(this.map);
      setTimeout(() => this.map.removeLayer(marker), 5000);
    }
  }

  onMapReady(map: L.Map): void {
    this.map = map;
    // Apply any pending center from query params (may arrive before map is ready)
    if (this.pendingCenter) this.applyPendingCenter();
    // Layer order: glow behind summits, activators on top, labels always topmost
    this.glowLayer.addTo(map);
    this.summitLayer.addTo(map);
    this.tacticalLineLayer.addTo(map);
    this.activatorLayer.addTo(map);
    this.labelLayer.addTo(map);
    this.applyTiles();
    this.loadSummits();
    this.loadActivators();
    this.refreshSub = interval(60_000).subscribe(() => {
      this.loadActivators();
      this.refreshDynamicContext();
    });
    this.ws.connect();
    this.wsSub = this.ws.messages$.subscribe(msg =>
      this.eventLog.info('WebSocket', JSON.stringify(msg))
    );
    map.on('zoomend moveend', () => this.scheduleViewportUpdate());
    this.eventLog.info('Map', 'Map ready');
  }

  // ─── Tiles ───────────────────────────────────────────────────────────────

  private applyTiles(): void {
    if (this.tileLayer) this.tileLayer.remove();
    this.tileLayer = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains:  'abcd',
        maxZoom:     19,
      }
    );
    this.tileLayer.addTo(this.map);
  }

  // ─── Summits + alert glow ────────────────────────────────────────────────

  private loadSummits(): void {
    // Fetch alerts/spots (failures are tolerated — summits should still render)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts$ = this.api.getAlerts().pipe(catchError(() => of([] as any[])));
    const spots$ = this.api.getSpots().pipe(catchError(() => of([] as SotaSpot[])));

    // Fetch summit GeoJSON: use S3 static file if env is set, else Lambda API
    const summitsUrl = (environment as { summitsUrl?: string }).summitsUrl ?? '';

    const loadGeojson = (): Promise<GeoJSON.FeatureCollection> => {
      if (summitsUrl && !summitsUrl.startsWith('${')) {
        // S3 path — browser decompresses gzip automatically via Content-Encoding header
        return fetch(summitsUrl).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${summitsUrl}`);
          return r.json() as Promise<GeoJSON.FeatureCollection>;
        });
      }
      return new Promise((resolve, reject) => {
        this.api.getSummits().subscribe({ next: resolve, error: reject });
      });
    };

    forkJoin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alerts: alerts$ as any,
      spots: spots$,
    }).subscribe({
      next: ({ alerts, spots }) => {
        this.applyDynamicContextFromApi(alerts as Record<string, unknown>[], spots as SotaSpot[]);

        // Refresh activator icons so alert badges reflect latest alert set immediately.
        this.loadActivators();

        // Load summit GeoJSON (may come from S3 or Lambda)
        loadGeojson().then(geojson => {
          this.allSummits = [];
          geojson.features.forEach(f => {
            const props  = f.properties as Record<string, unknown>;
            const coords = (f.geometry as GeoJSON.Point).coordinates;

            // S3 uses compact keys (c=code, n=name, e=elevation, p=points, a=assoc, r=region)
            // Lambda API uses full keys (summitCode, peakName, elevationM, etc.)
            const code   = String(props['c'] ?? props['summitCode']      ?? '');
            const name   = String(props['n'] ?? props['peakName']        ?? '');
            const elev   = Number(props['e'] ?? props['elevationM']      ?? 0);
            const assoc  = String(props['a'] ?? props['associationName'] ?? '');
            const region = String(props['r'] ?? props['region']          ?? '');
            const points = Number(props['p'] ?? props['points']          ?? 1);

            this.allSummits.push({
              code, name, elevationM: elev, assoc, region, points,
              color:  summitColor(points),
              radius: 5,
              lat:    coords[1],
              lon:    coords[0],
            });
          });

          this.summitCount.set(this.allSummits.length);
          this.summitByCode.clear();
          this.allSummits.forEach(s => this.summitByCode.set(s.code, s));
          this.loading.set(false);
          this.eventLog.success('Summits', `Loaded ${this.allSummits.length} summits`);
          this.updateSearchSuggestions();
          this.recomputeProximityPanels();
          this.updateViewport();
        }).catch(err => {
          this.eventLog.error('Summits', `Failed: ${err.message}`);
          this.loading.set(false);
        });
      },
      error: () => {
        // Even if alerts fail, still load summits
        this.todayPlannedSummits.clear();
        this.activeAlerts = [];
        this.activeAlertBaseCallsigns.clear();
        this.recentSpotSummits.clear();
        loadGeojson().then(geojson => {
          this.allSummits = [];
          geojson.features.forEach(f => {
            const props  = f.properties as Record<string, unknown>;
            const coords = (f.geometry as GeoJSON.Point).coordinates;
            const code   = String(props['c'] ?? props['summitCode']      ?? '');
            const name   = String(props['n'] ?? props['peakName']        ?? '');
            const elev   = Number(props['e'] ?? props['elevationM']      ?? 0);
            const assoc  = String(props['a'] ?? props['associationName'] ?? '');
            const region = String(props['r'] ?? props['region']          ?? '');
            const points = Number(props['p'] ?? props['points']          ?? 1);
            this.allSummits.push({
              code, name, elevationM: elev, assoc, region, points,
              color:  summitColor(points),
              radius: 5,
              lat:    coords[1],
              lon:    coords[0],
            });
          });
          this.summitCount.set(this.allSummits.length);
          this.summitByCode.clear();
          this.allSummits.forEach(s => this.summitByCode.set(s.code, s));
          this.loading.set(false);
          this.eventLog.success('Summits', `Loaded ${this.allSummits.length} summits`);
          this.updateSearchSuggestions();
          this.recomputeProximityPanels();
          this.updateViewport();
        }).catch(err => {
          this.eventLog.error('Summits', `Failed: ${err.message}`);
          this.loading.set(false);
        });
      },
    });
  }

  private refreshDynamicContext(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts$ = this.api.getAlerts().pipe(catchError(() => of([] as any[])));
    const spots$ = this.api.getSpots().pipe(catchError(() => of([] as SotaSpot[])));

    forkJoin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alerts: alerts$ as any,
      spots: spots$,
    }).subscribe({
      next: ({ alerts, spots }) => {
        this.applyDynamicContextFromApi(alerts as Record<string, unknown>[], spots as SotaSpot[]);
        this.recomputeProximityPanels();
        this.updateViewport();
      },
      error: () => {
        this.eventLog.warn('Map', 'Dynamic alert/spot refresh failed');
      },
    });
  }

  private applyDynamicContextFromApi(alerts: Record<string, unknown>[], spots: SotaSpot[]): void {
    const now = Date.now();
    this.todayPlannedSummits.clear();
    this.activeAlerts = [];
    this.activeAlertBaseCallsigns.clear();
    this.recentSpotSummits.clear();
    this.recentSpotLinks = [];

    const todayUtc = new Date().toISOString().slice(0, 10);

    const alertDateKey = (alert: Record<string, unknown>): string | null => {
      const rawDate = String(alert['dateActivated'] ?? alert['date_activated'] ?? alert['activationDate'] ?? '');
      if (!rawDate) return null;
      const isoMatch = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];
      const ts = new Date(rawDate).getTime();
      if (Number.isNaN(ts)) return null;
      return new Date(ts).toISOString().slice(0, 10);
    };

    const isRelevantForMapWidgets = (alert: Record<string, unknown>): boolean => {
      const expiration = Number(alert['expiration']);
      if (!Number.isNaN(expiration) && expiration > 0 && expiration * 1000 <= now) {
        return false;
      }

      const rawDate = String(alert['dateActivated'] ?? alert['date_activated'] ?? alert['activationDate'] ?? '').trim();
      const alertTimeMs = this.parseAlertTimeMs(rawDate);
      if (alertTimeMs === null) return true; // keep visible when timestamp is missing/invalid
      return alertTimeMs >= now - this.MAP_ALERT_MAX_OVERDUE_MINUTES * 60_000;
    };

    alerts.forEach(a => {
      if (!isRelevantForMapWidgets(a)) return;
      const code = String(a['summit'] ?? a['summitCode'] ?? a['summitRef'] ?? '');
      const callsign = String(a['callsign'] ?? a['activatorCallsign'] ?? '');
      const alertTimeRaw = String(a['dateActivated'] ?? a['date_activated'] ?? a['activationDate'] ?? '').trim();
      const alertDate = alertDateKey(a);
      if (code && alertDate === todayUtc) this.todayPlannedSummits.add(code);
      if (callsign && code) {
        const active = {
          callsign,
          baseCallsign: this.normalizeCallsign(callsign),
          summit: code,
          alertTimeMs: this.parseAlertTimeMs(alertTimeRaw),
        };
        this.activeAlerts.push(active);
        this.activeAlertBaseCallsigns.add(active.baseCallsign);
      }
    });

    const recentCutoff = now - this.RECENT_SPOT_WINDOW_MINUTES * 60_000;
    spots.forEach(spot => {
      const summitRef = String(spot.summitRef ?? spot.summitCode ?? '').trim();
      if (!summitRef) return;
      const ts = this.parseSpotTime(spot);
      if (!ts || ts < recentCutoff) return;
      this.recentSpotSummits.add(summitRef);

      const callsign = String(spot.callsign ?? spot.activatorCallsign ?? '').trim();
      if (!callsign) return;
      this.recentSpotLinks.push({
        callsign,
        baseCallsign: this.normalizeCallsign(callsign),
        summitCode: summitRef,
        ageMin: (now - ts) / 60_000,
      });
    });
  }

  // ─── Viewport-based marker management ───────────────────────────────────

  /**
   * Debounce viewport updates so rapid pan/zoom events don't cause excessive DOM work.
   * Uses 80ms delay — smooth for continuous panning.
   */
  private scheduleViewportUpdate(): void {
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => this.updateViewport(), 80);
  }

  /**
   * Add markers for summits now inside the padded bounds,
   * remove markers for summits now outside it.
   * All CircleMarkers use the shared canvas renderer.
   */
  private updateViewport(): void {
    if (!this.map || this.allSummits.length === 0) return;

    const bounds = this.map.getBounds().pad(VIEWPORT_PAD);
    const zoom   = this.map.getZoom();
    const relevantCodes = this.computeRelevantSummitCodes();

    this.renderTacticalLines(bounds);
    this.applyActivatorVisibility();

    // --- Remove markers that have scrolled out of the padded bounds ---
    const toRemove: string[] = [];
    this.renderedMarkers.forEach(([m, glow], code) => {
      const outOfBounds = !bounds.contains(m.getLatLng());
      const hiddenInTactical = this.tacticalMode() && !relevantCodes.has(code);
      if (outOfBounds || hiddenInTactical) {
        this.summitLayer.removeLayer(m);
        if (glow) this.glowLayer.removeLayer(glow);
        toRemove.push(code);
      }
    });
    toRemove.forEach(code => this.renderedMarkers.delete(code));

    // --- Add markers for summits now in bounds that aren't rendered yet ---
    this.allSummits.forEach(s => {
      if (this.renderedMarkers.has(s.code)) return;
      if (!bounds.contains([s.lat, s.lon])) return;
      if (this.tacticalMode() && !relevantCodes.has(s.code)) return;

      const latlng: L.LatLngExpression = [s.lat, s.lon];

      const m = L.circleMarker(latlng, {
        renderer:    this.canvasRenderer,
        radius:      s.radius,
        fillColor:   s.color,
        color:       'rgba(255,255,255,0.45)',
        weight:      1.5,
        fillOpacity: 0.92,
        opacity:     1,
      });

      m.bindTooltip(
        `<b>${s.code}</b><br>${s.name}<br>` +
        `${s.elevationM} m · ${s.points} pt<br>` +
        `<small style="color:#999">${s.assoc}${s.region ? ' / ' + s.region : ''}</small>`,
        { direction: 'top', className: 'sota-tooltip' }
      );

      const sotlasUrl = `https://sotl.as/summits/${s.code}`;
      m.bindPopup(`
        <div class="sota-popup">
          <div class="sota-popup__title">${s.code}</div>
          <div class="sota-popup__subtitle">${s.name}</div>
          <div class="sota-popup__row"><span>Elevation</span><span>${s.elevationM} m</span></div>
          <div class="sota-popup__row"><span>Points</span><span>${s.points} pt</span></div>
          <div class="sota-popup__row"><span>Association</span><span>${s.assoc}</span></div>
          ${s.region ? `<div class="sota-popup__row"><span>Region</span><span>${s.region}</span></div>` : ''}
          <a href="${sotlasUrl}" target="_blank" rel="noopener" class="sota-popup__btn">View on SOTLAS ↗</a>
        </div>`, { className: 'sota-popup-wrap' });

      this.summitLayer.addLayer(m);

      // Glow ring for alerted summit
      let glow: L.CircleMarker | null = null;
      if (this.todayPlannedSummits.has(s.code)) {
        glow = L.circleMarker(latlng, {
          renderer:    this.svgRenderer,
          radius:      10,
          fillColor:   s.color,
          color:       s.color,
          weight:      3,
          fillOpacity: 0,
          opacity:     0.8,
          interactive: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          className:   'summit-glow' as any,
        });
        this.glowLayer.addLayer(glow);
      }

      this.renderedMarkers.set(s.code, [m, glow]);
    });

    // Update labels (only at high zoom)
    this.updateSummitLabels(bounds, zoom);
  }

  // ─── Summit labels at high zoom ──────────────────────────────────────────

  private updateSummitLabels(bounds: L.LatLngBounds, zoom: number): void {
    this.labelLayer.clearLayers();
    if (zoom < this.LABEL_ZOOM) return;

    // Tighter bound for labels (no padding — only show labels for what's on screen)
    const labelBounds = this.map.getBounds().pad(0.05);

    this.renderedMarkers.forEach(([m], code) => {
      const latlng = m.getLatLng();
      if (!labelBounds.contains(latlng)) return;

      const s = this.allSummits.find(x => x.code === code);
      if (!s) return;

      const label = L.marker(latlng, {
        icon: L.divIcon({
          className: 'summit-label',
          html:       `<div class="summit-label__inner"><span class="summit-label__code">${s.code}</span><span class="summit-label__name">${s.name}</span></div>`,
          iconSize:   [120, 30],
          iconAnchor: [60, -10],
        }),
        interactive:  false,
        zIndexOffset: -200,
      });
      this.labelLayer.addLayer(label);
    });
  }

  // ─── Activators ─────────────────────────────────────────────────────────

  private loadActivators(): void {
    this.api.getAprsPositions().subscribe({
      next: positions => {
        const cutoffMs = this.traceDurationHours() * 3_600_000;
        const now      = Date.now();

        // Remove activators no longer in the API response
        const liveCallsigns = new Set(positions.map(p => p.callsign));
        this.activators.forEach((st, cs) => {
          if (!liveCallsigns.has(cs)) {
            this.activatorLayer.removeLayer(st.marker);
            this.activatorLayer.removeLayer(st.trace);
            this.activators.delete(cs);
          }
        });

        this.aprsByBaseCallsign.clear();

        positions.forEach(pos => {
          const cs        = pos.callsign;
          const baseCs    = this.normalizeCallsign(cs);
          const freshness = activatorFreshness(pos.lastSeen);
          const hasActiveAlert = this.activeAlertBaseCallsigns.has(baseCs);
          const latlng: L.LatLngExpression = [
            parseFloat(pos.latitude),
            parseFloat(pos.longitude),
          ];

          // Build trace from embedded position history stored in DynamoDB
          type TrackPoint = { latitude: string; longitude: string; altitude: string; timestamp: string };
          const history = (pos.positions ?? []) as TrackPoint[];
          const tracePoints: L.LatLngExpression[] = history
            .filter(p => now - new Date(p.timestamp).getTime() <= cutoffMs)
            .map(p => [parseFloat(p.latitude), parseFloat(p.longitude)] as L.LatLngExpression);
          // Always add current position if not already in trace
          if (tracePoints.length === 0) {
            tracePoints.push(latlng);
          }

          const popup = this.buildActivatorPopup(cs, pos, freshness, history.length);

          this.aprsByBaseCallsign.set(baseCs, pos);

          if (this.activators.has(cs)) {
            const st = this.activators.get(cs)!;
            st.marker.setLatLng(latlng);
            st.marker.setIcon(makeActivatorIcon(cs, freshness, hasActiveAlert));
            st.marker.setPopupContent(popup);
            st.trace.setLatLngs(tracePoints);
            st.trace.setStyle({ color: freshness.color });
            st.positions = [pos];
          } else {
            const marker = L.marker(latlng, {
              icon:         makeActivatorIcon(cs, freshness, hasActiveAlert),
              zIndexOffset: 1000,
            });
            marker.bindPopup(popup, { className: 'sota-popup-wrap' });
            marker.bindTooltip(
              `<b>${this.callsignFlag(cs) ? `${this.callsignFlag(cs)} ` : ''}${cs}</b><br><small>${freshness.label}</small>`,
              { direction: 'top', className: 'sota-tooltip' }
            );

            const trace = L.polyline(tracePoints, {
              color:     freshness.color,
              weight:    3,
              opacity:   0.7,
              dashArray: '6 4',
            });

            // Click on the trace path → pan & zoom to the activator marker
            trace.on('click', () => {
              this.map.setView(latlng, Math.max(this.map.getZoom(), 13), { animate: true });
            });

            this.activatorLayer.addLayer(trace);
            this.activatorLayer.addLayer(marker);
            this.activators.set(cs, { callsign: cs, positions: [pos], marker, trace });
          }

          this.eventLog.info('APRS',
            `${cs} @ ${parseFloat(pos.latitude).toFixed(4)},${parseFloat(pos.longitude).toFixed(4)} (${freshness.label})`
          );
        });

        this.activatorCount.set(this.activators.size);
        this.updateSearchSuggestions();
        this.recomputeProximityPanels();
        this.eventLog.success('APRS', `Refreshed — ${this.activators.size} activators active`);
      },
      error: err => this.eventLog.error('APRS', `Failed: ${err.message}`),
    });
  }

  onSearchInput(): void {
    this.updateSearchSuggestions();
  }

  onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    const first = this.searchSuggestions()[0];
    if (!first) return;
    event.preventDefault();
    this.selectSuggestion(first);
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchSuggestions.set([]);
  }

  selectSuggestion(item: SearchSuggestion): void {
    this.searchQuery = item.title;
    this.searchSuggestions.set([]);
    this.focusMap(item.lat, item.lon, item.zoom, item.title);
  }

  distanceLabel(km: number): string {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  }

  focusProximity(entry: ProximityEntry): void {
    if (entry.hasAprs && entry.activatorLat !== null && entry.activatorLon !== null) {
      this.focusMap(entry.activatorLat, entry.activatorLon, 14);
      return;
    }
    this.focusMap(entry.summitLat, entry.summitLon, 14);
  }

  hasDistance(entry: ProximityEntry): boolean {
    return entry.distanceKm !== null;
  }

  upcomingAlertTimeUtc(entry: ProximityEntry): string {
    if (entry.alertTimeMs === null) return 'Unknown UTC';
    return new Date(entry.alertTimeMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  upcomingRemainingLabel(entry: ProximityEntry): string {
    if (entry.alertTimeMs === null) return 'Unknown time';
    const deltaMin = Math.round((entry.alertTimeMs - Date.now()) / 60_000);
    const absMin = Math.abs(deltaMin);
    const h = Math.floor(absMin / 60);
    const m = absMin % 60;
    const duration = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return deltaMin >= 0 ? `in ${duration}` : `overdue ${duration}`;
  }

  upcomingRemainingClass(entry: ProximityEntry): string {
    if (entry.alertTimeMs === null) return 'proximity-item__status--unknown';
    return entry.alertTimeMs >= Date.now()
      ? 'proximity-item__status--upcoming'
      : 'proximity-item__status--overdue';
  }

  progressWidth(entry: ProximityEntry): number {
    return entry.progressPct ?? 100;
  }

  toggleTacticalMode(): void {
    this.tacticalMode.update(v => !v);
    this.updateViewport();
  }

  toggleTacticalSource(source: 'alerts' | 'spots' | 'candidates'): void {
    if (source === 'alerts') this.tacticalSourceAlerts.update(v => !v);
    if (source === 'spots') this.tacticalSourceSpots.update(v => !v);
    if (source === 'candidates') this.tacticalSourceCandidates.update(v => !v);
    this.updateViewport();
  }

  autoFitTactical(): void {
    if (!this.map) return;
    const bounds = this.getTacticalBounds();
    if (!bounds) return;
    this.map.fitBounds(bounds.pad(0.15), { animate: true, maxZoom: 13 });
  }

  private updateSearchSuggestions(): void {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) {
      this.searchSuggestions.set([]);
      return;
    }

    const summitSuggestions: SearchSuggestion[] = this.allSummits
      .filter(s => s.code.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
      .slice(0, 6)
      .map(s => ({
        id: `summit:${s.code}`,
        type: 'summit' as const,
        title: s.code,
        subtitle: s.name,
        lat: s.lat,
        lon: s.lon,
        zoom: 13,
      }));

    const activatorSuggestions: SearchSuggestion[] = Array.from(this.aprsByBaseCallsign.entries())
      .filter(([base]) => base.toLowerCase().includes(query))
      .slice(0, 6)
      .map(([base, pos]) => ({
        id: `activator:${base}`,
        type: 'activator' as const,
        title: pos.callsign,
        subtitle: `Last seen ${activatorFreshness(pos.lastSeen).label}`,
        lat: parseFloat(pos.latitude),
        lon: parseFloat(pos.longitude),
        zoom: 14,
      }))
      .filter(s => !Number.isNaN(s.lat) && !Number.isNaN(s.lon));

    this.searchSuggestions.set([...summitSuggestions, ...activatorSuggestions].slice(0, 10));
  }

  private recomputeProximityPanels(): void {
    if (!this.allSummits.length) {
      this.alertedApproaching.set([]);
      this.upcomingAlerts.set([]);
      this.candidatesApproaching.set([]);
      this.tacticalLines = [];
      this.tacticalLineLayer.clearLayers();
      return;
    }

    const alertedEntries: ProximityEntry[] = [];
    const upcomingEntries: ProximityEntry[] = [];
    const seenKeys = new Set<string>();
    const now = Date.now();
    const spotTacticalLines: TacticalLineEntry[] = [];

    this.activeAlerts.forEach(alert => {
      const summit = this.summitByCode.get(alert.summit);
      if (!summit) return;

      const key = `${alert.baseCallsign}:${summit.code}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const aprs = this.aprsByBaseCallsign.get(alert.baseCallsign);
      if (!aprs) {
        upcomingEntries.push({
          callsign: alert.callsign,
          summitCode: summit.code,
          summitName: summit.name,
          summitLat: summit.lat,
          summitLon: summit.lon,
          distanceKm: null,
          progressPct: null,
          hasAprs: false,
          activatorLat: null,
          activatorLon: null,
          ageMin: null,
          alertTimeMs: alert.alertTimeMs,
        });
        return;
      }

      const activatorLat = parseFloat(aprs.latitude);
      const activatorLon = parseFloat(aprs.longitude);
      if (Number.isNaN(activatorLat) || Number.isNaN(activatorLon)) {
        upcomingEntries.push({
          callsign: aprs.callsign,
          summitCode: summit.code,
          summitName: summit.name,
          summitLat: summit.lat,
          summitLon: summit.lon,
          distanceKm: null,
          progressPct: null,
          hasAprs: false,
          activatorLat: null,
          activatorLon: null,
          ageMin: null,
          alertTimeMs: alert.alertTimeMs,
        });
        return;
      }

      const distanceKm = this.haversineKm(activatorLat, activatorLon, summit.lat, summit.lon);
      const ageMin = (now - parseTimestamp(aprs.lastSeen).getTime()) / 60_000;

      const upcomingEntry: ProximityEntry = {
        callsign: aprs.callsign,
        summitCode: summit.code,
        summitName: summit.name,
        summitLat: summit.lat,
        summitLon: summit.lon,
        distanceKm,
        progressPct: this.proximityPercent(distanceKm),
        hasAprs: true,
        activatorLat,
        activatorLon,
        ageMin,
        alertTimeMs: alert.alertTimeMs,
      };

      alertedEntries.push(upcomingEntry);
    });

    alertedEntries.sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));

    upcomingEntries.sort((a, b) => {
      if (a.alertTimeMs === null && b.alertTimeMs === null) return a.callsign.localeCompare(b.callsign);
      if (a.alertTimeMs === null) return 1;
      if (b.alertTimeMs === null) return -1;
      return a.alertTimeMs - b.alertTimeMs;
    });

    const alertedBases = new Set(this.activeAlerts.map(a => a.baseCallsign));
    const candidateEntries: ProximityEntry[] = [];
    const tacticalLines: TacticalLineEntry[] = [];

    alertedEntries.forEach(entry => {
      if (!entry.hasAprs || entry.activatorLat === null || entry.activatorLon === null || entry.ageMin === null) return;
      tacticalLines.push({
        source: 'alert',
        callsign: entry.callsign,
        summitCode: entry.summitCode,
        fromLat: entry.activatorLat,
        fromLon: entry.activatorLon,
        toLat: entry.summitLat,
        toLon: entry.summitLon,
        ageMin: entry.ageMin,
      });
    });

    this.aprsByBaseCallsign.forEach(aprs => {
      const base = this.normalizeCallsign(aprs.callsign);
      if (alertedBases.has(base)) return;

      const activatorLat = parseFloat(aprs.latitude);
      const activatorLon = parseFloat(aprs.longitude);
      if (Number.isNaN(activatorLat) || Number.isNaN(activatorLon)) return;

      let nearest: SummitRecord | undefined;
      let nearestKm = Number.POSITIVE_INFINITY;

      for (const summit of this.allSummits) {
        const km = this.haversineKm(activatorLat, activatorLon, summit.lat, summit.lon);
        if (km < nearestKm) {
          nearestKm = km;
          nearest = summit;
        }
      }

      if (!nearest || nearestKm >= this.APPROACHING_DISTANCE_KM) return;

      const ageMin = (now - parseTimestamp(aprs.lastSeen).getTime()) / 60_000;
      const entry: ProximityEntry = {
        callsign: aprs.callsign,
        summitCode: nearest.code,
        summitName: nearest.name,
        summitLat: nearest.lat,
        summitLon: nearest.lon,
        distanceKm: nearestKm,
        progressPct: this.proximityPercent(nearestKm),
        hasAprs: true,
        activatorLat,
        activatorLon,
        ageMin,
        alertTimeMs: null,
      };
      candidateEntries.push(entry);
      tacticalLines.push({
        source: 'candidate',
        callsign: entry.callsign,
        summitCode: entry.summitCode,
        fromLat: activatorLat,
        fromLon: activatorLon,
        toLat: nearest.lat,
        toLon: nearest.lon,
        ageMin,
      });
    });

    this.recentSpotLinks.forEach(link => {
      const summit = this.summitByCode.get(link.summitCode);
      if (!summit) return;
      const aprs = this.aprsByBaseCallsign.get(link.baseCallsign);
      if (!aprs) return;
      const fromLat = parseFloat(aprs.latitude);
      const fromLon = parseFloat(aprs.longitude);
      if (Number.isNaN(fromLat) || Number.isNaN(fromLon)) return;
      spotTacticalLines.push({
        source: 'spot',
        callsign: aprs.callsign,
        summitCode: summit.code,
        fromLat,
        fromLon,
        toLat: summit.lat,
        toLon: summit.lon,
        ageMin: Math.min(link.ageMin, (now - parseTimestamp(aprs.lastSeen).getTime()) / 60_000),
      });
    });

    candidateEntries.sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
    this.alertedApproaching.set(alertedEntries);
    this.upcomingAlerts.set(upcomingEntries);
    this.candidatesApproaching.set(candidateEntries);
    this.tacticalLines = [...tacticalLines, ...spotTacticalLines];
    this.renderTacticalLines(this.map.getBounds().pad(VIEWPORT_PAD));
    this.applyActivatorVisibility();
  }

  private proximityPercent(distanceKm: number): number {
    const ratio = 1 - distanceKm / this.APPROACHING_DISTANCE_KM;
    return Math.max(0, Math.min(100, ratio * 100));
  }

  private parseSpotTime(spot: SotaSpot): number | null {
    const raw = String(spot.time ?? spot.timeStamp ?? '').trim();
    if (!raw) return null;
    const ts = new Date(raw).getTime();
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(raw);
    if (Number.isNaN(numeric)) return null;
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  private parseAlertTimeMs(raw: string): number | null {
    if (!raw) return null;
    const cleaned = raw.replace(/(\.\d{3})\d+/, '$1').replace('Z', '+00:00');
    const ts = new Date(cleaned).getTime();
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(raw);
    if (Number.isNaN(numeric)) return null;
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  private isTacticalSourceEnabled(source: 'alert' | 'candidate' | 'spot'): boolean {
    if (source === 'alert') return this.tacticalSourceAlerts();
    if (source === 'candidate') return this.tacticalSourceCandidates();
    return this.tacticalSourceSpots();
  }

  private computeRelevantSummitCodes(): Set<string> {
    if (!this.tacticalMode()) {
      return new Set(this.allSummits.map(s => s.code));
    }

    const relevant = new Set<string>();

    if (this.tacticalSourceAlerts()) {
      this.activeAlerts.forEach(a => relevant.add(a.summit));
    }
    if (this.tacticalSourceSpots()) {
      this.recentSpotSummits.forEach(code => relevant.add(code));
    }
    if (this.tacticalSourceCandidates()) {
      this.candidatesApproaching().forEach(entry => relevant.add(entry.summitCode));
    }

    return relevant;
  }

  private renderTacticalLines(bounds: L.LatLngBounds): void {
    this.tacticalLineLayer.clearLayers();
    if (!this.tacticalMode()) return;

    this.tacticalLines.forEach(line => {
      if (!this.isTacticalSourceEnabled(line.source)) return;
      const from = L.latLng(line.fromLat, line.fromLon);
      const to = L.latLng(line.toLat, line.toLon);
      if (!bounds.contains(from) && !bounds.contains(to)) return;

      const opacity = this.lineOpacityForAge(line.ageMin);
      const path = L.polyline([from, to], {
        color: this.lineColor(line.source),
        weight: 2.2,
        opacity,
        dashArray: this.lineDash(line.source),
      });
      path.bindTooltip(`${line.callsign} ↔ ${line.summitCode}`, {
        direction: 'top',
        className: 'sota-tooltip',
      });
      this.tacticalLineLayer.addLayer(path);
    });
  }

  private applyActivatorVisibility(): void {
    if (!this.tacticalMode()) {
      this.activators.forEach(st => {
        if (!this.activatorLayer.hasLayer(st.trace)) this.activatorLayer.addLayer(st.trace);
        if (!this.activatorLayer.hasLayer(st.marker)) this.activatorLayer.addLayer(st.marker);
      });
      return;
    }

    const relevantCallsigns = new Set<string>();
    this.tacticalLines.forEach(line => {
      if (!this.isTacticalSourceEnabled(line.source)) return;
      relevantCallsigns.add(line.callsign);
    });

    this.activators.forEach(st => {
      const visible = relevantCallsigns.has(st.callsign);
      if (visible) {
        if (!this.activatorLayer.hasLayer(st.trace)) this.activatorLayer.addLayer(st.trace);
        if (!this.activatorLayer.hasLayer(st.marker)) this.activatorLayer.addLayer(st.marker);
      } else {
        if (this.activatorLayer.hasLayer(st.trace)) this.activatorLayer.removeLayer(st.trace);
        if (this.activatorLayer.hasLayer(st.marker)) this.activatorLayer.removeLayer(st.marker);
      }
    });
  }

  private lineColor(source: 'alert' | 'candidate' | 'spot'): string {
    if (source === 'alert') return '#ff9800';
    if (source === 'candidate') return '#38bdf8';
    return '#c084fc';
  }

  private lineDash(source: 'alert' | 'candidate' | 'spot'): string | undefined {
    if (source === 'alert') return undefined;
    if (source === 'candidate') return '6 5';
    return '2 6';
  }

  private lineOpacityForAge(ageMin: number): number {
    if (ageMin <= 5) return 0.95;
    if (ageMin <= 15) return 0.82;
    if (ageMin <= 30) return 0.68;
    if (ageMin <= 60) return 0.52;
    return 0.35;
  }

  private getTacticalBounds(): L.LatLngBounds | null {
    if (!this.tacticalMode()) return null;
    const relevant = this.computeRelevantSummitCodes();
    const points: L.LatLng[] = [];

    this.allSummits.forEach(s => {
      if (relevant.has(s.code)) points.push(L.latLng(s.lat, s.lon));
    });

    this.tacticalLines.forEach(line => {
      if (!this.isTacticalSourceEnabled(line.source)) return;
      points.push(L.latLng(line.fromLat, line.fromLon));
      points.push(L.latLng(line.toLat, line.toLon));
    });

    if (!points.length) return null;
    return L.latLngBounds(points);
  }

  private normalizeCallsign(callsign: string): string {
    return callsign.toUpperCase().replace(/-\d+$/, '');
  }

  callsignFlag(callsign: string): string {
    return getCallsignFlag(callsign);
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private buildActivatorPopup(
    cs:           string,
    pos:          AprsPosition,
    freshness:    Freshness,
    historyCount: number,
  ): string {
    const lat      = parseFloat(pos.latitude).toFixed(5);
    const lon      = parseFloat(pos.longitude).toFixed(5);
    const alt      = pos.altitude ? `${parseFloat(pos.altitude).toFixed(0)} m` : 'N/A';
    const t        = new Date(pos.lastSeen).toLocaleString();
    const basecs   = cs.replace(/-\d+$/, '');   // strip SSID for SOTLAS URL
    const sotlasUrl = `https://sotl.as/activators/${basecs}`;
    const flag = this.callsignFlag(cs);
    return `
      <div class="sota-popup">
        <div class="sota-popup__title">📻 ${flag ? `${flag} ` : ''}${cs}</div>
        <div class="sota-popup__row"><span>Last seen</span><span>${freshness.label}</span></div>
        <div class="sota-popup__row"><span>Time</span><span>${t}</span></div>
        <div class="sota-popup__row"><span>Latitude</span><span>${lat}°</span></div>
        <div class="sota-popup__row"><span>Longitude</span><span>${lon}°</span></div>
        <div class="sota-popup__row"><span>Altitude</span><span>${alt}</span></div>
        <div class="sota-popup__row"><span>Track points</span><span>${historyCount}</span></div>
        <a href="${sotlasUrl}" target="_blank" rel="noopener" class="sota-popup__btn">View on SOTLAS ↗</a>
      </div>`;
  }

  onTraceDurationChange(): void {
    localStorage.setItem('traceDurationHours', String(this.traceDurationHours()));
    this.loadActivators();
    this.eventLog.info('Config', `Trace window → ${this.traceDurationHours()} h`);
  }

  ngOnDestroy(): void {
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    this.refreshSub?.unsubscribe();
    this.wsSub?.unsubscribe();
    this.ws.disconnect();
  }
}
