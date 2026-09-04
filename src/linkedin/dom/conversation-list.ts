import type { Locator, Page } from 'playwright';
import { canonicalLinkedInUrl, cleanText } from '../../domain/normalize.js';
import { conversationIdFromUrn, sha256Id } from '../../domain/stable-id.js';
import type { RawConversation } from '../../domain/schema.js';
import { scrollUntilStable } from '../../browser/scrolling.js';
import { domSelectors } from './selectors.js';

async function firstAvailable(scope: Page | Locator, selectors: readonly string[]): Promise<{ locator: Locator; strategy: string } | undefined> {
  for (const selector of selectors) {
    const locator = scope.locator(selector);
    if (await locator.count()) return { locator, strategy: selector };
  }
  return undefined;
}

export async function collectConversationList(page: Page, limit: number): Promise<{ conversations: RawConversation[]; strategies: string[]; scrollReason: string }> {
  const containerResult = await firstAvailable(page, domSelectors.conversationContainers);
  const container = containerResult?.locator.first() ?? page.locator('body');
  const rowResult = await firstAvailable(container, domSelectors.conversationRows) ?? await firstAvailable(page, domSelectors.conversationRows);
  if (!rowResult) return { conversations: [], strategies: [], scrollReason: 'no-list-selector' };
  const scroll = await scrollUntilStable(container, async () => rowResult.locator.count(), { target: limit, maxIterations: 80, timeoutMs: 90_000, delayMs: 600 });
  const rows = rowResult.locator;
  const conversations: RawConversation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(await rows.count(), limit); i += 1) {
    const row = rows.nth(i);
    const href = canonicalLinkedInUrl(await row.getAttribute('href'));
    const urn = await row.evaluate((element) => element.closest('[data-entity-urn]')?.getAttribute('data-entity-urn') ?? null);
    const id = conversationIdFromUrn(urn ?? undefined) ?? href?.match(/\/messaging\/thread\/([^/]+)/)?.[1] ?? sha256Id('conversation', [href]);
    if (seen.has(id)) continue;
    seen.add(id);
    let name: string | undefined;
    for (const selector of domSelectors.participantName) {
      const candidate = row.locator(selector).first();
      if (!await candidate.count()) continue;
      const value = cleanText(await candidate.textContent());
      if (value) { name = value; break; }
    }
    let lastActivityAt: string | undefined;
    const time = row.locator(domSelectors.timestamp.join(',')).first();
    if (await time.count()) lastActivityAt = cleanText(await time.getAttribute('datetime'));
    conversations.push({ id, ...(urn ? { entityUrn: urn } : {}), ...(href ? { url: href } : {}), ...(lastActivityAt ? { lastActivityAt } : {}), participants: name ? [{ name }] : [], messages: [] });
  }
  return { conversations, strategies: [containerResult?.strategy ?? 'body', rowResult.strategy], scrollReason: scroll.reason };
}
