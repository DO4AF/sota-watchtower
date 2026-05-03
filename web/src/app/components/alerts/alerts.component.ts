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
import { getCallsignFlag } from '../../shared/callsign-flag.util';

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
  activeModeFilters    = new Set<string>();

  readonly ALERT_HIGHLIGHT_WINDOW_MINUTES = 60;
  readonly SPOT_HIGHLIGHT_WINDOW_MINUTES = 30;
  readonly SPOT_MAX_AGE_HOURS = 6;

  private aprsMap       = new Map<string, AprsPosition>();
  private summitCoordMap = new Map<string, { lat: number; lon: number }>();
  private qrvCallsigns   = new Set<string>();   // normalized base callsigns spotted today (UTC)

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
          const noSsid = p.callsign.replace(/-\d+$/, '');
          if (noSsid !== p.callsign) this.aprsMap.set(noSsid, p);
          const base = noSsid.replace(/\/[A-Z0-9]+$/i, '');
          if (base !== noSsid) this.aprsMap.set(base, p);
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
      next: data => {
        this.spots.set(data);
        this.spotsLoading.set(false);
        this.buildQrvSet(data);
      },
      error: () => this.spotsLoading.set(false),
    });
  }

  private buildQrvSet(spots: SotaSpot[]): void {
    const todayUtc = new Date().toISOString().slice(0, 10);
    this.qrvCallsigns.clear();
    spots.forEach(s => {
      const ts = this.spotTimeMs(s);
      if (ts === null) return;
      const spotDay = new Date(ts).toISOString().slice(0, 10);
      if (spotDay !== todayUtc) return;
      const raw = this.spotCallsign(s);
      if (!raw) return;
      const base = raw.toUpperCase().replace(/\/[A-Z0-9]+$/i, '').replace(/-\d+$/, '');
      this.qrvCallsigns.add(base);
    });
  }

  isQrv(alert: SotaAlert): boolean {
    const base = alert.callsign.toUpperCase().replace(/\/[A-Z0-9]+$/i, '').replace(/-\d+$/, '');
    return this.qrvCallsigns.has(base);
  }

  // ── Position helpers ────────────────────────────────────────────────────────

  private lookupPosition(callsign: string): AprsPosition | undefined {
    const noSsid = callsign.replace(/-\d+$/, '');
    const base   = noSsid.replace(/\/[A-Z0-9]+$/i, '');
    return this.aprsMap.get(callsign)
      ?? this.aprsMap.get(noSsid)
      ?? this.aprsMap.get(base);
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

  alertSummitRef(alert: SotaAlert): string {
    return alert.summitRef || alert.summit;
  }

  spotSummitRef(spot: SotaSpot): string {
    return spot.summitRef || spot.summitCode || '';
  }

  spotCallsign(spot: SotaSpot): string {
    return spot.callsign || spot.activatorCallsign || '';
  }

  callsignFlag(callsign: string): string {
    return getCallsignFlag(callsign);
  }

  distanceToSummit(alert: SotaAlert): string {
    const aprs = this.lookupPosition(alert.callsign);
    if (!aprs) return '—';
    const summit = this.summitCoordMap.get(this.alertSummitRef(alert));
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
      return a.callsign.toLowerCase().includes(q)
        || this.alertSummitRef(a).toLowerCase().includes(q)
        || String(a.summitName || '').toLowerCase().includes(q);
    });
  }

  get filteredSpots(): SotaSpot[] {
    const q = this.spotFilter.trim().toLowerCase();
    const now = Date.now();
    const maxAgeMs = this.SPOT_MAX_AGE_HOURS * 3_600_000;

    return this.spots().filter(s => {
      const spotTs = this.spotTimeMs(s);
      const withinAgeWindow = spotTs === null || (now - spotTs) <= maxAgeMs;
      if (!withinAgeWindow) return false;

      if (this.activeModeFilters.size > 0) {
        const mode = (s.mode ?? '').trim().toUpperCase();
        if (!this.activeModeFilters.has(mode)) return false;
      }

      if (!q) return true;

      return this.spotCallsign(s).toLowerCase().includes(q)
        || this.spotSummitRef(s).toLowerCase().includes(q)
        || String(s.summitName || '').toLowerCase().includes(q)
        || String(s.frequency || '').toLowerCase().includes(q)
        || String(s.mode || '').toLowerCase().includes(q)
        || String(s.postedBy || '').toLowerCase().includes(q);
    });
  }

  /** Distinct mode values present in the current (unfiltered) spots list, sorted alphabetically. */
  get availableModes(): string[] {
    const modes = new Set<string>();
    this.spots().forEach(s => {
      const m = (s.mode ?? '').trim().toUpperCase();
      if (m) modes.add(m);
    });
    return Array.from(modes).sort();
  }

  isModeActive(mode: string): boolean {
    return this.activeModeFilters.has(mode.toUpperCase());
  }

  toggleMode(mode: string): void {
    const key = mode.toUpperCase();
    if (this.activeModeFilters.has(key)) {
      this.activeModeFilters.delete(key);
    } else {
      this.activeModeFilters.add(key);
    }
    // Trigger change detection by reassigning to a new Set
    this.activeModeFilters = new Set(this.activeModeFilters);
  }

  alertRowClass(alert: SotaAlert): string {    return this.isAlertInHighlightWindow(alert) ? 'table-row--highlight' : '';
  }

  spotRowClass(spot: SotaSpot): string {
    return this.isSpotFresh(spot) ? 'table-row--highlight' : '';
  }

  private isAlertInHighlightWindow(alert: SotaAlert): boolean {
    const ts = this.alertTimeMs(alert);
    if (ts === null) return false;
    const deltaMs = Math.abs(Date.now() - ts);
    return deltaMs <= this.ALERT_HIGHLIGHT_WINDOW_MINUTES * 60_000;
  }

  private isSpotFresh(spot: SotaSpot): boolean {
    const ts = this.spotTimeMs(spot);
    if (ts === null) return false;
    const ageMs = Date.now() - ts;
    return ageMs >= 0 && ageMs <= this.SPOT_HIGHLIGHT_WINDOW_MINUTES * 60_000;
  }

  private alertTimeMs(alert: SotaAlert): number | null {
    const extended = alert as SotaAlert & { date_activated?: string; activationDate?: string };
    return this.parseTimestampMs(extended.dateActivated ?? extended.date_activated ?? extended.activationDate ?? null);
  }

  private spotTimeMs(spot: SotaSpot): number | null {
    return this.parseTimestampMs(spot.time ?? spot.timeStamp ?? null);
  }

  private parseTimestampMs(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === 'number') {
      if (Number.isNaN(raw)) return null;
      return raw > 1_000_000_000_000 ? raw : raw * 1000;
    }

    const value = String(raw).trim();
    if (!value) return null;

    const normalizedIso = value.replace(/(\.\d{3})\d+/, '$1').replace('Z', '+00:00');
    const parsedIso = new Date(normalizedIso).getTime();
    if (!Number.isNaN(parsedIso)) return parsedIso;

    const numeric = Number(value);
    if (Number.isNaN(numeric)) return null;
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
}
