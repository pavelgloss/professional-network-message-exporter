import type { Page, Request } from 'playwright';
import type { AppConfig } from '../config.js';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { conversationIdFromUrn } from '../domain/stable-id.js';
import { AppError } from '../errors.js';
import { closeContext, launchContext } from '../browser/context.js';
import { requestPolicy } from '../browser/request-guard.js';
import { createManifest, queryParameterNames, redactedPathShape, saveManifest, type DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import type { RawConversation } from '../domain/schema.js';
import { assertAuthenticated, detectAuthState } from './auth-check.js';
import { attachNetworkCapture } from './network/capture.js';
import { installProbeNavigationGate, type ProbeNavigationGate } from './probe-navigation.js';
import { probeMessagingRequestPolicy } from './probe-request-policy.js';

export type ProbeHistoryQuery = NonNullable<DiagnosticsManifest['probeHistoryQueries']>[number];

function safeKnownId(value: string | undefined): string | undefined {
  const normalized = value ? repeatedlyDecodeAndNormalize(value) : undefined;
  return normalized && /^[\p{L}\p{N}_.-]+$/u.test(normalized) ? normalized : undefined;
}

export function knownProbeConversationIds(conversation: RawConversation): Set<string> {
  const ids = new Set<string>();
  const direct = safeKnownId(conversation.id);
  const urn = safeKnownId(conversationIdFromUrn(conversation.entityUrn));
  if (direct) ids.add(direct);
  if (urn) ids.add(urn);
  if (conversation.url) {
    const canonical = canonicalUrlView(conversation.url);
    const route = safeKnownId(canonical?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1]);
    if (route) ids.add(route);
  }
  return ids;
}

export function assertSafeProbeConversation(conversation: RawConversation): URL {
  if (conversation.sourceMetadata?.read !== true || conversation.sourceMetadata.readEvidence !== 'network-explicit' || !conversation.url) {
    throw new AppError('READ_POLICY_BLOCK', 'Probe requires a network conversation with explicit read=true evidence');
  }
  const canonical = canonicalUrlView(conversation.url);
  const routeId = safeKnownId(canonical?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1]);
  const knownIds = knownProbeConversationIds(conversation);
  const declaredIds = [safeKnownId(conversation.id), safeKnownId(conversationIdFromUrn(conversation.entityUrn))].filter((id): id is string => Boolean(id));
  if (!canonical || canonical.url.origin !== 'https://www.linkedin.com' || canonical.url.username || canonical.url.password
    || canonical.url.search || canonical.url.hash || !/^\/messaging\/thread\/[^/]+\/?$/i.test(canonical.pathname)
    || !requestPolicy('GET', canonical.url.toString()).allow || !routeId || !declaredIds.length
    || [...knownIds].some((id) => id !== routeId)) {
    throw new AppError('READ_POLICY_BLOCK', 'Probe conversation URL was not an exact safe LinkedIn thread URL');
  }
  return canonical.url;
}

export function selectSafeProbeConversation(conversations: RawConversation[]): RawConversation {
  for (const conversation of conversations) {
    try {
      assertSafeProbeConversation(conversation);
      const ids = knownProbeConversationIds(conversation);
      const conflictingUnread = conversations.some((other) => other !== conversation
        && other.sourceMetadata?.readEvidence === 'network-explicit' && other.sourceMetadata.read === false
        && [...knownProbeConversationIds(other)].some((id) => ids.has(id)));
      if (conflictingUnread) continue;
      return conversation;
    } catch { /* fail closed per candidate */ }
  }
  throw new AppError('READ_POLICY_BLOCK', 'No network conversation with explicit read=true evidence was available for the probe', 4);
}

export function observedHistoryQueryTemplate(method: string, rawUrl: string, knownConversationIds: Iterable<string>): ProbeHistoryQuery | undefined {
  const canonical = canonicalUrlView(rawUrl);
  const targetIds = new Set([...knownConversationIds].map(safeKnownId).filter((id): id is string => Boolean(id)));
  const decision = probeMessagingRequestPolicy('target', method, rawUrl, 'https://www.linkedin.com', targetIds);
  if (!canonical || decision.kind !== 'conversation-history') return undefined;
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
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    throw new AppError('READ_POLICY_BLOCK', 'Probe target navigation failed inside the enforced navigation gate', 4);
  }
}

