import type { Page, Response } from 'playwright';
import type { DiagnosticsManifest } from '../../io/diagnostics.js';
import type { Logger } from '../../logger.js';
import type { RawConversation } from '../../domain/schema.js';
import { parseNetworkPayload, type ParsedNetworkData } from './response-parser.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const relevantPath = /\/(voyager\/api|messaging|graphql|conversation|events)/i;

export type NetworkCapture = {
  conversations: RawConversation[];
  accountCandidates: NonNullable<ParsedNetworkData['account']>[];
  paginationUrls: Set<string>;
  drain(): Promise<void>;
  detach(): void;
};

export function attachNetworkCapture(page: Page, manifest: DiagnosticsManifest, logger: Logger): NetworkCapture {
  const conversations: RawConversation[] = [];
  const accountCandidates: NonNullable<ParsedNetworkData['account']>[] = [];
  const paginationUrls = new Set<string>();
  const pending = new Set<Promise<void>>();
  const handle = (response: Response) => {
    const job = consume(response).finally(() => pending.delete(job));
    pending.add(job);
  };
  const consume = async (response: Response) => {
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !relevantPath.test(url.pathname)) return;
    const contentType = response.headers()['content-type'] ?? '';
    const size = Number(response.headers()['content-length'] ?? 0);
    if (!/json|graphql/i.test(contentType) || size > MAX_RESPONSE_BYTES) return;
    try {
      const body = await response.body();
      if (body.byteLength > MAX_RESPONSE_BYTES) { manifest.warnings.push('NETWORK_RESPONSE_TOO_LARGE'); return; }
      const parsed = parseNetworkPayload(JSON.parse(body.toString('utf8')), `${url.origin}${url.pathname}`);
      conversations.push(...parsed.conversations);
      if (parsed.account) accountCandidates.push(parsed.account);
      parsed.paginationUrls.forEach((href) => paginationUrls.add(href));
      parsed.strategies.forEach((strategy) => { if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy); });
      manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
    } catch {
      manifest.counts.responseParseErrors = (manifest.counts.responseParseErrors ?? 0) + 1;
      logger.warn('network-response-skipped', { origin: url.origin, pathname: url.pathname });
    }
  };
  page.on('response', handle);
  return {
    conversations,
    accountCandidates,
    paginationUrls,
    async drain() { await Promise.allSettled([...pending]); },
    detach() { page.off('response', handle); },
  };
}

