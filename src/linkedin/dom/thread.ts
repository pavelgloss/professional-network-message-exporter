import type { Locator, Page } from 'playwright';
import { canonicalLinkedInUrl, cleanText, normalizeTimestamp } from '../../domain/normalize.js';
import { sha256Id } from '../../domain/stable-id.js';
import type { RawMessage } from '../../domain/schema.js';
import { domSelectors } from './selectors.js';

type ThreadLoopOptions = { maxIterations?: number; stagnationLimit?: number; delayMs?: number; timeoutMs?: number };
export type ThreadResult = { messages: RawMessage[]; strategies: string[]; warnings: string[]; scrollReason: 'end' | 'stagnation' | 'timeout'; complete: boolean };

export async function collectThread(page: Page, conversationId: string, conversationUrl: string, selfProfileUrl?: string, selfId?: string): Promise<ThreadResult> {
  const url = canonicalLinkedInUrl(conversationUrl);
  if (!url || !url.includes('/messaging/thread/')) throw new Error('Refusing to open a non-thread URL');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return extractThreadFromPage(page, conversationId, selfProfileUrl, selfId);
}

export async function extractThreadFromPage(page: Page, conversationId: string, selfProfileUrl?: string, selfId?: string, options: ThreadLoopOptions = {}): Promise<ThreadResult> {
  const containerSelector = await firstPresent(page, domSelectors.messageContainers);
  const container = containerSelector ? page.locator(containerSelector).first() : page.locator('main');
  const rowSelector = await firstPresent(container, domSelectors.messageRows);
  if (!rowSelector) return { messages: [], strategies: [], warnings: ['DOM_THREAD_SELECTOR_MISS'], scrollReason: 'stagnation', complete: false };
  const rows = container.locator(rowSelector);
  const accumulated = new Map<string, RawMessage>();
  const warningSet = new Set<string>();
  const startedAt = Date.now();
  const maxIterations = options.maxIterations ?? 80;
  const stagnationLimit = options.stagnationLimit ?? 4;
  let stagnant = 0;
  let reason: ThreadResult['scrollReason'] = 'timeout';
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const before = accumulated.size;
    const snapshot = await parseVisibleMessages(rows, conversationId, selfProfileUrl, selfId);
    const occurrences = new Map<string, number>();
    for (const message of snapshot.messages) {
      const base = message.entityUrn ?? message.id ?? sha256Id('message', [message.conversationId, message.senderId, message.sentAt, message.text]);
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      accumulated.set(`${base}#${occurrence}`, message);
    }
    snapshot.warnings.forEach((warning) => warningSet.add(warning));
    stagnant = accumulated.size > before ? 0 : stagnant + 1;
    if (Date.now() - startedAt >= (options.timeoutMs ?? 90_000)) { reason = 'timeout'; break; }
    const state = await container.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
    if (state.top <= 1 && stagnant >= 2) { reason = 'end'; break; }
    if (stagnant >= stagnationLimit) { reason = 'stagnation'; break; }
    await container.evaluate((element) => { element.scrollTop = Math.max(0, element.scrollTop - Math.max(element.clientHeight * 0.8, 200)); });
    await page.waitForTimeout(options.delayMs ?? 600);
  }
  const messages = [...accumulated.values()].sort((a, b) => (normalizeTimestamp(a.sentAt) ?? '').localeCompare(normalizeTimestamp(b.sentAt) ?? '') || Number(a.sourceOrder ?? 0) - Number(b.sourceOrder ?? 0) || (a.id ?? '').localeCompare(b.id ?? ''));
  messages.forEach((message, index) => { message.sourceOrder = index; });
  return { messages, strategies: [containerSelector ?? 'main', rowSelector], warnings: [...warningSet], scrollReason: reason, complete: Boolean(containerSelector) && reason === 'end' };
}

async function parseVisibleMessages(rows: Locator, conversationId: string, selfProfileUrl?: string, selfId?: string): Promise<{ messages: RawMessage[]; warnings: string[] }> {
  const messages: RawMessage[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
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
    if (!direction) warnings.push(`DIRECTION_UNKNOWN:${explicitId ?? entityUrn ?? index}`);
    const senderId = isSelf && selfId ? selfId : senderProfileUrl || senderName ? sha256Id(isSelf ? 'self' : 'member', [senderProfileUrl, senderName]) : undefined;
    const id = explicitId ?? (entityUrn ? entityUrn.split(':').at(-1) : undefined);
    messages.push({ ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), conversationId, ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}), ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt ? { sentAt } : {}), ...(direction ? { direction } : {}), text, sourceOrder: index });
  }
  return { messages, warnings };
}

async function firstPresent(scope: Page | Locator, selectors: readonly string[]): Promise<string | undefined> {
  for (const selector of selectors) if (await scope.locator(selector).count()) return selector;
  return undefined;
}
