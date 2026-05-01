import { Injectable, signal, effect } from '@angular/core';

const STORAGE_KEY = 'sota-dark-mode';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  // Default to dark mode — read stored preference, fall back to true (dark)
  private _dark = signal<boolean>(
    localStorage.getItem(STORAGE_KEY) !== null
      ? localStorage.getItem(STORAGE_KEY) === 'true'
      : true
  );

  readonly isDark = this._dark.asReadonly();

  constructor() {
    // Apply on init
    this.applyTheme(this._dark());

    // Persist and apply on every change
    effect(() => {
      const dark = this._dark();
      localStorage.setItem(STORAGE_KEY, String(dark));
      this.applyTheme(dark);
    });
  }

  toggle(): void {
    this._dark.update(v => !v);
  }

  private applyTheme(dark: boolean): void {
    if (dark) {
      document.documentElement.classList.add('p-dark');
    } else {
      document.documentElement.classList.remove('p-dark');
    }
  }
}
