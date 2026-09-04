import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { collectConversationList } from '../../src/linkedin/dom/conversation-list.js';
import { extractThreadFromPage } from '../../src/linkedin/dom/thread.js';

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
    const thread = await extractThreadFromPage(page, 'conv-a', 'https://www.linkedin.com/in/account-owner');
    expect(thread.messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
    const canary = await page.evaluate(() => (window as unknown as { mutationCanary?: string }).mutationCanary);
    expect(canary).toBeUndefined();
  });
});
