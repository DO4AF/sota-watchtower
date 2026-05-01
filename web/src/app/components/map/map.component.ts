import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { LeafletMarkerClusterModule } from '@bluehalo/ngx-leaflet-markercluster';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import { interval, Subscription } from 'rxjs';
import { ApiService, SotaAlert, AprsPosition } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { ThemeService } from '../../services/theme.service';

// Fix default Leaflet icon paths broken by webpack
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)['_getIconUrl'];
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'assets/leaflet/marker-icon-2x.png',
  iconUrl: 'assets/leaflet/marker-icon.png',
  shadowUrl: 'assets/leaflet/marker-shadow.png',
});

function makeSummitIcon(cssClass: string, label: string, size: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="summit-marker ${cssClass}">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const SUMMIT_ICON = makeSummitIcon('summit-marker--default', '▲', 22);
const ALERT_ICON  = makeSummitIcon('summit-marker--alert',   '▲', 30);
const NOTIFIED_ICON = makeSummitIcon('summit-marker--notified', '★', 34);

function makeWalkerIcon(callsign: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="walker-marker"><span class="walker-icon">🚶</span><span class="walker-label">${callsign}</span></div>`,
    iconSize: [80, 40],
    iconAnchor: [40, 20],
  });
}

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, LeafletModule, LeafletMarkerClusterModule],
  templateUrl: './map.component.html',
  styleUrl: './map.component.scss',
})
export class MapComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private wsService = inject(WebSocketService);
  private themeService = inject(ThemeService);
  private sub?: Subscription;
  private aprsRefreshSub?: Subscription;

  private lightTiles = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>' }
  );
  private darkTiles = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>' }
  );

  private leafletMap?: L.Map;

  mapOptions: L.MapOptions = {
    layers: [this.darkTiles],
    zoom: 8,
    center: L.latLng(47.5, 11.5),
    zoomControl: true,
  };

  clusterOptions: L.MarkerClusterGroupOptions = {
    maxClusterRadius: 40,
    showCoverageOnHover: false,
  };

  private markersByCode = new Map<string, L.Marker>();
  private alertsByCode = new Map<string, SotaAlert>();
  private walkerMarkers = new Map<string, L.Marker>();
  walkerLayer = new L.LayerGroup();

  markers: L.Marker[] = [];
  loading = signal(true);

  ngOnInit(): void {
    this.loadData();
    this.wsService.connect();
    this.sub = this.wsService.messages$.subscribe(msg => {
      if (msg.type === 'ALERT_UPDATE') {
        const alert = msg.payload as SotaAlert;
        this.alertsByCode.set(alert.summit, alert);
        this.updateMarkerIcon(alert.summit);
      }
    });
    // Refresh APRS positions every 60 seconds
    this.aprsRefreshSub = interval(60000).subscribe(() => this.loadAprsPositions());
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.aprsRefreshSub?.unsubscribe();
    this.wsService.disconnect();
  }

  onMapReady(map: L.Map): void {
    this.leafletMap = map;
    this.walkerLayer.addTo(map);
    // Apply correct tile layer based on current theme
    this.applyTileLayer();
  }

  private applyTileLayer(): void {
    if (!this.leafletMap) return;
    const isDark = this.themeService.isDark();
    this.lightTiles.remove();
    this.darkTiles.remove();
    if (isDark) {
      this.darkTiles.addTo(this.leafletMap);
    } else {
      this.lightTiles.addTo(this.leafletMap);
    }
  }

  private loadData(): void {
    this.apiService.getSummits().subscribe({
      next: geojson => {
        const newMarkers: L.Marker[] = [];
        geojson.features.forEach(f => {
          const coords = (f.geometry as GeoJSON.Point).coordinates;
          const props = f.properties as Record<string, unknown>;
          const code = props['summitCode'] as string;
          const popup = `
            <div class="map-popup">
              <div class="map-popup__title">${props['peakName']}</div>
              <div class="map-popup__code">${code}</div>
              <div class="map-popup__meta">
                <span>⬆ ${props['elevationM']} m</span>
                <span>★ ${props['points']} pts</span>
              </div>
            </div>`;
          const marker = L.marker([coords[1], coords[0]], { icon: SUMMIT_ICON })
            .bindPopup(popup, { className: 'sota-popup' });
          this.markersByCode.set(code, marker);
          newMarkers.push(marker);
        });
        this.markers = newMarkers;
        this.loading.set(false);
        this.loadAlerts();
        this.loadAprsPositions();
      },
      error: () => this.loading.set(false),
    });
  }

  private loadAlerts(): void {
    this.apiService.getAlerts().subscribe({
      next: alerts => {
        alerts.forEach(a => {
          this.alertsByCode.set(a.summit, a);
          this.updateMarkerIcon(a.summit);
        });
      },
    });
  }

  private loadAprsPositions(): void {
    this.apiService.getAprsPositions().subscribe({
      next: positions => {
        this.updateWalkerMarkers(positions);
      },
      error: () => { /* silently ignore */ },
    });
  }

  private updateWalkerMarkers(positions: AprsPosition[]): void {
    const seen = new Set<string>();
    positions.forEach(pos => {
      const lat = parseFloat(pos.latitude);
      const lon = parseFloat(pos.longitude);
      const alt = parseFloat(pos.altitude);
      if (isNaN(lat) || isNaN(lon)) return;
      seen.add(pos.callsign);

      const popup = `
        <div class="map-popup">
          <div class="map-popup__title">🚶 ${pos.callsign}</div>
          <div class="map-popup__meta">
            <span>⬆ ${isNaN(alt) ? '?' : Math.round(alt)} m</span>
            <span>🕐 ${pos.lastSeen ? new Date(pos.lastSeen + 'Z').toLocaleTimeString() : '?'}</span>
          </div>
        </div>`;

      if (this.walkerMarkers.has(pos.callsign)) {
        const m = this.walkerMarkers.get(pos.callsign)!;
        m.setLatLng([lat, lon]);
        m.setPopupContent(popup);
      } else {
        const m = L.marker([lat, lon], { icon: makeWalkerIcon(pos.callsign) })
          .bindPopup(popup, { className: 'sota-popup' });
        this.walkerMarkers.set(pos.callsign, m);
        this.walkerLayer.addLayer(m);
      }
    });

    // Remove stale walkers
    this.walkerMarkers.forEach((marker, callsign) => {
      if (!seen.has(callsign)) {
        this.walkerLayer.removeLayer(marker);
        this.walkerMarkers.delete(callsign);
      }
    });
  }

  private updateMarkerIcon(summitCode: string): void {
    const marker = this.markersByCode.get(summitCode);
    const alert = this.alertsByCode.get(summitCode);
    if (!marker || !alert) return;
    const icon = alert.notified ? NOTIFIED_ICON : ALERT_ICON;
    marker.setIcon(icon);
  }
}
