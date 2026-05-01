import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import * as L from 'leaflet';
import { forkJoin, interval, Subscription } from 'rxjs';
import { catchError, of } from 'rxjs';
import { ApiService, AprsPosition } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { EventLogService } from '../../services/event-log.service';

// ─── Summit point colors — SOTLAS color scheme ───────────────────────────────

const SUMMIT_COLORS: Record<number, string> = {
  1:  '#4CAF50',   // green
  2:  '#8BC34A',   // light green
  3:  '#CDDC39',   // lime
  4:  '#FFEB3B',   // yellow
  5:  '#FFC107',   // amber
  6:  '#FF9800',   // orange
  7:  '#FF5722',   // deep orange
  8:  '#F44336',   // red
  9:  '#E91E63',   // pink
  10: '#9C27B0',   // purple
};

function summitColor(pts: number): string {
  return SUMMIT_COLORS[Math.max(1, Math.min(10, pts))] ?? '#aaa';
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

// ─── Summit label data ───────────────────────────────────────────────────────

interface SummitLabelData {
  marker: L.CircleMarker;
  latlng: L.LatLngExpression;
  code: string;
  name: string;
  elevationM: number;
  points: number;
}

// ─── Activator state ─────────────────────────────────────────────────────────

interface ActivatorState {
  callsign:  string;
  positions: AprsPosition[];
  marker:    L.Marker;
  trace:     L.Polyline;
}

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

  // Map internals
  private map!:           L.Map;
  private tileLayer!:     L.TileLayer;
  private glowLayer     = L.layerGroup();   // alert glow rings (behind summits)
  private summitLayer   = L.layerGroup();
  private activatorLayer = L.layerGroup();
  private labelLayer    = L.layerGroup();   // zoom-dependent summit labels

  private activators     = new Map<string, ActivatorState>();
  private summitData:    SummitLabelData[] = [];
  private alertedSummits = new Set<string>();

  // Subscriptions
  private refreshSub?: Subscription;
  private wsSub?:      Subscription;

  // Signals
  readonly loading            = signal(true);
  readonly summitCount        = signal(0);
  readonly activatorCount     = signal(0);
  readonly traceDurationHours = signal(2);

  readonly LABEL_ZOOM = 12;

  mapOptions: L.MapOptions = {
    center:             [47.5, 11.0],
    zoom:               7,
    zoomControl:        true,
    attributionControl: true,
  };

  ngOnInit(): void {
    const saved = localStorage.getItem('traceDurationHours');
    if (saved) this.traceDurationHours.set(Number(saved));
  }

  onMapReady(map: L.Map): void {
    this.map = map;
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
    map.on('zoomend moveend', () => this.updateSummitLabels());
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
    // Load summits and alerts in parallel; alerts failure is non-fatal
    forkJoin({
      geojson: this.api.getSummits(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alerts:  this.api.getAlerts().pipe(catchError(() => of([] as any[]))),
    }).subscribe({
      next: ({ geojson, alerts }) => {
        // Build the set of summit codes that have upcomingactivations (today → +7 days)
        const now      = Date.now();
        const sevenDays = 7 * 24 * 3_600_000;
        this.alertedSummits.clear();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (alerts as any[]).forEach(a => {
          const rawDate = a.dateActivated ?? a.date_activated ?? a.activationDate ?? '';
          const ts = rawDate ? new Date(rawDate).getTime() : NaN;
          if (!isNaN(ts) && ts >= now - 3_600_000 && ts <= now + sevenDays) {
            const code = String(a.summit ?? a.summitCode ?? '');
            if (code) this.alertedSummits.add(code);
          }
        });

        this.summitLayer.clearLayers();
        this.glowLayer.clearLayers();
        this.summitData = [];
        let count = 0;

        geojson.features.forEach(f => {
          const props  = f.properties as Record<string, unknown>;
          const coords = (f.geometry as GeoJSON.Point).coordinates;

          const code       = String(props['summitCode']      ?? '');
          const name       = String(props['peakName']        ?? '');
          const elevationM = Number(props['elevationM']      ?? 0);
          const assoc      = String(props['associationName'] ?? '');
          const region     = String(props['region']          ?? '');
          const points     = Number(props['points']          ?? 1);
          const color      = summitColor(points);
          const latlng: L.LatLngExpression = [coords[1], coords[0]];

          // Circle scaled by points: 1pt=5px, 10pt=8px
          const radius = Math.round(5 + (points - 1) * 0.33);
          const m = L.circleMarker(latlng, {
            radius,
            fillColor:   color,
            color:       'rgba(255,255,255,0.45)',
            weight:      1.5,
            fillOpacity: 0.92,
            opacity:     1,
          });

          m.bindTooltip(
            `<b>${code}</b><br>${name}<br>` +
            `${elevationM} m · ${points} pt<br>` +
            `<small style="color:#999">${assoc}${region ? ' / ' + region : ''}</small>`,
            { direction: 'top', className: 'sota-tooltip' }
          );

          const sotlasUrl = `https://sotl.as/summits/${code}`;
          m.bindPopup(`
            <div class="sota-popup">
              <div class="sota-popup__title">${code}</div>
              <div class="sota-popup__subtitle">${name}</div>
              <div class="sota-popup__row"><span>Elevation</span><span>${elevationM} m</span></div>
              <div class="sota-popup__row"><span>Points</span><span>${points} pt</span></div>
              <div class="sota-popup__row"><span>Association</span><span>${assoc}</span></div>
              ${region ? `<div class="sota-popup__row"><span>Region</span><span>${region}</span></div>` : ''}
              <a href="${sotlasUrl}" target="_blank" rel="noopener" class="sota-popup__btn">View on SOTLAS ↗</a>
            </div>`, { className: 'sota-popup-wrap' });

          this.summitLayer.addLayer(m);
          this.summitData.push({ marker: m, latlng, code, name, elevationM, points });
          count++;

          // Glow ring behind summit marker when an activation is planned
          if (this.alertedSummits.has(code)) {
            L.circleMarker(latlng, {
              radius:      10,
              fillColor:   color,
              color:       color,
              weight:      3,
              fillOpacity: 0,
              opacity:     0.8,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              className:   'summit-glow' as any,
            }).addTo(this.glowLayer);
          }
        });

        this.summitCount.set(count);
        this.loading.set(false);
        this.eventLog.success('Summits', `Loaded ${count} summits`);
        this.updateSummitLabels();
      },
      error: err => {
        this.eventLog.error('Summits', `Failed: ${err.message}`);
        this.loading.set(false);
      },
    });
  }

  // ─── Summit labels at high zoom ──────────────────────────────────────────

  private updateSummitLabels(): void {
    this.labelLayer.clearLayers();
    if (!this.map || this.map.getZoom() < this.LABEL_ZOOM) return;

    const bounds = this.map.getBounds().pad(0.05);
    this.summitData
      .filter(d => bounds.contains(d.marker.getLatLng()))
      .forEach(d => {
        const label = L.marker(d.latlng, {
          icon: L.divIcon({
            className: 'summit-label',
            // Single block, no <br>, centered text below the marker
            html:       `<div class="summit-label__inner"><span class="summit-label__code">${d.code}</span><span class="summit-label__name">${d.name}</span></div>`,
            iconSize:   [120, 30],
            iconAnchor: [60, -10],  // horizontally centered, positioned below marker
          }),
          interactive: false,
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

        positions.forEach(pos => {
          const cs        = pos.callsign;
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

            this.activatorLayer.addLayer(trace);
            this.activatorLayer.addLayer(marker);
            this.activators.set(cs, { callsign: cs, positions: [pos], marker, trace });
          }

          this.eventLog.info('APRS',
            `${cs} @ ${parseFloat(pos.latitude).toFixed(4)},${parseFloat(pos.longitude).toFixed(4)} (${freshness.label})`
          );
        });

        this.activatorCount.set(this.activators.size);
        this.eventLog.success('APRS', `Refreshed — ${this.activators.size} activators active`);
      },
      error: err => this.eventLog.error('APRS', `Failed: ${err.message}`),
    });
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
    this.refreshSub?.unsubscribe();
    this.wsSub?.unsubscribe();
    this.ws.disconnect();
  }
}
