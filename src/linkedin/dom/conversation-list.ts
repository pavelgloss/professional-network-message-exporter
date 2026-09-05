import type { Locator, Page } from 'playwright';
import { canonicalLinkedInUrl, cleanText } from '../../domain/normalize.js';
import { conversationIdFromUrn, sha256Id } from '../../domain/stable-id.js';
import type { RawConversation } from '../../domain/schema.js';
import { domSelectors } from './selectors.js';

type DomLoopOptions = { maxIterations?: number; stagnationLimit?: number; delayMs?: number; timeoutMs?: number };
export type ConversationListResult = { conversations: RawConversation[]; strategies: string[]; scrollReason: 'limit' | 'end' | 'stagnation' | 'timeout'; complete: boolean };

async function firstAvailable(scope: Page | Locator, selectors: readonly string[]): Promise<{ locator: Locator; strategy: string } | undefined> {
  for (const selector of selectors) { const locator = scope.locator(selector); if (await locator.count()) return { locator, strategy: selector }; }
  return undefined;
}

async function parseVisibleRows(rows: Locator): Promise<RawConversation[]> {
  const conversations: RawConversation[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const href = canonicalLinkedInUrl(await row.getAttribute('href'));
    const urn = await row.evaluate((element) => element.closest('[data-entity-urn]')?.getAttribute('data-entity-urn') ?? null);
    const id = conversationIdFromUrn(urn ?? undefined) ?? href?.match(/\/messaging\/thread\/([^/]+)/)?.[1];
    // Current LinkedIn list rows are JavaScript-controlled <li> elements without a
    // conversation URL/URN. They are still useful to drive passive list scrolling,
    // but deriving an ID from mutable visible text would create duplicates alongside
    // the authoritative network result.
    if (!id && !href && !urn) continue;
    let name: string | undefined;
    for (const selector of domSelectors.participantName) {
      const candidate = row.locator(selector).first();
      if (!await candidate.count()) continue;
      const value = cleanText(await candidate.textContent());
      if (value) { name = value; break; }
    }
    const time = row.locator(domSelectors.timestamp.join(',')).first();
    const lastActivityAt = await time.count() ? cleanText(await time.getAttribute('datetime')) : undefined;
    conversations.push({ ...(id ? { id } : { id: sha256Id('conversation', [urn, href]) }), ...(urn ? { entityUrn: urn } : {}), ...(href ? { url: href } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), participants: name ? [{ name }] : [], messages: [] });
  }
  return conversations;
}

export async function collectConversationList(page: Page, limit: number, options: DomLoopOptions = {}): Promise<ConversationListResult> {
  await page.locator([...domSelectors.conversationContainers, ...domSelectors.conversationRows].join(',')).first()
    .waitFor({ state: 'attached', timeout: Math.min(options.timeoutMs ?? 90_000, 15_000) }).catch(() => undefined);
  const containerResult = await firstAvailable(page, domSelectors.conversationContainers);
  const container = containerResult?.locator.first() ?? page.locator('body');
  const rowResult = await firstAvailable(container, domSelectors.conversationRows) ?? await firstAvailable(page, domSelectors.conversationRows);
  if (!rowResult) return { conversations: [], strategies: [], scrollReason: 'stagnation', complete: false };
  const accumulated = new Map<string, RawConversation>();
  const startedAt = Date.now();
  let stagnant = 0;
  let maxObservedRows = 0;
  let maxObservedHeight = 0;
  const maxIterations = options.maxIterations ?? 80;
  const stagnationLimit = options.stagnationLimit ?? 4;
  let reason: ConversationListResult['scrollReason'] = 'timeout';
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const before = accumulated.size;
    for (const conversation of await parseVisibleRows(rowResult.locator)) accumulated.set(conversation.id ?? conversation.url!, conversation);
    const observedRows = await rowResult.locator.count();
    const state = await container.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
    const progressed = accumulated.size > before || observedRows > maxObservedRows || state.height > maxObservedHeight;
    stagnant = progressed ? 0 : stagnant + 1;
    maxObservedRows = Math.max(maxObservedRows, observedRows);
    maxObservedHeight = Math.max(maxObservedHeight, state.height);
    if (accumulated.size >= limit || observedRows >= limit) { reason = 'limit'; break; }
    if (Date.now() - startedAt >= (options.timeoutMs ?? 90_000)) { reason = 'timeout'; break; }
    const atBottom = state.top + state.client >= state.height - 2;
    if (atBottom && stagnant >= 2) { reason = 'end'; break; }
    if (stagnant >= stagnationLimit) { reason = 'stagnation'; break; }
    await container.evaluate((element) => { element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(element.clientHeight * 0.8, 200)); });
    await page.waitForTimeout(options.delayMs ?? 600);
  }
  const conversations = [...accumulated.values()].slice(0, limit);
  return { conversations, strategies: [containerResult?.strategy ?? 'body', rowResult.strategy], scrollReason: reason, complete: Boolean(containerResult) && (reason === 'limit' || reason === 'end') };
}
