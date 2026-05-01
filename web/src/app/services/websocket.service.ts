import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export interface WsMessage {
  type: string;
  payload: unknown;
}

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private authService = inject(AuthService);
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _messages = new Subject<WsMessage>();
  readonly messages$ = this._messages.asObservable();

  async connect(): Promise<void> {
    this.cleanup();
    const token = await this.authService.getIdToken();
    const url = `${environment.wsUrl}?token=${token ?? ''}`;
    this.ws = new WebSocket(url);

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        this._messages.next(JSON.parse(e.data as string) as WsMessage);
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = (e: CloseEvent) => {
      // 1008: policy violation (token expired) → reconnect with fresh token
      const delay = e.code === 1008 ? 500 : 5000;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
    this._messages.complete();
  }
}