export async function probeReadThread(config: AppConfig, logger: Logger): Promise<void> {
  const manifest = createManifest();
  const context = await launchContext(config, 'export', manifest, logger);
  const selectionPage = await context.newPage();
  let targetPage: Page | undefined;
  const selectionManifest = createManifest();
  const selectionCapture = attachNetworkCapture(selectionPage, selectionManifest, logger);
  const templates = new Map<string, ProbeHistoryQuery>();
  let requestHandler: ((request: Request) => void) | undefined;
  let navigationGate: ProbeNavigationGate | undefined;
  try {
    logger.info('read-thread-probe-started', { scope: 'one-explicitly-read-network-conversation' });
    const selectionUrl = 'https://www.linkedin.com/messaging/';
    navigationGate = await installProbeNavigationGate(context, selectionPage, selectionUrl);
    try {
      await selectionPage.goto(selectionUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    } catch {
      throw new AppError('READ_POLICY_BLOCK', 'Probe selection navigation failed inside the enforced navigation gate', 4);
    }
    assertAuthenticated(await detectAuthState(selectionPage));
    await selectionPage.waitForTimeout(Math.min(2_000, config.timeoutMs));
    await selectionCapture.drain();
    await navigationGate.assertSelectionSafe();
    const candidate = selectSafeProbeConversation(selectionCapture.conversations);
    const targetUrl = assertSafeProbeConversation(candidate);
    const candidateIds = knownProbeConversationIds(candidate);
    // No selection response/listener survives into the target lifecycle.
    selectionCapture.detach();
    targetPage = await navigationGate.armTarget(targetUrl.toString(), candidateIds);

    requestHandler = (request: Request) => {
      const template = observedHistoryQueryTemplate(request.method(), request.url(), candidateIds);
      if (template) templates.set(JSON.stringify(template), template);
    };
    targetPage.on('request', requestHandler);
    await navigateOneSafeProbeThread(targetPage, candidate, config.timeoutMs);
    await targetPage.waitForTimeout(Math.min(3_000, config.timeoutMs));
    await navigationGate.assertTargetSafe();
    manifest.probeHistoryQueries = [...templates.values()];
    manifest.counts.probeHistoryQueryTemplates = templates.size;
    if (!templates.size) throw new AppError('PARSER_NO_DATA', 'The one-thread probe observed no safe GET history query template', 4);
    manifest.status = 'success';
    logger.info('read-thread-probe-complete', { threadNavigations: navigationGate.snapshot().targetNavigationsAllowed, historyQueryTemplates: templates.size });
  } catch (error) {
    const safeError = error instanceof AppError ? error : new AppError('READ_POLICY_BLOCK', 'Read-thread probe failed before its safe target could be verified', 4);
    manifest.status = safeError.code;
    throw safeError;
  } finally {
    if (requestHandler && targetPage) targetPage.off('request', requestHandler);
    selectionCapture.detach();
    if (navigationGate) {
      const snapshot = navigationGate.snapshot();
      manifest.counts.probeSelectionNavigations = snapshot.selectionNavigationsAllowed;
      manifest.counts.probeThreadNavigations = snapshot.targetNavigationsAllowed;
      manifest.counts.probeNavigationAttemptsBlocked = snapshot.navigationAttemptsBlocked;
      manifest.counts.probePopupPagesBlocked = snapshot.popupPagesBlocked;
      manifest.counts.probeCrossThreadRequestsBlocked = snapshot.crossThreadRequestsBlocked;
      manifest.counts.probeSelectionSubrequestsBlocked = snapshot.selectionSubrequestsBlocked;
      manifest.counts.probeSelectionHistoryAttemptsBlocked = snapshot.selectionHistoryAttemptsBlocked;
      manifest.counts.probeHardSafetyViolations = snapshot.hardSafetyViolations;
      manifest.counts.probeSelectionPreflightGets = snapshot.selectionPreflightGets;
      manifest.counts.probeTargetPreflightGets = snapshot.targetPreflightGets;
      manifest.counts.probeSelectionPreflightFailures = snapshot.selectionPreflightFailures;
      manifest.counts.probeTargetPreflightFailures = snapshot.targetPreflightFailures;
      await navigationGate.dispose().catch(() => undefined);
    }
    manifest.finishedAt = new Date().toISOString();
    await closeContext(context);
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
}
