import type { Page } from 'playwright';
import { AppError } from '../errors.js';

export type AuthState = 'authenticated' | 'required' | 'challenge';

export async function detectAuthState(page: Page): Promise<AuthState> {
  const url = page.url().toLowerCase();
  if (/\/(checkpoint|challenge)\//.test(url)) return 'challenge';
  if (/\/login|\/uas\//.test(url)) return 'required';
  const captcha = await page.locator('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]').count().catch(() => 0);
  if (captcha > 0) return 'challenge';
  const loginForm = await page.locator('input[name="session_key"], input[name="session_password"], form[action*="login"]').count().catch(() => 0);
  if (loginForm > 0) return 'required';
  const authenticatedUi = await page.locator('a[href*="/messaging"], nav[aria-label], [data-test-global-nav-link="messaging"]').count().catch(() => 0);
  return authenticatedUi > 0 || /\/messaging\//.test(url) ? 'authenticated' : 'required';
}

export function assertAuthenticated(state: AuthState): void {
  if (state === 'challenge') throw new AppError('AUTH_CHALLENGE', 'LinkedIn requires MFA/CAPTCHA. Run: npm run login', 3);
  if (state === 'required') throw new AppError('AUTH_REQUIRED', 'LinkedIn session is missing or expired. Run: npm run login', 3);
}

