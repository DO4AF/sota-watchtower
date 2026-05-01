import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { LeafletMarkerClusterModule } from '@bluehalo/ngx-leaflet-markercluster';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import { Subscription } from 'rxjs';
import { CardModule } from 'primeng/card';
import { ApiService, SotaAlert } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';

// Fix default Leaflet icon paths broken by webpack
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)['_getIconUrl'];
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'assets/leaflet/marker-icon-2x.png',
  iconUrl: 'assets/leaflet/marker-icon.png',
  shadowUrl: 'assets/leaflet/marker-shadow.png',
});

const SUMMIT_ICON = L.divIcon({
  className: '',
  html: '<div class="summit-marker summit-marker--default">▲</div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const ALERT_ICON = L.divIcon({
  className: '',
  html: '<div class="summit-marker summit-marker--alert">▲</div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const NOTIFIED_ICON = L.divIcon({
  className: '',
  html: '<div class="summit-marker summit-marker--notified">★</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, LeafletModule, LeafletMarkerClusterModule, CardModule],
  templateUrl: './map.component.html',
  styleUrl: './map.component.scss',
})
export class MapComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private wsService = inject(WebSocketService);
  private sub?: Subscription;

  mapOptions: L.MapOptions = {
    layers: [
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    ],
    zoom: 8,
    center: L.latLng(47.5, 11.5),
  };

  clusterOptions: L.MarkerClusterGroupOptions = {
    maxClusterRadius: 40,
  };

  private markersByCode = new Map<string, L.Marker>();
  private alertsByCode = new Map<string, SotaAlert>();
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
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.wsService.disconnect();
  }

  private loadData(): void {
    this.apiService.getSummits().subscribe({
      next: geojson => {
        const newMarkers: L.Marker[] = [];
        geojson.features.forEach(f => {
          const coords = (f.geometry as GeoJSON.Point).coordinates;
          const props = f.properties as Record<string, unknown>;
          const code = props['summitCode'] as string;
          const popup = `<strong>${props['peakName']}</strong><br/>${code}<br/>${props['elevationM']} m — ${props['points']} pts`;
          const marker = L.marker([coords[1], coords[0]], { icon: SUMMIT_ICON })
            .bindPopup(popup);
          this.markersByCode.set(code, marker);
          newMarkers.push(marker);
        });
        this.markers = newMarkers;
        this.loading.set(false);
        this.loadAlerts();
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

  private updateMarkerIcon(summitCode: string): void {
    const marker = this.markersByCode.get(summitCode);
    const alert = this.alertsByCode.get(summitCode);
    if (!marker || !alert) return;
    const icon = alert.notified ? NOTIFIED_ICON : ALERT_ICON;
    marker.setIcon(icon);
  }
}
