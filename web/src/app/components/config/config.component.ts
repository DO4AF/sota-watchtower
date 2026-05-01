import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SliderModule } from 'primeng/slider';
import { MultiSelectModule } from 'primeng/multiselect';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ApiService, AppConfig } from '../../services/api.service';

const ASSOCIATION_OPTIONS = [
  { label: 'DL (Germany Alpine)', value: 'DL' },
  { label: 'OE (Austria)', value: 'OE' },
  { label: 'DM (Germany)', value: 'DM' },
  { label: 'HB (Switzerland)', value: 'HB' },
  { label: 'HB0 (Liechtenstein)', value: 'HB0' },
  { label: 'I (Italy)', value: 'I' },
  { label: 'F (France)', value: 'F' },
];

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    InputTextModule,
    PasswordModule,
    SliderModule,
    MultiSelectModule,
    MessageModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './config.component.html',
  styleUrl: './config.component.scss',
})
export class ConfigComponent implements OnInit {
  private apiService = inject(ApiService);
  private messageService = inject(MessageService);

  associationOptions = ASSOCIATION_OPTIONS;

  loading = signal(true);
  saving = signal(false);
  hasChanges = signal(false);

  // Telegram
  telegramBotToken = '';
  telegramGroupId = '';
  telegramUserId = '';

  // Filters
  frequencyFilterPattern = '';
  selectedAssociations: string[] = [];

  // Activation Zone
  activationZoneDistance = 300;
  activationZoneAltitude = 25;

  private originalJson = '';

  ngOnInit(): void {
    this.apiService.getConfig().subscribe({
      next: cfg => {
        this.telegramBotToken = cfg.telegramBotToken ?? '';
        this.telegramGroupId = cfg.telegramGroupId ?? '';
        this.telegramUserId = cfg.telegramUserId ?? '';
        this.frequencyFilterPattern = cfg.frequencyFilterPattern ?? '';
        this.selectedAssociations = cfg.sotaAssociations
          ? JSON.parse(cfg.sotaAssociations)
          : ['DL', 'OE', 'DM'];
        this.activationZoneDistance = Number(cfg.activationZoneDistanceMeters ?? 300);
        this.activationZoneAltitude = Number(cfg.activationZoneAltitudeDeltaMeters ?? 25);
        this.originalJson = this.toJson();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onFormChange(): void {
    this.hasChanges.set(this.toJson() !== this.originalJson);
  }

  save(): void {
    this.saving.set(true);
    const payload: AppConfig = {
      telegramBotToken: this.telegramBotToken,
      telegramGroupId: this.telegramGroupId,
      telegramUserId: this.telegramUserId,
      frequencyFilterPattern: this.frequencyFilterPattern,
      sotaAssociations: JSON.stringify(this.selectedAssociations),
      activationZoneDistanceMeters: String(this.activationZoneDistance),
      activationZoneAltitudeDeltaMeters: String(this.activationZoneAltitude),
    };
    this.apiService.putConfig(payload).subscribe({
      next: () => {
        this.originalJson = this.toJson();
        this.hasChanges.set(false);
        this.saving.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: 'Configuration updated',
        });
      },
      error: () => {
        this.saving.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to save configuration',
        });
      },
    });
  }

  private toJson(): string {
    return JSON.stringify({
      telegramBotToken: this.telegramBotToken,
      telegramGroupId: this.telegramGroupId,
      telegramUserId: this.telegramUserId,
      frequencyFilterPattern: this.frequencyFilterPattern,
      selectedAssociations: this.selectedAssociations,
      activationZoneDistance: this.activationZoneDistance,
      activationZoneAltitude: this.activationZoneAltitude,
    });
  }
}
