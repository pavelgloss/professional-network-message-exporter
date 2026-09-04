import type { APIRequestContext } from 'playwright';
import type { DiagnosticsManifest } from '../../io/diagnostics.js';
import type { RawConversation } from '../../domain/schema.js';
import { parseNetworkPayload } from './response-parser.js';
import { assertAllowedReadUrl, readJson } from './read-client.js';

export async function followObservedPagination(request: APIRequestContext, seedUrls: Iterable<string>, manifest: DiagnosticsManifest, maxPages = 30): Promise<RawConversation[]> {
  const queue: string[] = [];
  for (const value of seedUrls) {
    try { queue.push(assertAllowedReadUrl(value).toString()); } catch { manifest.warnings.push('PAGINATION_URL_BLOCKED'); }
  }
  const visited = new Set<string>();
  const conversations: RawConversation[] = [];
  while (queue.length && visited.size < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const payload = await readJson(request, url);
      const parsed = parseNetworkPayload(payload, new URL(url).pathname);
      conversations.push(...parsed.conversations);
      for (const next of parsed.paginationUrls) if (!visited.has(next)) queue.push(next);
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
    } catch { manifest.warnings.push('PAGINATION_READ_FAILED'); }
  }
  manifest.counts.paginationPages = visited.size;
  return conversations;
}

