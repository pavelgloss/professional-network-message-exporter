import type { Page, Response } from 'playwright';
import type { DiagnosticsManifest } from '../../io/diagnostics.js';
import type { Logger } from '../../logger.js';
import type { RawConversation } from '../../domain/schema.js';
import { parseNetworkPayload, type ParsedNetworkData } from './response-parser.js';
import { contentTypeFamily, jsonStructuralSignature, queryParameterNames, redactedPathShape, type NetworkResponseDiagnostic } from '../../io/diagnostics.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_DIAGNOSTICS = 300;
const relevantPath = /\/(voyager\/api|messaging|graphql|conversation|events)/i;

function increment(manifest: DiagnosticsManifest, key: string): void {
  manifest.counts[key] = (manifest.counts[key] ?? 0) + 1;
}

function recordDiagnostic(manifest: DiagnosticsManifest, diagnostic: NetworkResponseDiagnostic): void {
  if (manifest.networkResponses.length < MAX_RESPONSE_DIAGNOSTICS) manifest.networkResponses.push(diagnostic);
  else increment(manifest, 'networkDiagnosticsDropped');
}

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
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return;
    increment(manifest, 'linkedinResponses');
    const contentType = response.headers()['content-type'] ?? '';
    const declaredSize = Number(response.headers()['content-length'] ?? 0);
    const relevant = relevantPath.test(url.pathname);
    if (relevant) increment(manifest, 'relevantResponses');
    const diagnostic: NetworkResponseDiagnostic = {
      pathShape: redactedPathShape(url.pathname),
      status: response.status(),
      contentTypeFamily: contentTypeFamily(contentType),
      size: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : 0,
      queryParameterNames: queryParameterNames(url),
      relevant,
      outcome: 'pending',
    };
    recordDiagnostic(manifest, diagnostic);
    if (diagnostic.contentTypeFamily !== 'json') {
      diagnostic.outcome = 'content-type-not-json';
      increment(manifest, 'skippedContentType');
      return;
    }
    if (diagnostic.size > MAX_RESPONSE_BYTES) {
      diagnostic.outcome = 'declared-size-too-large';
      increment(manifest, 'skippedDeclaredTooLarge');
      return;
    }
    let body: Buffer;
    try {
      body = await response.body();
      diagnostic.size = body.byteLength;
    } catch {
      diagnostic.outcome = 'body-read-failed';
      increment(manifest, 'responseBodyReadErrors');
      logger.warn('network-response-skipped', { pathShape: diagnostic.pathShape, reason: diagnostic.outcome });
      return;
    }
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      diagnostic.outcome = 'body-size-too-large';
      increment(manifest, 'skippedBodyTooLarge');
      manifest.warnings.push('NETWORK_RESPONSE_TOO_LARGE');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
      diagnostic.jsonStructure = jsonStructuralSignature(payload);
    } catch {
      diagnostic.outcome = 'json-parse-failed';
      increment(manifest, 'responseParseErrors');
      logger.warn('network-response-skipped', { pathShape: diagnostic.pathShape, reason: diagnostic.outcome });
      return;
    }
    if (!relevant) {
      diagnostic.outcome = 'path-not-relevant';
      increment(manifest, 'skippedIrrelevantPath');
      return;
    }
    try {
      let observedMethod: string | undefined;
      try { observedMethod = response.request().method(); } catch { /* unavailable synthetic response */ }
      const parsed = parseNetworkPayload(payload, response.url(), observedMethod ? { observedMethod } : {});
      conversations.push(...parsed.conversations);
      if (parsed.account) accountCandidates.push(parsed.account);
      parsed.paginationUrls.forEach((href) => paginationUrls.add(href));
      parsed.strategies.forEach((strategy) => { if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy); });
      manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
      const parserOutput = {
        conversations: parsed.conversations.length,
        messages: parsed.conversations.reduce((sum, conversation) => sum + (conversation.messages?.length ?? 0), 0),
        participants: parsed.conversations.reduce((sum, conversation) => sum + (conversation.participants?.length ?? 0), 0),
        paginationUrls: parsed.paginationUrls.length,
        misses: parsed.misses,
        accounts: parsed.account ? 1 : 0,
      };
      diagnostic.parserOutput = parserOutput;
      diagnostic.outcome = 'parsed';
      increment(manifest, 'parsedResponses');
      manifest.counts.parserConversations = (manifest.counts.parserConversations ?? 0) + parserOutput.conversations;
      manifest.counts.parserMessages = (manifest.counts.parserMessages ?? 0) + parserOutput.messages;
      manifest.counts.parserParticipants = (manifest.counts.parserParticipants ?? 0) + parserOutput.participants;
      manifest.counts.parserPaginationUrls = (manifest.counts.parserPaginationUrls ?? 0) + parserOutput.paginationUrls;
    } catch {
      diagnostic.outcome = 'parser-failed';
      increment(manifest, 'responseParseErrors');
      logger.warn('network-response-skipped', { pathShape: diagnostic.pathShape, reason: diagnostic.outcome });
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
