import type { Page } from 'playwright';
import { canonicalLinkedInUrl, cleanText, normalizeTimestamp } from '../../domain/normalize.js';
import { sha256Id } from '../../domain/stable-id.js';
import type { RawMessage } from '../../domain/schema.js';
import { scrollUntilStable } from '../../browser/scrolling.js';
import { domSelectors } from './selectors.js';

export async function collectThread(page: Page, conversationId: string, conversationUrl: string, selfProfileUrl?: string, selfId?: string): Promise<{ messages: RawMessage[]; strategies: string[]; warnings: string[] }> {
  const url = canonicalLinkedInUrl(conversationUrl);
  if (!url || !url.includes('/messaging/thread/')) throw new Error('Refusing to open a non-thread URL');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return extractThreadFromPage(page, conversationId, selfProfileUrl, selfId);
}

export async function extractThreadFromPage(page: Page, conversationId: string, selfProfileUrl?: string, selfId?: string): Promise<{ messages: RawMessage[]; strategies: string[]; warnings: string[] }> {
  const containerSelector = await firstPresent(page, domSelectors.messageContainers);
  const container = containerSelector ? page.locator(containerSelector).first() : page.locator('main');
  const rowSelector = await firstPresent(container, domSelectors.messageRows);
  if (!rowSelector) return { messages: [], strategies: [], warnings: ['DOM_THREAD_SELECTOR_MISS'] };
  const rows = container.locator(rowSelector);
  await scrollUntilStable(container, async () => rows.count(), { direction: 'up', maxIterations: 80, timeoutMs: 90_000, delayMs: 600 });
  const messages: RawMessage[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    let text: string | undefined;
    for (const selector of domSelectors.messageText) {
      const candidate = row.locator(selector).first();
      if (!await candidate.count()) continue;
      text = cleanText(await candidate.textContent());
      if (text) break;
    }
    if (!text) continue;
    const entityUrn = cleanText(await row.getAttribute('data-event-urn'));
    const explicitId = cleanText(await row.getAttribute('data-message-id'));
    const senderLink = row.locator(domSelectors.senderLink.join(',')).first();
    const senderProfileUrl = await senderLink.count() ? canonicalLinkedInUrl(await senderLink.getAttribute('href') ?? await senderLink.getAttribute('data-sender-profile')) : undefined;
    const senderName = await senderLink.count() ? cleanText(await senderLink.textContent()) ?? cleanText(await senderLink.getAttribute('aria-label')) : undefined;
    const time = row.locator('time').first();
    const sentAt = await time.count() ? normalizeTimestamp(await time.getAttribute('datetime') ?? await time.getAttribute('data-time')) : undefined;
    const className = await row.getAttribute('class') ?? '';
    const selfMarker = await row.getAttribute('data-is-self');
    const isSelf = selfMarker === 'true' || /(?:from-me|is-own|self)/i.test(className) || Boolean(senderProfileUrl && selfProfileUrl && senderProfileUrl === canonicalLinkedInUrl(selfProfileUrl));
    const confidentlyExternal = Boolean(senderProfileUrl && selfProfileUrl && senderProfileUrl !== canonicalLinkedInUrl(selfProfileUrl));
    const direction = isSelf ? 'outbound' as const : confidentlyExternal ? 'inbound' as const : undefined;
    if (!direction) warnings.push(`DIRECTION_UNKNOWN:${explicitId ?? entityUrn ?? i}`);
    const senderId = isSelf && selfId ? selfId : sha256Id(isSelf ? 'self' : 'member', [senderProfileUrl, senderName]);
    const id = explicitId ?? (entityUrn ? entityUrn.split(':').at(-1) : undefined) ?? sha256Id('message', [conversationId, senderId, sentAt, text]);
    messages.push({ id, ...(entityUrn ? { entityUrn } : {}), conversationId, senderId, ...(senderName ? { senderName } : {}), ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt ? { sentAt } : {}), ...(direction ? { direction } : {}), text, sourceOrder: i });
  }
  return { messages, strategies: [containerSelector ?? 'main', rowSelector], warnings };
}

async function firstPresent(scope: Page | ReturnType<Page['locator']>, selectors: readonly string[]): Promise<string | undefined> {
  for (const selector of selectors) if (await scope.locator(selector).count()) return selector;
  return undefined;
}
