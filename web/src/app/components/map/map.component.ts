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
import { ApiService, AprsPosition } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { EventLogService } from '../../services/event-log.service';
import { environment } from '../../../environments/environment';

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

function makeActivatorIcon(callsign: string, freshness: Freshness): L.DivIcon {
  const pulse = freshness.pulse
    ? `<div class="walker-pulse" style="border-color:${freshness.color}"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `
      <div class="walker-marker" style="opacity:${freshness.opacity}">
        <div class="walker-marker__badge" style="border-color:${freshness.color};background:${freshness.color}33;box-shadow:0 0 8px ${freshness.color}66">
          ${pulse}
          <span class="walker-marker__emoji">🚶</span>
        </div>
        <span class="walker-marker__label" style="border-color:${freshness.color}66">${callsign}</span>
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
  distanceKm: number;
  progressPct: number;
  activatorLat: number;
  activatorLon: number;
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

  // Map internals
  private map!:           L.Map;
  private tileLayer!:     L.TileLayer;
  private glowLayer      = L.layerGroup();   // alert glow rings (behind summits)
  private summitLayer    = L.layerGroup();   // active CircleMarkers
  private activatorLayer = L.layerGroup();
  private labelLayer     = L.layerGroup();   // zoom-dependent summit labels

  private activators     = new Map<string, ActivatorState>();
  private aprsByBaseCallsign = new Map<string, AprsPosition>();
  private activeAlerts: ActiveAlert[] = [];
  private summitByCode = new Map<string, SummitRecord>();

  /**
   * All summit data received from the API, held in memory.
   * CircleMarkers are created on demand when a summit enters the viewport.
   */
  private allSummits:      SummitRecord[]                    = [];
  private alertedSummits   = new Set<string>();

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
  readonly candidatesApproaching = signal<ProximityEntry[]>([]);

  searchQuery = '';

  readonly APPROACHING_DISTANCE_KM = 2;

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
    this.activatorLayer.addTo(map);
    this.labelLayer.addTo(map);
    this.applyTiles();
    this.loadSummits();
    this.loadActivators();
    this.refreshSub = interval(60_000).subscribe(() => this.loadActivators());
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
    // Fetch alerts (failures are tolerated — alerts are optional glow rings)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts$ = this.api.getAlerts().pipe(catchError(() => of([] as any[])));

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
    }).subscribe({
      next: ({ alerts }) => {
        // Build the set of currently active alerts
        const now       = Date.now();
        this.alertedSummits.clear();
        this.activeAlerts = [];

        const isActiveAlert = (alert: Record<string, unknown>): boolean => {
          const expiration = Number(alert['expiration']);
          if (!Number.isNaN(expiration) && expiration > 0) {
            // DynamoDB TTL values are in seconds
            return expiration * 1000 > now;
          }

          const rawDate = String(alert['dateActivated'] ?? alert['date_activated'] ?? alert['activationDate'] ?? '');
          if (!rawDate) return true;
          const ts = new Date(rawDate).getTime();
          if (Number.isNaN(ts)) return true;
          // Keep a small grace period for slightly delayed data
          return ts >= now - 6 * 3_600_000;
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (alerts as any[]).forEach(a => {
          if (!isActiveAlert(a as Record<string, unknown>)) return;
          const code = String(a.summit ?? a.summitCode ?? '');
          const callsign = String(a.callsign ?? a.activatorCallsign ?? '');
          if (code) this.alertedSummits.add(code);
          if (callsign && code) {
            this.activeAlerts.push({
              callsign,
              baseCallsign: this.normalizeCallsign(callsign),
              summit: code,
            });
          }
        });

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
              radius: Math.round(5 + (points - 1) * 0.33),   // 1pt=5px, 10pt=8px
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
        this.activeAlerts = [];
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
              radius: Math.round(5 + (points - 1) * 0.33),
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

    // --- Remove markers that have scrolled out of the padded bounds ---
    const toRemove: string[] = [];
    this.renderedMarkers.forEach(([m, glow], code) => {
      if (!bounds.contains(m.getLatLng())) {
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
      if (this.alertedSummits.has(s.code)) {
        glow = L.circleMarker(latlng, {
          renderer:    this.canvasRenderer,
          radius:      10,
          fillColor:   s.color,
          color:       s.color,
          weight:      3,
          fillOpacity: 0,
          opacity:     0.8,
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
            st.marker.setIcon(makeActivatorIcon(cs, freshness));
            st.marker.setPopupContent(popup);
            st.trace.setLatLngs(tracePoints);
            st.trace.setStyle({ color: freshness.color });
            st.positions = [pos];
          } else {
            const marker = L.marker(latlng, {
              icon:         makeActivatorIcon(cs, freshness),
              zIndexOffset: 1000,
            });
            marker.bindPopup(popup, { className: 'sota-popup-wrap' });
            marker.bindTooltip(
              `<b>${cs}</b><br><small>${freshness.label}</small>`,
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
    this.focusMap(entry.activatorLat, entry.activatorLon, 14, `${entry.callsign} → ${entry.summitCode}`);
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
      this.candidatesApproaching.set([]);
      return;
    }

    const alertedEntries: ProximityEntry[] = [];
    const seenKeys = new Set<string>();

    this.activeAlerts.forEach(alert => {
      const summit = this.summitByCode.get(alert.summit);
      const aprs = this.aprsByBaseCallsign.get(alert.baseCallsign);
      if (!summit || !aprs) return;

      const activatorLat = parseFloat(aprs.latitude);
      const activatorLon = parseFloat(aprs.longitude);
      if (Number.isNaN(activatorLat) || Number.isNaN(activatorLon)) return;

      const distanceKm = this.haversineKm(activatorLat, activatorLon, summit.lat, summit.lon);
      if (distanceKm >= this.APPROACHING_DISTANCE_KM) return;

      const key = `${alert.baseCallsign}:${summit.code}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      alertedEntries.push({
        callsign: aprs.callsign,
        summitCode: summit.code,
        summitName: summit.name,
        distanceKm,
        progressPct: this.proximityPercent(distanceKm),
        activatorLat,
        activatorLon,
      });
    });

    alertedEntries.sort((a, b) => a.distanceKm - b.distanceKm);

    const alertedBases = new Set(this.activeAlerts.map(a => a.baseCallsign));
    const candidateEntries: ProximityEntry[] = [];

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

      candidateEntries.push({
        callsign: aprs.callsign,
        summitCode: nearest.code,
        summitName: nearest.name,
        distanceKm: nearestKm,
        progressPct: this.proximityPercent(nearestKm),
        activatorLat,
        activatorLon,
      });
    });

    candidateEntries.sort((a, b) => a.distanceKm - b.distanceKm);
    this.alertedApproaching.set(alertedEntries);
    this.candidatesApproaching.set(candidateEntries);
  }

  private proximityPercent(distanceKm: number): number {
    const ratio = 1 - distanceKm / this.APPROACHING_DISTANCE_KM;
    return Math.max(0, Math.min(100, ratio * 100));
  }

  private normalizeCallsign(callsign: string): string {
    return callsign.toUpperCase().replace(/-\d+$/, '');
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
    return `
      <div class="sota-popup">
        <div class="sota-popup__title">📻 ${cs}</div>
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
