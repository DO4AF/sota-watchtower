import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { fetchAuthSession } from 'aws-amplify/auth';
import { environment } from '../../environments/environment';

export interface SotaAlert {
  callsign: string;
  summit: string;
  notified?: boolean;
  expiration?: number;
}

export interface SotaSpot {
  activatorCallsign: string;
  summitCode: string;
  frequency: string;
  mode: string;
  timeStamp: string;
}

export interface AprsPosition {
  callsign: string;
  latitude: string;
  longitude: string;
  altitude: string;
  lastSeen: string;
}

export interface AppConfig {
  telegramBotToken: string;
  telegramGroupId: string;
  telegramUserId: string;
  frequencyFilterPattern: string;
  sotaAssociations: string;
  activationZoneDistanceMeters: string;
  activationZoneAltitudeDeltaMeters: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = environment.apiBaseUrl;

  private authHeaders(): Observable<HttpHeaders> {
    return from(fetchAuthSession()).pipe(
      switchMap(session => {
        const token = session.tokens?.idToken?.toString() ?? '';
        return [new HttpHeaders({ Authorization: token })];
      })
    );
  }

  getSummits(): Observable<GeoJSON.FeatureCollection> {
    return this.http.get<GeoJSON.FeatureCollection>(`${this.base}/summits`);
  }

  getAlerts(): Observable<SotaAlert[]> {
    return this.authHeaders().pipe(
      switchMap(headers => this.http.get<SotaAlert[]>(`${this.base}/alerts`, { headers }))
    );
  }

  getSpots(): Observable<SotaSpot[]> {
    return this.authHeaders().pipe(
      switchMap(headers => this.http.get<SotaSpot[]>(`${this.base}/spots`, { headers }))
    );
  }

  getAprsPositions(): Observable<AprsPosition[]> {
    return this.http.get<AprsPosition[]>(`${this.base}/aprs-positions`);
  }

  getConfig(): Observable<Record<string, unknown>> {
    return this.authHeaders().pipe(
      switchMap(headers => this.http.get<Record<string, unknown>>(`${this.base}/config`, { headers }))
    );
  }

  putConfig(config: AppConfig | Record<string, unknown>): Observable<unknown> {
    return this.authHeaders().pipe(
      switchMap(headers => this.http.put(`${this.base}/config`, config, { headers }))
    );
  }
}
