import { Injectable } from '@angular/core';

/**
 * Dark-only mode. Always applies `p-dark` to the document element.
 * No light mode toggle.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly isDark = true;

  constructor() {
    document.documentElement.classList.add('p-dark');
  }
}
