import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { EventLogService, EventSeverity } from '../../services/event-log.service';

@Component({
  selector: 'app-log',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, InputTextModule, IconFieldModule, InputIconModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent {
  readonly eventLog = inject(EventLogService);

  readonly severities: EventSeverity[] = ['info', 'success', 'warn', 'error'];

  /** Use signals so computed() reacts to changes */
  readonly filterText = signal('');
  readonly activeSeverities = signal<Set<EventSeverity>>(new Set(this.severities));

  /** Computed signal — filtered events based on text + severity toggles */
  readonly filteredEvents = computed(() => {
    const q    = this.filterText().trim().toLowerCase();
    const sevs = this.activeSeverities();
    return this.eventLog.events().filter(e => {
      if (!sevs.has(e.severity)) return false;
      if (!q) return true;
      return (
        e.category.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q)
      );
    });
  });

  isSevActive(sev: EventSeverity): boolean {
    return this.activeSeverities().has(sev);
  }

  toggleSeverity(sev: EventSeverity): void {
    const next = new Set(this.activeSeverities());
    if (next.has(sev)) {
      next.delete(sev);
    } else {
      next.add(sev);
    }
    this.activeSeverities.set(next);
  }

  tagSeverity(sev: string): 'success' | 'warn' | 'danger' | 'secondary' {
    const map: Record<string, 'success' | 'warn' | 'danger' | 'secondary'> = {
      success: 'success',
      warn:    'warn',
      error:   'danger',
      info:    'secondary',
    };
    return map[sev] ?? 'secondary';
  }

  formatTime(date: Date): string {
    return date.toLocaleTimeString();
  }

  clear(): void {
    this.eventLog.clear();
  }
}
