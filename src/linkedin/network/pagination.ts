import type { APIRequestContext } from 'playwright';
import type { DiagnosticsManifest } from '../../io/diagnostics.js';
import type { RawConversation } from '../../domain/schema.js';
import { parseNetworkPayload } from './response-parser.js';
import { assertAllowedReadUrl, readJson } from './read-client.js';

export type PaginationState = { visited: Set<string>; maxPages: number };
export function createPaginationState(maxPages = 200): PaginationState { return { visited: new Set(), maxPages }; }

export async function followObservedPagination(request: APIRequestContext, seedUrls: Iterable<string>, manifest: DiagnosticsManifest, csrfToken?: string, state = createPaginationState()): Promise<RawConversation[]> {
  const queue: string[] = [];
  for (const value of seedUrls) {
    try { queue.push(assertAllowedReadUrl(value).toString()); } catch { manifest.warnings.push('PAGINATION_URL_BLOCKED'); }
  }
  const conversations: RawConversation[] = [];
  while (queue.length && state.visited.size < state.maxPages) {
    const url = queue.shift()!;
    if (state.visited.has(url)) continue;
    state.visited.add(url);
    try {
      const payload = await readJson(request, url, csrfToken);
      const parsed = parseNetworkPayload(payload, url);
      conversations.push(...parsed.conversations);
      manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
      for (const next of parsed.paginationUrls) if (!state.visited.has(next)) queue.push(next);
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
    } catch { manifest.warnings.push('PAGINATION_READ_FAILED'); }
  }
  if (queue.length && state.visited.size >= state.maxPages) manifest.warnings.push('PAGINATION_BUDGET_EXHAUSTED');
  manifest.counts.paginationPages = state.visited.size;
  return conversations;
}
