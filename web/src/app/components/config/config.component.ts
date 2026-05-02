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

interface SelectOption {
  label: string;
  value: string;
}

type RegionsByAssociation = Record<string, string[]>;

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function parseRegionsByAssociation(value: unknown): RegionsByAssociation {
  const obj = parseJsonObject(value);
  const result: RegionsByAssociation = {};
  Object.entries(obj).forEach(([assoc, regions]) => {
    if (!assoc.trim()) return;
    result[assoc.trim()] = Array.isArray(regions)
      ? regions.map(r => String(r).trim()).filter(Boolean)
      : [];
  });
  return result;
}

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

  associationOptions: SelectOption[] = [];
  regionOptions: SelectOption[] = [];
  private regionsByAssociation: RegionsByAssociation = {};

  loading = signal(true);
  saving = signal(false);
  hasChanges = signal(false);
  validationError = signal('');

  // Telegram
  telegramBotToken = '';
  telegramGroupId = '';
  telegramUserId = '';

  // Filters
  frequencyFilterPattern = '';
  selectedAssociations: string[] = [];
  selectedRegions: string[] = [];

  // Activation Zone
  activationZoneDistance = 300;
  activationZoneAltitude = 25;

  private originalJson = '';

  ngOnInit(): void {
    this.apiService.getConfig().subscribe({
      next: cfg => {
        this.telegramBotToken = (cfg['telegramBotToken'] as string) ?? '';
        this.telegramGroupId = (cfg['telegramGroupId'] as string) ?? '';
        this.telegramUserId = (cfg['telegramUserId'] as string) ?? '';
        this.frequencyFilterPattern = (cfg['frequencyFilterPattern'] as string) ?? '';

        const associationValues = parseJsonArray(cfg['sotaAssociationOptions']);
        this.associationOptions = associationValues.map(value => ({ label: value, value }));

        this.regionsByAssociation = parseRegionsByAssociation(cfg['sotaRegionsByAssociation']);

        this.selectedAssociations = parseJsonArray(cfg['sotaAssociations']);

        this.selectedRegions = parseJsonArray(cfg['sotaRegions']);
        this.rebuildRegionOptions();
        this.selectedRegions = this.selectedRegions.filter(r => this.regionOptions.some(opt => opt.value === r));

        this.activationZoneDistance = Number(cfg['activationZoneDistanceMeters'] ?? 300);
        this.activationZoneAltitude = Number(cfg['activationZoneAltitudeDeltaMeters'] ?? 25);
        this.originalJson = this.toJson();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onFormChange(): void {
    this.rebuildRegionOptions();
    this.selectedRegions = this.selectedRegions.filter(r => this.regionOptions.some(opt => opt.value === r));
    this.validationError.set(this.selectedAssociations.length === 0 ? 'Select at least one monitored association.' : '');
    this.hasChanges.set(this.toJson() !== this.originalJson);
  }

  canSave(): boolean {
    return this.hasChanges() && !this.validationError();
  }

  private rebuildRegionOptions(): void {
    const options: SelectOption[] = [];
    this.selectedAssociations.forEach(assoc => {
      const regions = this.regionsByAssociation[assoc] ?? [];
      regions.forEach(region => {
        const value = `${assoc}|${region}`;
        options.push({ label: `${assoc} · ${region}`, value });
      });
    });
    this.regionOptions = options;
  }

  save(): void {
    if (this.selectedAssociations.length === 0) {
      this.validationError.set('Select at least one monitored association.');
      return;
    }
    this.saving.set(true);
    const payload: AppConfig = {
      telegramBotToken: this.telegramBotToken,
      telegramGroupId: this.telegramGroupId,
      telegramUserId: this.telegramUserId,
      frequencyFilterPattern: this.frequencyFilterPattern,
      sotaAssociations: JSON.stringify(this.selectedAssociations),
      sotaRegions: JSON.stringify(this.selectedRegions),
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
      selectedRegions: this.selectedRegions,
      activationZoneDistance: this.activationZoneDistance,
      activationZoneAltitude: this.activationZoneAltitude,
    });
  }
}
