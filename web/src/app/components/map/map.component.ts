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
import { interval, Subscription } from 'rxjs';
import { ApiService, AprsPosition } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { EventLogService } from '../../services/event-log.service';

// ─── Summit point colors (1-10, green → red) ─────────────────────────────────

const SUMMIT_COLORS: Record<number, string> = {
  1:  '#00c853',
  2:  '#64dd17',
  3:  '#aeea00',
  4:  '#ffd600',
  5:  '#ffab00',
  6:  '#ff6d00',
  7:  '#dd2c00',
  8:  '#c62828',
  9:  '#b71c1c',
  10: '#880e4f',
};

function summitColor(points: number): string {
  const c = SUMMIT_COLORS[Math.max(1, Math.min(10, points))];
  return c ?? '#aaa';
}

// ─── Walker freshness ────────────────────────────────────────────────────────

interface Freshness {
  ageMin: number;
  color: string;
  opacity: number;
  label: string;
  pulse: boolean;
}

function walkerFreshness(lastSeen: string): Freshness {
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  const ageMin = ageMs / 60_000;
  if (ageMin < 5)  return { ageMin, color: '#00e676', opacity: 1.0,  label: `${Math.round(ageMin)}m ago`,  pulse: true };
  if (ageMin < 15) return { ageMin, color: '#ffeb3b', opacity: 0.85, label: `${Math.round(ageMin)}m ago`,  pulse: false };
  if (ageMin < 30) return { ageMin, color: '#ff9800', opacity: 0.65, label: `${Math.round(ageMin)}m ago`,  pulse: false };
  const h = Math.floor(ageMin / 60);
  const m = Math.round(ageMin % 60);
  return { ageMin, color: '#9e9e9e', opacity: 0.40, label: h > 0 ? `${h}h ${m}m ago` : `${Math.round(ageMin)}m ago`, pulse: false };
}

// ─── Walker dot icon (no emoji — clean colored dot + callsign label) ──────────

