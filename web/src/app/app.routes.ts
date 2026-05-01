import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'map', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () =>
      import('./components/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'map',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./components/map/map.component').then(m => m.MapComponent),
  },
  {
    path: 'alerts',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./components/alerts/alerts.component').then(
        m => m.AlertsComponent,
      ),
  },
  {
    path: 'config',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./components/config/config.component').then(
        m => m.ConfigComponent,
      ),
  },
  { path: '**', redirectTo: 'map' },
];
