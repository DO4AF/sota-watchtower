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
import { ThemeService } from '../../services/theme.service';
import { EventLogService } from '../../services/event-log.service';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WalkerState {
  callsign: string;
  positions: AprsPosition[]; // newest first
  marker: L.Marker;
  trace: L.Polyline;
}

// ─── Summit point colors ─────────────────────────────────────────────────────

const SUMMIT_COLORS: Record<number, string> = {
  1: '#00c853',
  2: '#64dd17',
  3: '#aeea00',
  4: '#ffd600',
  5: '#ffab00',
  6: '#ff6d00',
  7: '#dd2c00',
  8: '#c62828',
  9: '#b71c1c',
  10: '#880e4f',
};

function summitColor(points: number): string {
  return SUMMIT_COLORS[Math.max(1, Math.min(10, points))] ?? '#888';
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
  const ageMin = ageMs / 60000;
  if (ageMin < 5)  return { ageMin, color: '#00e676', opacity: 1.0,  label: `${Math.round(ageMin)}m ago`, pulse: true };
  if (ageMin < 15) return { ageMin, color: '#ffeb3b', opacity: 0.85, label: `${Math.round(ageMin)}m ago`, pulse: false };
  if (ageMin < 30) return { ageMin, color: '#ff9800', opacity: 0.65, label: `${Math.round(ageMin)}m ago`, pulse: false };
  const h = Math.floor(ageMin / 60);
  const m = Math.round(ageMin % 60);
  const label = h > 0 ? `${h}h ${m}m ago` : `${Math.round(ageMin)}m ago`;
  return { ageMin, color: '#9e9e9e', opacity: 0.4, label, pulse: false };
}

// ─── Walker icon ─────────────────────────────────────────────────────────────

