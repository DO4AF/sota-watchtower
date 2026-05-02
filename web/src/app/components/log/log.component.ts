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

  filterText = '';
  readonly severities: EventSeverity[] = ['info', 'success', 'warn', 'error'];
  activeSeverities = new Set<EventSeverity>(this.severities); // all active by default

  /** Computed signal — filtered events based on text + severity toggles */
  filteredEvents = computed(() => {
    const q = this.filterText.trim().toLowerCase();
    return this.eventLog.events().filter(e => {
      if (!this.activeSeverities.has(e.severity)) return false;
      if (!q) return true;
      return (
        e.category.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q)
      );
    });
  });

  toggleSeverity(sev: EventSeverity): void {
    if (this.activeSeverities.has(sev)) {
      this.activeSeverities.delete(sev);
    } else {
      this.activeSeverities.add(sev);
    }
    // Trigger computed re-evaluation by re-assigning the Set reference
    this.activeSeverities = new Set(this.activeSeverities);
  }

  tagSeverity(sev: string): 'success' | 'warn' | 'danger' | 'secondary' {
    const map: Record<string, 'success' | 'warn' | 'danger' | 'secondary'> = {
      success: 'success',
      warn: 'warn',
      error: 'danger',
      info: 'secondary',
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
