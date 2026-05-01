import { Injectable, signal } from '@angular/core';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  SignInInput,
} from 'aws-amplify/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private _authenticated = signal(false);
  isAuthenticated = this._authenticated.asReadonly();

  async checkSession(): Promise<boolean> {
    try {
      await getCurrentUser();
      this._authenticated.set(true);
      return true;
    } catch {
      this._authenticated.set(false);
      return false;
    }
  }

  async login(email: string, password: string): Promise<void> {
    const input: SignInInput = { username: email, password };
    const result = await signIn(input);
    if (result.isSignedIn) {
      this._authenticated.set(true);
    } else {
      throw new Error('Sign-in incomplete: ' + result.nextStep?.signInStep);
    }
  }

  async logout(): Promise<void> {
    await signOut();
    this._authenticated.set(false);
  }

  async getIdToken(): Promise<string | undefined> {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString();
  }
}
