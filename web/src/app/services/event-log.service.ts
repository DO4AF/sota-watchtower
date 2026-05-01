import { Injectable, signal } from '@angular/core';

export type EventSeverity = 'info' | 'warn' | 'error' | 'success';

export interface LogEvent {
  id: number;
  timestamp: Date;
  severity: EventSeverity;
  category: string;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class EventLogService {
  private counter = 0;
  readonly events = signal<LogEvent[]>([]);
  readonly visible = signal(false);

  log(severity: EventSeverity, category: string, message: string): void {
    const event: LogEvent = {
      id: ++this.counter,
      timestamp: new Date(),
      severity,
      category,
      message,
    };
    this.events.update(evts => [event, ...evts].slice(0, 200)); // keep last 200
  }

  info(category: string, message: string): void {
    this.log('info', category, message);
  }

  warn(category: string, message: string): void {
    this.log('warn', category, message);
  }

  error(category: string, message: string): void {
    this.log('error', category, message);
  }

  success(category: string, message: string): void {
    this.log('success', category, message);
  }

  toggle(): void {
    this.visible.update(v => !v);
  }

  clear(): void {
    this.events.set([]);
  }
}
