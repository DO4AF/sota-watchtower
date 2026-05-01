import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export interface SotaAlert {
  callsign: string;
  summit: string;
  notified: boolean;
  expiration?: number;
}

export interface SotaSpot {
  activatorCallsign: string;
  summitCode: string;
  associationCode: string;
  frequency: string;
  mode: string;
  timeStamp: string;
  summitName?: string;
}

export interface AppConfig {
  telegramBotToken?: string;
  telegramGroupId?: string;
  telegramUserId?: string;
  frequencyFilterPattern?: string;
  sotaAssociations?: string;
  activationZoneDistanceMeters?: string;
  activationZoneAltitudeDeltaMeters?: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  private authHeaders(): Observable<HttpHeaders> {
    return from(this.authService.getIdToken()).pipe(
      switchMap(token =>
        from(
          Promise.resolve(
            new HttpHeaders({ Authorization: `Bearer ${token ?? ''}` }),
          ),
        ),
      ),
    );
  }

  getSummits(): Observable<GeoJSON.FeatureCollection> {
    return this.http.get<GeoJSON.FeatureCollection>(
      `${environment.apiBaseUrl}/summits`,
    );
  }

  getAlerts(): Observable<SotaAlert[]> {
    return this.authHeaders().pipe(
      switchMap(headers =>
        this.http.get<SotaAlert[]>(`${environment.apiBaseUrl}/alerts`, {
          headers,
        }),
      ),
    );
  }

  getSpots(): Observable<SotaSpot[]> {
    return this.authHeaders().pipe(
      switchMap(headers =>
        this.http.get<SotaSpot[]>(`${environment.apiBaseUrl}/spots`, {
          headers,
        }),
      ),
    );
  }

  getConfig(): Observable<AppConfig> {
    return this.authHeaders().pipe(
      switchMap(headers =>
        this.http.get<AppConfig>(`${environment.apiBaseUrl}/config`, {
          headers,
        }),
      ),
    );
  }

  putConfig(config: AppConfig): Observable<{ message: string }> {
    return this.authHeaders().pipe(
      switchMap(headers =>
        this.http.put<{ message: string }>(
          `${environment.apiBaseUrl}/config`,
          config,
          { headers },
        ),
      ),
    );
  }
}
