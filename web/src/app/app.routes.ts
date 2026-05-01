import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./components/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'map',
    loadComponent: () =>
      import('./components/map/map.component').then(m => m.MapComponent),
    canActivate: [authGuard],
  },
  {
    path: 'alerts',
    loadComponent: () =>
      import('./components/alerts/alerts.component').then(m => m.AlertsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'log',
    loadComponent: () =>
      import('./components/log/log.component').then(m => m.LogComponent),
    canActivate: [authGuard],
  },
  {
    path: 'config',
    loadComponent: () =>
      import('./components/config/config.component').then(m => m.ConfigComponent),
    canActivate: [authGuard],
  },
  {
    path: '',
    redirectTo: 'map',
    pathMatch: 'full',
  },
];
