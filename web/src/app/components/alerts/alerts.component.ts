import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
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
    InputTextModule,
    IconFieldModule,
    InputIconModule,
  ],
  templateUrl: './alerts.component.html',
  styleUrl: './alerts.component.scss',
})
export class AlertsComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private wsService  = inject(WebSocketService);
  private router     = inject(Router);

  alerts        = signal<SotaAlert[]>([]);
  spots         = signal<SotaSpot[]>([]);
  alertsLoading = signal(true);
  spotsLoading  = signal(true);

  alertFilter          = '';
  spotFilter           = '';
  showOnlyWithPosition = false;

  private aprsMap       = new Map<string, AprsPosition>();
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
    const summitsUrl = (environment as { summitsUrl?: string }).summitsUrl ?? '';
    const summitsPromise: Promise<GeoJSON.FeatureCollection> =
      (summitsUrl && !summitsUrl.startsWith('${'))
        ? fetch(summitsUrl).then(r => r.json() as Promise<GeoJSON.FeatureCollection>)
        : new Promise<GeoJSON.FeatureCollection>((resolve, reject) =>
            this.apiService.getSummits().subscribe({ next: resolve, error: reject })
          );

    forkJoin({
      alerts: this.apiService.getAlerts().pipe(catchError(() => of([] as SotaAlert[]))),
      aprs:   this.apiService.getAprsPositions().pipe(catchError(() => of([] as AprsPosition[]))),
    }).subscribe({
      next: ({ alerts, aprs }) => {
        this.alerts.set(alerts as SotaAlert[]);
        this.alertsLoading.set(false);
        this.aprsMap.clear();
        (aprs as AprsPosition[]).forEach(p => {
          this.aprsMap.set(p.callsign, p);
          const base = p.callsign.replace(/-\d+$/, '');
          if (base !== p.callsign) this.aprsMap.set(base, p);
        });
      },
      error: () => this.alertsLoading.set(false),
    });

    summitsPromise.then(geojson => {
      this.summitCoordMap.clear();
      geojson.features.forEach(f => {
        const props  = f.properties as Record<string, unknown>;
        const coords = (f.geometry as GeoJSON.Point).coordinates;
        const code   = String(props['c'] ?? props['summitCode'] ?? '');
        if (code) this.summitCoordMap.set(code, { lat: coords[1], lon: coords[0] });
      });
    }).catch(() => {});
  }

  private loadSpots(): void {
    this.spotsLoading.set(true);
    this.apiService.getSpots().subscribe({
      next: data => { this.spots.set(data); this.spotsLoading.set(false); },
      error: ()   => this.spotsLoading.set(false),
    });
  }

  // ── Position helpers ────────────────────────────────────────────────────────

  private lookupPosition(callsign: string): AprsPosition | undefined {
    return this.aprsMap.get(callsign)
      ?? this.aprsMap.get(callsign.replace(/-\d+$/, ''));
  }

  hasPosition(alert: SotaAlert): boolean {
    return !!this.lookupPosition(alert.callsign);
  }

  getAlertPosition(alert: SotaAlert): AprsPosition | undefined {
    return this.lookupPosition(alert.callsign);
  }

  getSpotActivatorPosition(callsign: string): AprsPosition | undefined {
    return this.lookupPosition(callsign);
  }

  getSummitCoord(summitCode: string): { lat: number; lon: number } | undefined {
    return this.summitCoordMap.get(summitCode);
  }

  distanceToSummit(alert: SotaAlert): string {
    const aprs = this.lookupPosition(alert.callsign);
    if (!aprs) return '—';
    const summit = this.summitCoordMap.get(alert.summit);
    if (!summit) return '?';
    const km = haversineKm(
      parseFloat(aprs.latitude), parseFloat(aprs.longitude),
      summit.lat, summit.lon
    );
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  }

  // ── Navigation helpers ──────────────────────────────────────────────────────

  sotlasActivatorUrl(callsign: string): string {
    return `https://sotl.as/activators/${callsign.replace(/-\d+$/, '')}`;
  }

  sotlasSummitUrl(summitCode: string): string {
    return `https://sotl.as/summits/${summitCode}`;
  }

  jumpToActivator(alert: SotaAlert): void {
    const pos = this.getAlertPosition(alert);
    if (!pos) return;
    this.router.navigate(['/map'], {
      queryParams: {
        lat:  parseFloat(pos.latitude).toFixed(5),
        lon:  parseFloat(pos.longitude).toFixed(5),
        zoom: 14,
        label: alert.callsign,
      },
    });
  }

  jumpToSpotActivator(callsign: string): void {
    const pos = this.getSpotActivatorPosition(callsign);
    if (!pos) return;
    this.router.navigate(['/map'], {
      queryParams: {
        lat:  parseFloat(pos.latitude).toFixed(5),
        lon:  parseFloat(pos.longitude).toFixed(5),
        zoom: 14,
        label: callsign,
      },
    });
  }

  jumpToSummit(summitCode: string): void {
    const coord = this.getSummitCoord(summitCode);
    if (!coord) return;
    this.router.navigate(['/map'], {
      queryParams: {
        lat:  coord.lat.toFixed(5),
        lon:  coord.lon.toFixed(5),
        zoom: 14,
        label: summitCode,
      },
    });
  }

  // ── Filtered data getters ───────────────────────────────────────────────────

  get filteredAlerts(): SotaAlert[] {
    const q = this.alertFilter.trim().toLowerCase();
    return this.alerts().filter(a => {
      if (this.showOnlyWithPosition && !this.lookupPosition(a.callsign)) return false;
      if (!q) return true;
      return a.callsign.toLowerCase().includes(q) || a.summit.toLowerCase().includes(q);
    });
  }

  get filteredSpots(): SotaSpot[] {
    const q = this.spotFilter.trim().toLowerCase();
    if (!q) return this.spots();
    return this.spots().filter(s =>
      s.activatorCallsign.toLowerCase().includes(q) ||
      s.summitCode.toLowerCase().includes(q)        ||
      s.frequency.toLowerCase().includes(q)         ||
      s.mode.toLowerCase().includes(q)
    );
  }
}
