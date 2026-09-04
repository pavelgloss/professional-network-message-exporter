import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { collectConversationList } from '../../src/linkedin/dom/conversation-list.js';
import { extractThreadFromPage } from '../../src/linkedin/dom/thread.js';
import { readAccountFromDom } from '../../src/linkedin/account.js';

describe('DOM fallback against local fixture', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(new URL('../fixtures/dom/messaging.html', import.meta.url).toString());
  });
  afterAll(async () => browser.close());

  it('reads list and messages without activating mutation bait', async () => {
    const list = await collectConversationList(page, 100);
    expect(list.conversations.map((c) => c.id)).toEqual(['conv-a', 'conv-b']);
    const thread = await extractThreadFromPage(page, 'conv-a', 'https://www.linkedin.com/in/account-owner', 'self-id');
    expect(thread.messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
    expect(thread.messages[1]?.senderId).toBe('self-id');
    const canary = await page.evaluate(() => (window as unknown as { mutationCanary?: string }).mutationCanary);
    expect(canary).toBeUndefined();
  });

  it('does not accept a generic LinkedIn navigation URL as a profile identity', async () => {
    await page.setContent('<a class="global-nav__primary-link-me-menu-trigger" href="https://www.linkedin.com/feed/" aria-label="Me: Account"></a>');
    expect((await readAccountFromDom(page)).profileUrl).toBeUndefined();
  });
});
