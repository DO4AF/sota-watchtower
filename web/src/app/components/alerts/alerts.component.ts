import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { BadgeModule } from 'primeng/badge';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { interval, Subscription, forkJoin } from 'rxjs';
import { catchError, of } from 'rxjs';
import { ApiService, SotaAlert, SotaSpot, AprsPosition } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';
import { environment } from '../../../environments/environment';

/** Haversine distance in km between two lat/lon points */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    TableModule,
    TagModule,
    TabsModule,
    BadgeModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
  ],
  templateUrl: './alerts.component.html',
  styleUrl: './alerts.component.scss',
})
export class AlertsComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private wsService = inject(WebSocketService);

  alerts = signal<SotaAlert[]>([]);
  spots = signal<SotaSpot[]>([]);
  alertsLoading = signal(true);
  spotsLoading = signal(true);

  /** Search/filter strings */
  alertFilter = '';
  spotFilter = '';

  /** APRS positions map: callsign → position */
  private aprsMap = new Map<string, AprsPosition>();
  /** Summit coordinates map: summitCode → {lat, lon} */
  private summitCoordMap = new Map<string, { lat: number; lon: number }>();

  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.loadAlertsAndPositions();
    this.loadSpots();

    this.subs.push(
      interval(30_000).subscribe(() => this.loadSpots()),
      interval(60_000).subscribe(() => this.loadAlertsAndPositions()),
      this.wsService.messages$.subscribe(msg => {
        if (msg.type === 'ALERT_UPDATE') {
          const updated = msg.payload as SotaAlert;
          this.alerts.update(list => {
            const idx = list.findIndex(
              a => a.callsign === updated.callsign && a.summit === updated.summit,
            );
            if (idx >= 0) {
              const copy = [...list];
              copy[idx] = updated;
              return copy;
            }
            return [updated, ...list];
          });
        }
      }),
    );
    this.wsService.connect();
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  private loadAlertsAndPositions(): void {
    // Determine summit source URL (same logic as map component)
    const summitsUrl = (environment as { summitsUrl?: string }).summitsUrl ?? '';
    const summitsObs = (summitsUrl && !summitsUrl.startsWith('${'))
      ? fetch(summitsUrl).then(r => r.json() as Promise<GeoJSON.FeatureCollection>)
      : new Promise<GeoJSON.FeatureCollection>((resolve, reject) =>
          this.apiService.getSummits().subscribe({ next: resolve, error: reject })
        );

    // Load alerts and APRS positions in parallel; also pre-load summit coords
    forkJoin({
      alerts: this.apiService.getAlerts().pipe(catchError(() => of([] as SotaAlert[]))),
      aprs:   this.apiService.getAprsPositions().pipe(catchError(() => of([] as AprsPosition[]))),
    }).subscribe({
      next: ({ alerts, aprs }) => {
        this.alerts.set(alerts as SotaAlert[]);
        this.alertsLoading.set(false);

        // Build APRS map
        this.aprsMap.clear();
        (aprs as AprsPosition[]).forEach(p => {
          // Also match on base callsign (strip SSID like -7)
          this.aprsMap.set(p.callsign, p);
          const base = p.callsign.replace(/-\d+$/, '');
          if (base !== p.callsign) this.aprsMap.set(base, p);
        });
      },
      error: () => this.alertsLoading.set(false),
    });

    // Load summit coords in the background
    summitsObs.then(geojson => {
      this.summitCoordMap.clear();
      geojson.features.forEach(f => {
        const props  = f.properties as Record<string, unknown>;
        const coords = (f.geometry as GeoJSON.Point).coordinates;
        const code   = String(props['c'] ?? props['summitCode'] ?? '');
        if (code) {
          this.summitCoordMap.set(code, { lat: coords[1], lon: coords[0] });
        }
      });
    }).catch(() => { /* summit coords are optional — distance column will just show '—' */ });
  }

  private loadSpots(): void {
    this.spotsLoading.set(true);
    this.apiService.getSpots().subscribe({
      next: data => {
        this.spots.set(data);
        this.spotsLoading.set(false);
      },
      error: () => this.spotsLoading.set(false),
    });
  }

  /** Returns the distance string from activator APRS position to the alerted summit, or '—' */
  distanceToSummit(alert: SotaAlert): string {
    const aprs = this.aprsMap.get(alert.callsign)
      ?? this.aprsMap.get(alert.callsign.replace(/-\d+$/, ''));
    if (!aprs) return '—';

    const summit = this.summitCoordMap.get(alert.summit);
    if (!summit) return '?';

    const km = haversineKm(
      parseFloat(aprs.latitude), parseFloat(aprs.longitude),
      summit.lat, summit.lon
    );
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  }

  /** True if we have an APRS position for this alert's callsign */
  hasPosition(alert: SotaAlert): boolean {
    return this.aprsMap.has(alert.callsign)
      || this.aprsMap.has(alert.callsign.replace(/-\d+$/, ''));
  }

  /** Filtered alerts based on alertFilter text */
  get filteredAlerts(): SotaAlert[] {
    const q = this.alertFilter.trim().toLowerCase();
    if (!q) return this.alerts();
    return this.alerts().filter(a =>
      a.callsign.toLowerCase().includes(q) ||
      a.summit.toLowerCase().includes(q)
    );
  }

  /** Filtered spots based on spotFilter text */
  get filteredSpots(): SotaSpot[] {
    const q = this.spotFilter.trim().toLowerCase();
    if (!q) return this.spots();
    return this.spots().filter(s =>
      s.activatorCallsign.toLowerCase().includes(q) ||
      s.summitCode.toLowerCase().includes(q) ||
      s.frequency.toLowerCase().includes(q) ||
      s.mode.toLowerCase().includes(q)
    );
  }
}