function makeWalkerIcon(freshness: Freshness): L.DivIcon {
  const pulse = freshness.pulse
    ? `<div class="walker-pulse" style="border-color:${freshness.color}"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `
      <div class="walker-marker" style="opacity:${freshness.opacity}">
        ${pulse}
        <div class="walker-marker__icon" style="background:${freshness.color}22; border-color:${freshness.color}">
          🚶
        </div>
      </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -24],
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, FormsModule, LeafletModule],
  templateUrl: './map.component.html',
  styleUrl: './map.component.scss',
})
export class MapComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private wsService = inject(WebSocketService);
  private themeService = inject(ThemeService);
  readonly eventLog = inject(EventLogService);

  // Map state
  private map!: L.Map;
  private tileLayer!: L.TileLayer;
  private summitLayer = L.layerGroup();
  private walkerLayer = L.layerGroup();
  private walkers = new Map<string, WalkerState>();

  // Subscriptions
  private refreshSub?: Subscription;
  private wsSub?: Subscription;

  // Signals
  readonly loading = signal(true);
  readonly summitCount = signal(0);
  readonly walkerCount = signal(0);

  // Trace duration (hours) — stored in localStorage
  traceDurationHours = signal(2);

  // Map options
  mapOptions: L.MapOptions = {
    center: [47.5, 11.0],
    zoom: 7,
    zoomControl: true,
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
    this.wsService.connect();
    this.wsSub = this.wsService.messages$.subscribe(msg => {
      this.eventLog.info('WebSocket', JSON.stringify(msg));
    });
    this.eventLog.info('Map', 'Map initialized');
  }

  private applyTiles(): void {
    if (this.tileLayer) this.tileLayer.remove();
    const dark = this.themeService.isDark();
    const url = dark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
    this.tileLayer = L.tileLayer(url, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    });
    this.tileLayer.addTo(this.map);
  }

  private loadSummits(): void {
    this.apiService.getSummits().subscribe({
      next: (geojson) => {
        this.summitLayer.clearLayers();
        let count = 0;
        geojson.features.forEach((f) => {
          const props = f.properties as Record<string, unknown>;
          const coords = (f.geometry as GeoJSON.Point).coordinates;
          const points = Number(props['points'] ?? 1);
          const color = summitColor(points);
          const marker = L.circleMarker([coords[1], coords[0]], {
            radius: 5 + Math.min(points, 10) * 0.4,
            fillColor: color,
            color: '#fff',
            weight: 1,
            fillOpacity: 0.85,
            opacity: 0.9,
          });
          const name = String(props['name'] ?? '');
          const code = String(props['code'] ?? '');
          const alt = String(props['altitude'] ?? '');
          marker.bindTooltip(`<b>${code}</b><br>${name}<br>${alt}m · ${points}pt`, {
            direction: 'top',
            className: 'sota-tooltip',
          });
          marker.bindPopup(`
            <div class="sota-popup">
              <div class="sota-popup__title">${code}</div>
              <div class="sota-popup__subtitle">${name}</div>
              <div class="sota-popup__row"><span>Altitude</span><span>${alt} m</span></div>
              <div class="sota-popup__row"><span>Points</span><span>${points} pt</span></div>
            </div>`, { className: 'sota-popup-wrap' });
          this.summitLayer.addLayer(marker);
          count++;
        });
        this.summitCount.set(count);
        this.loading.set(false);
        this.eventLog.success('Summits', `Loaded ${count} summits`);
      },
      error: (err) => {
        this.eventLog.error('Summits', `Failed to load summits: ${err.message}`);
        this.loading.set(false);
      },
    });
  }

  private loadWalkers(): void {
    this.apiService.getAprsPositions().subscribe({
      next: (positions) => {
        const cutoffMs = this.traceDurationHours() * 3600 * 1000;
        const now = Date.now();

        // Group positions by callsign
        const byCallsign = new Map<string, AprsPosition[]>();
        positions.forEach(p => {
          const list = byCallsign.get(p.callsign) ?? [];
          list.push(p);
          byCallsign.set(p.callsign, list);
        });

        // Sort each callsign's positions newest-first, filter by trace duration
        byCallsign.forEach((list, callsign) => {
          list.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
          const filtered = list.filter(p => now - new Date(p.lastSeen).getTime() <= cutoffMs);
          byCallsign.set(callsign, filtered.length > 0 ? filtered : [list[0]]);
        });

        // Remove walkers no longer present
        this.walkers.forEach((state, callsign) => {
          if (!byCallsign.has(callsign)) {
            this.walkerLayer.removeLayer(state.marker);
            this.walkerLayer.removeLayer(state.trace);
            this.walkers.delete(callsign);
          }
        });

        // Update or create walkers
        byCallsign.forEach((posList, callsign) => {
          const latest = posList[0];
          const freshness = walkerFreshness(latest.lastSeen);
          const latlng: L.LatLngExpression = [
            parseFloat(latest.latitude),
            parseFloat(latest.longitude),
          ];
          const tracePoints: L.LatLngExpression[] = posList.map(p => [
            parseFloat(p.latitude),
            parseFloat(p.longitude),
          ]);

          const popupHtml = this.buildWalkerPopup(callsign, latest, freshness, posList.length);

          if (this.walkers.has(callsign)) {
            const state = this.walkers.get(callsign)!;
            state.marker.setLatLng(latlng);
            state.marker.setIcon(makeWalkerIcon(freshness));
            state.marker.setPopupContent(popupHtml);
            state.trace.setLatLngs(tracePoints);
            state.positions = posList;
          } else {
            const marker = L.marker(latlng, {
              icon: makeWalkerIcon(freshness),
              zIndexOffset: 1000,
            });
            marker.bindPopup(popupHtml, { className: 'sota-popup-wrap' });
            marker.bindTooltip(
              `<b>${callsign}</b><br>${freshness.label}`,
              { direction: 'top', className: 'sota-tooltip' }
            );

            const trace = L.polyline(tracePoints, {
              color: freshness.color,
              weight: 2,
              opacity: 0.6,
              dashArray: '4 4',
            });

            this.walkerLayer.addLayer(trace);
            this.walkerLayer.addLayer(marker);
            this.walkers.set(callsign, { callsign, positions: posList, marker, trace });
          }

          this.eventLog.info('APRS', `${callsign} @ ${parseFloat(latest.latitude).toFixed(4)},${parseFloat(latest.longitude).toFixed(4)} (${freshness.label})`);
        });

        this.walkerCount.set(this.walkers.size);
        this.eventLog.success('APRS', `Refreshed ${this.walkers.size} walkers`);
      },
      error: (err) => {
        this.eventLog.error('APRS', `Failed to load positions: ${err.message}`);
      },
    });
  }

  private buildWalkerPopup(
    callsign: string,
    pos: AprsPosition,
    freshness: Freshness,
    historyCount: number
  ): string {
    const lat = parseFloat(pos.latitude).toFixed(5);
    const lon = parseFloat(pos.longitude).toFixed(5);
    const alt = pos.altitude ? `${parseFloat(pos.altitude).toFixed(0)} m` : 'N/A';
    const lastSeen = new Date(pos.lastSeen).toLocaleString();
    return `
      <div class="sota-popup">
        <div class="sota-popup__title">🚶 ${callsign}</div>
        <div class="sota-popup__row"><span>Last seen</span><span>${freshness.label}</span></div>
        <div class="sota-popup__row"><span>Time</span><span>${lastSeen}</span></div>
        <div class="sota-popup__row"><span>Latitude</span><span>${lat}°</span></div>
        <div class="sota-popup__row"><span>Longitude</span><span>${lon}°</span></div>
        <div class="sota-popup__row"><span>Altitude</span><span>${alt}</span></div>
        <div class="sota-popup__row"><span>Track points</span><span>${historyCount}</span></div>
      </div>`;
  }

  onTraceDurationChange(): void {
    localStorage.setItem('traceDurationHours', String(this.traceDurationHours()));
    this.loadWalkers();
    this.eventLog.info('Config', `Trace duration set to ${this.traceDurationHours()}h`);
  }

  toggleLog(): void {
    this.eventLog.toggle();
  }

  clearLog(): void {
    this.eventLog.clear();
  }

  logSeverityClass(severity: string): string {
    return `log-entry--${severity}`;
  }

  formatTime(date: Date): string {
    return date.toLocaleTimeString();
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.wsSub?.unsubscribe();
    this.wsService.disconnect();
  }
}
