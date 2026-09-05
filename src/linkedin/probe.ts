import type { Page, Request } from 'playwright';
import type { AppConfig } from '../config.js';
import { canonicalUrlView } from '../domain/url-safety.js';
import { AppError } from '../errors.js';
import { closeContext, launchContext } from '../browser/context.js';
import { requestPolicy } from '../browser/request-guard.js';
import { createManifest, queryParameterNames, redactedPathShape, saveManifest, type DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import type { RawConversation } from '../domain/schema.js';
import { assertAuthenticated, detectAuthState } from './auth-check.js';
import { attachNetworkCapture } from './network/capture.js';
import { isAllowedLinkedInReadPath } from './network/read-policy.js';

export type ProbeHistoryQuery = NonNullable<DiagnosticsManifest['probeHistoryQueries']>[number];

export function assertSafeProbeConversation(conversation: RawConversation): URL {
  if (conversation.sourceMetadata?.read !== true || conversation.sourceMetadata.readEvidence !== 'network-explicit' || !conversation.url) {
    throw new AppError('READ_POLICY_BLOCK', 'Probe requires a network conversation with explicit read=true evidence');
  }
  const canonical = canonicalUrlView(conversation.url);
  if (!canonical || canonical.url.origin !== 'https://www.linkedin.com' || canonical.url.username || canonical.url.password
    || canonical.url.search || canonical.url.hash || !/^\/messaging\/thread\/[^/]+\/?$/i.test(canonical.pathname)
    || !requestPolicy('GET', canonical.url.toString()).allow) {
    throw new AppError('READ_POLICY_BLOCK', 'Probe conversation URL was not an exact safe LinkedIn thread URL');
  }
  return canonical.url;
}

export function selectSafeProbeConversation(conversations: RawConversation[]): RawConversation {
  for (const conversation of conversations) {
    try {
      assertSafeProbeConversation(conversation);
      return conversation;
    } catch { /* fail closed per candidate */ }
  }
  throw new AppError('READ_POLICY_BLOCK', 'No network conversation with explicit read=true evidence was available for the probe', 4);
}

export function observedHistoryQueryTemplate(method: string, rawUrl: string): ProbeHistoryQuery | undefined {
  if (method.toUpperCase() !== 'GET') return undefined;
  const canonical = canonicalUrlView(rawUrl);
  if (!canonical || canonical.url.origin !== 'https://www.linkedin.com' || canonical.url.username || canonical.url.password
    || !isAllowedLinkedInReadPath(canonical.pathname) || !requestPolicy('GET', canonical.url.toString()).allow) return undefined;
  const queryText = canonical.query.map(({ name, value }) => `${name}=${value}`).join('&');
  const restHistory = /^\/voyager\/api\/messaging(?:\/|$)/i.test(canonical.pathname)
    && /(?:history|messages?|events?|conversations?)/i.test(canonical.pathname);
  const graphqlHistory = /^\/voyager\/api\/(?:graphql(?:\/|$)|voyagerMessagingGraphQL\/graphql$)/i.test(canonical.pathname)
    && /(?:history|messages?|events?|conversations?)/i.test(queryText);
  if (!restHistory && !graphqlHistory) return undefined;
  return {
    method: 'GET',
    origin: 'https://www.linkedin.com',
    pathShape: redactedPathShape(canonical.pathname),
    queryParameterNames: queryParameterNames(canonical.url),
  };
}

export async function navigateOneSafeProbeThread(page: Pick<Page, 'goto'>, conversation: RawConversation, timeoutMs: number): Promise<void> {
  const url = assertSafeProbeConversation(conversation);
  // This function contains the probe's only thread-navigation call. It deliberately
  // has no loop, retry, click, DOM extraction, or pagination behavior.
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

export async function probeReadThread(config: AppConfig, logger: Logger): Promise<void> {
  const manifest = createManifest();
  const context = await launchContext(config, 'export', manifest, logger);
  const page = await context.newPage();
  const selectionManifest = createManifest();
  const selectionCapture = attachNetworkCapture(page, selectionManifest, logger);
  const templates = new Map<string, ProbeHistoryQuery>();
  let requestHandler: ((request: Request) => void) | undefined;
  try {
    logger.info('read-thread-probe-started', { scope: 'one-explicitly-read-network-conversation' });
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    assertAuthenticated(await detectAuthState(page));
    await page.waitForTimeout(Math.min(2_000, config.timeoutMs));
    await selectionCapture.drain();
    const candidate = selectSafeProbeConversation(selectionCapture.conversations);
    selectionCapture.detach();

    requestHandler = (request: Request) => {
      const template = observedHistoryQueryTemplate(request.method(), request.url());
      if (template) templates.set(JSON.stringify(template), template);
    };
    page.on('request', requestHandler);
    await navigateOneSafeProbeThread(page, candidate, config.timeoutMs);
    await page.waitForTimeout(Math.min(3_000, config.timeoutMs));
    manifest.probeHistoryQueries = [...templates.values()];
    manifest.counts.probeThreadNavigations = 1;
    manifest.counts.probeHistoryQueryTemplates = templates.size;
    if (!templates.size) throw new AppError('PARSER_NO_DATA', 'The one-thread probe observed no safe GET history query template', 4);
    manifest.status = 'success';
    logger.info('read-thread-probe-complete', { threadNavigations: 1, historyQueryTemplates: templates.size });
  } catch (error) {
    manifest.status = error instanceof AppError ? error.code : 'FAILED';
    throw error;
  } finally {
    if (requestHandler) page.off('request', requestHandler);
    selectionCapture.detach();
    manifest.finishedAt = new Date().toISOString();
    await closeContext(context);
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
}
