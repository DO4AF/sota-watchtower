import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { interval, Subscription } from 'rxjs';
import { ApiService, SotaAlert, SotaSpot } from '../../services/api.service';
import { WebSocketService } from '../../services/websocket.service';

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, TabsModule],
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

  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.loadAlerts();
    this.loadSpots();

    this.subs.push(
      interval(30_000).subscribe(() => this.loadSpots()),
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

  private loadAlerts(): void {
    this.apiService.getAlerts().subscribe({
      next: data => {
        this.alerts.set(data);
        this.alertsLoading.set(false);
      },
      error: () => this.alertsLoading.set(false),
    });
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
}
