import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private _dark = signal(false);
  isDark = this._dark.asReadonly();

  constructor() {
    const saved = localStorage.getItem('sota-dark-mode');
    this._dark.set(saved === 'true');
    this.apply();
  }

  toggle(): void {
    this._dark.update(v => !v);
    localStorage.setItem('sota-dark-mode', String(this._dark()));
    this.apply();
  }

  private apply(): void {
    if (this._dark()) {
      document.documentElement.classList.add('p-dark');
    } else {
      document.documentElement.classList.remove('p-dark');
    }
  }
}