function makeWalkerIcon(callsign: string, freshness: Freshness): L.DivIcon {
  const pulse = freshness.pulse
    ? `<div class="walker-pulse" style="border-color:${freshness.color}"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `
      <div class="walker-marker" style="opacity:${freshness.opacity}">
        ${pulse}
        <div class="walker-marker__dot" style="background:${freshness.color}"></div>
        <span class="walker-marker__label">${callsign}</span>
      </div>`,
    iconSize:    [36, 36],
    iconAnchor:  [18, 18],
    popupAnchor: [0, -20],
  });
}

// ─── Walker state ─────────────────────────────────────────────────────────────

interface WalkerState {
  callsign: string;
  positions: AprsPosition[];
  marker: L.Marker;
  trace:  L.Polyline;
}

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, FormsModule, LeafletModule],
  templateUrl: './map.component.html',
  styleUrl:    './map.component.scss',
})
export class MapComponent implements OnInit, OnDestroy {
  private api        = inject(ApiService);
  private ws         = inject(WebSocketService);
  private eventLog   = inject(EventLogService);

  // Map internals
  private map!: L.Map;
  private tileLayer!: L.TileLayer;
  private summitLayer = L.layerGroup();
  private walkerLayer = L.layerGroup();
  private walkers = new Map<string, WalkerState>();

  // Subscriptions
  private refreshSub?: Subscription;
  private wsSub?: Subscription;

  // Signals
  readonly loading      = signal(true);
  readonly summitCount  = signal(0);
  readonly walkerCount  = signal(0);
  readonly traceDurationHours = signal(2);

  mapOptions: L.MapOptions = {
    center:           [47.5, 11.0],
    zoom:             7,
    zoomControl:      true,
    attributionControl: true,
  };

  ngOnInit(): void {
    const saved = localStorage.getItem('traceDurationHours');
    if (saved) this.traceDurationHours.set(Number(saved));
  }

  onMapReady(map: L.Map): void {
    this.map = map;
    this.summitLayer.addTo(map);
    this.walkerLayer.addTo(map);
    this.applyTiles();
    this.loadSummits();
    this.loadWalkers();
    this.refreshSub = interval(60_000).subscribe(() => this.loadWalkers());
    this.ws.connect();
    this.wsSub = this.ws.messages$.subscribe(msg =>
      this.eventLog.info('WebSocket', JSON.stringify(msg))
    );
    this.eventLog.info('Map', 'Map ready');
  }

  private applyTiles(): void {
    if (this.tileLayer) this.tileLayer.remove();
    this.tileLayer = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }
    );
    this.tileLayer.addTo(this.map);
  }

  private loadSummits(): void {
    this.api.getSummits().subscribe({
      next: geojson => {
        this.summitLayer.clearLayers();
        let count = 0;
        geojson.features.forEach(f => {
          const props  = f.properties as Record<string, unknown>;
          const coords = (f.geometry as GeoJSON.Point).coordinates;
          const points = Number(props['points'] ?? 1);
          const color  = summitColor(points);
          const name   = String(props['name']     ?? '');
          const code   = String(props['code']     ?? '');
          const alt    = String(props['altitude'] ?? '');

          const m = L.circleMarker([coords[1], coords[0]], {
            radius:      5 + Math.min(points, 10) * 0.45,
            fillColor:   color,
            color:       'rgba(255,255,255,0.25)',
            weight:      1,
            fillOpacity: 0.9,
            opacity:     1,
          });

          m.bindTooltip(
            `<b>${code}</b><br>${name}<br>${alt} m · ${points} pt`,
            { direction: 'top', className: 'sota-tooltip' }
          );
          m.bindPopup(`
            <div class="sota-popup">
              <div class="sota-popup__title">${code}</div>
              <div class="sota-popup__subtitle">${name}</div>
              <div class="sota-popup__row"><span>Altitude</span><span>${alt} m</span></div>
              <div class="sota-popup__row"><span>Points</span><span>${points} pt</span></div>
            </div>`, { className: 'sota-popup-wrap' });

          this.summitLayer.addLayer(m);
          count++;
        });
        this.summitCount.set(count);
        this.loading.set(false);
        this.eventLog.success('Summits', `Loaded ${count} summits`);
      },
      error: err => {
        this.eventLog.error('Summits', `Failed: ${err.message}`);
        this.loading.set(false);
      },
    });
  }

  private loadWalkers(): void {
    this.api.getAprsPositions().subscribe({
      next: positions => {
        const cutoffMs = this.traceDurationHours() * 3_600_000;
        const now      = Date.now();

        // Group by callsign
        const byCs = new Map<string, AprsPosition[]>();
        positions.forEach(p => {
          const arr = byCs.get(p.callsign) ?? [];
          arr.push(p);
          byCs.set(p.callsign, arr);
        });

        // Sort newest-first, filter by trace window
        byCs.forEach((list, cs) => {
          list.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          const filtered = list.filter(p => now - new Date(p.lastSeen).getTime() <= cutoffMs);
          byCs.set(cs, filtered.length > 0 ? filtered : [list[0]]);
        });

        // Remove stale walkers
        this.walkers.forEach((st, cs) => {
          if (!byCs.has(cs)) {
            this.walkerLayer.removeLayer(st.marker);
            this.walkerLayer.removeLayer(st.trace);
            this.walkers.delete(cs);
          }
        });

        // Update / create walkers
        byCs.forEach((posList, cs) => {
          const latest    = posList[0];
          const freshness = walkerFreshness(latest.lastSeen);
          const latlng: L.LatLngExpression = [
            parseFloat(latest.latitude),
            parseFloat(latest.longitude),
          ];
          const tracePoints: L.LatLngExpression[] = posList.map(p =>
            [parseFloat(p.latitude), parseFloat(p.longitude)]
          );
          const popup = this.buildPopup(cs, latest, freshness, posList.length);

          if (this.walkers.has(cs)) {
            const st = this.walkers.get(cs)!;
            st.marker.setLatLng(latlng);
            st.marker.setIcon(makeWalkerIcon(cs, freshness));
            st.marker.setPopupContent(popup);
            st.trace.setLatLngs(tracePoints);
            st.trace.setStyle({ color: freshness.color });
            st.positions = posList;
          } else {
            const marker = L.marker(latlng, {
              icon:           makeWalkerIcon(cs, freshness),
              zIndexOffset:   1000,
            });
            marker.bindPopup(popup, { className: 'sota-popup-wrap' });
            marker.bindTooltip(
              `<b>${cs}</b><br><small>${freshness.label}</small>`,
              { direction: 'top', className: 'sota-tooltip' }
            );

            const trace = L.polyline(tracePoints, {
              color:     freshness.color,
              weight:    2,
              opacity:   0.55,
              dashArray: '5 5',
            });

            this.walkerLayer.addLayer(trace);
            this.walkerLayer.addLayer(marker);
            this.walkers.set(cs, { callsign: cs, positions: posList, marker, trace });
          }

          this.eventLog.info('APRS',
            `${cs} @ ${parseFloat(latest.latitude).toFixed(4)},${parseFloat(latest.longitude).toFixed(4)} (${freshness.label})`
          );
        });

        this.walkerCount.set(this.walkers.size);
        this.eventLog.success('APRS', `Refreshed — ${this.walkers.size} walkers active`);
      },
      error: err => this.eventLog.error('APRS', `Failed: ${err.message}`),
    });
  }

  private buildPopup(
    cs: string,
    pos: AprsPosition,
    freshness: Freshness,
    count: number,
  ): string {
    const lat = parseFloat(pos.latitude).toFixed(5);
    const lon = parseFloat(pos.longitude).toFixed(5);
    const alt = pos.altitude ? `${parseFloat(pos.altitude).toFixed(0)} m` : 'N/A';
    const t   = new Date(pos.lastSeen).toLocaleString();
    return `
      <div class="sota-popup">
        <div class="sota-popup__title">${cs}</div>
        <div class="sota-popup__row"><span>Last seen</span><span>${freshness.label}</span></div>
        <div class="sota-popup__row"><span>Time</span><span>${t}</span></div>
        <div class="sota-popup__row"><span>Latitude</span><span>${lat}°</span></div>
        <div class="sota-popup__row"><span>Longitude</span><span>${lon}°</span></div>
        <div class="sota-popup__row"><span>Altitude</span><span>${alt}</span></div>
        <div class="sota-popup__row"><span>Track points</span><span>${count}</span></div>
      </div>`;
  }

  onTraceDurationChange(): void {
    localStorage.setItem('traceDurationHours', String(this.traceDurationHours()));
    this.loadWalkers();
    this.eventLog.info('Config', `Trace window → ${this.traceDurationHours()} h`);
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.wsSub?.unsubscribe();
    this.ws.disconnect();
  }
}
