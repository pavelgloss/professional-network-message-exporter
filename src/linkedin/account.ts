import type { Page } from 'playwright';
import { canonicalLinkedInUrl, cleanText } from '../domain/normalize.js';
import { sha256Id } from '../domain/stable-id.js';

export type Account = { id: string; entityUrn?: string; name: string; profileUrl?: string };

export async function readAccountFromDom(page: Page): Promise<Account> {
  const candidates = [
    'a.global-nav__primary-link-me-menu-trigger',
    '[data-test-global-nav-link="me"]',
    'a[href*="/in/"]:has(img.global-nav__me-photo)',
  ];
  let profileUrl: string | undefined;
  let name: string | undefined;
  for (const selector of candidates) {
    const element = page.locator(selector).first();
    if (await element.count()) {
      profileUrl = canonicalLinkedInUrl(await element.getAttribute('href'));
      name = cleanText(await element.getAttribute('aria-label'))?.replace(/^Me[:,]?\s*/i, '') || undefined;
      const image = element.locator('img').first();
      if (!name && await image.count()) name = cleanText(await image.getAttribute('alt'))?.replace(/'s profile photo$/i, '');
      if (profileUrl || name) break;
    }
  }
  name ??= 'LinkedIn account owner';
  return { id: sha256Id('self', [profileUrl, name]), name, ...(profileUrl ? { profileUrl } : {}) };
}

