import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const ok = await authService.checkSession();
  if (!ok) {
    router.navigate(['/login']);
    return false;
  }
  return true;
};
