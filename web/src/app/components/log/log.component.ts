import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { EventLogService } from '../../services/event-log.service';

@Component({
  selector: 'app-log',
  standalone: true,
  imports: [CommonModule, ButtonModule, TagModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent {
  readonly eventLog = inject(EventLogService);

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
