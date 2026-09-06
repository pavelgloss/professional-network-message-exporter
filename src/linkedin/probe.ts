import type { Page, Request } from 'playwright';
import type { AppConfig } from '../config.js';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { conversationIdFromUrn, parseLinkedInUrn } from '../domain/stable-id.js';
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
export type ObservedHistoryGet = {
  url: string;
  headers: Record<string, string>;
  targetIds: string[];
  seedConversations: RawConversation[];
  paginationUrls: string[];
};

function safeObservedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    /^(?:accept|accept-language|user-agent|csrf-token|x-li-[a-z0-9-]+|x-restli-protocol-version)$/i.test(name)));
}

function safeVariableShape(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    const raw = url.searchParams.get('variables');
    const variables = raw ? repeatedlyDecodeAndNormalize(raw) : undefined;
    if (!variables) return undefined;
    const fields = [...variables.matchAll(/(?:^|[({,])\s*([A-Za-z][A-Za-z0-9]{0,60})\s*:\s*(-?\d+)?/g)]
      .map((match) => match[2] === undefined ? match[1]! : `${match[1]}=${match[2]}`);
    const rawVariables = url.search.match(/(?:^|[?&])variables=([^&]*)/)?.[1] ?? '';
    const encoding = rawVariables.startsWith('(') ? 'restli-raw'
      : /^%28/i.test(rawVariables) ? 'restli-encoded'
        : rawVariables.startsWith('{') ? 'json-raw'
          : /^%7b/i.test(rawVariables) ? 'json-encoded' : 'other';
    const entityTypes = [...variables.matchAll(/urn:li:([A-Za-z][A-Za-z0-9_-]{0,80}):/g)]
      .map((match) => match[1]!).filter((value, index, all) => all.indexOf(value) === index).sort();
    return `format=${encoding};fields=${[...new Set(fields)].sort().slice(0, 40).join(',')};urnTypes=${entityTypes.join(',') || 'none'}`;
  } catch { return undefined; }
}

function safeKnownId(value: string | undefined): string | undefined {
  const normalized = value ? repeatedlyDecodeAndNormalize(value) : undefined;
  return normalized && (/^[\p{L}\p{N}_.-]+$/u.test(normalized) || /^[A-Za-z0-9._~=-]+$/.test(normalized)) ? normalized : undefined;
}

function safeRouteConversationId(value: string | undefined): string | undefined {
  const normalized = value ? repeatedlyDecodeAndNormalize(value) : undefined;
  return safeKnownId(normalized) ?? safeKnownId(conversationIdFromUrn(normalized));
}

function probeRouteShape(conversation: RawConversation): string {
  const canonical = conversation.url ? canonicalUrlView(conversation.url) : undefined;
  const value = canonical?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1] ?? '';
  if (/^urn:li:/i.test(value)) return 'linkedin-urn';
  if (/^\(/.test(value)) return 'composite';
  if (/^[\p{L}\p{N}_.-]+$/u.test(value)) return 'canonical';
  if (/^[A-Za-z0-9._~=-]+$/.test(value)) return 'extended-ascii';
  return value ? 'other' : 'missing';
}

export function knownProbeConversationIds(conversation: RawConversation): Set<string> {
  const ids = new Set<string>();
  const direct = safeKnownId(conversation.id);
  const urn = safeKnownId(conversationIdFromUrn(conversation.entityUrn));
  if (direct) ids.add(direct);
  if (urn) ids.add(urn);
  if (conversation.url) {
    const canonical = canonicalUrlView(conversation.url);
    const route = safeRouteConversationId(canonical?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1]);
    if (route) ids.add(route);
  }
  return ids;
}

export function assertSafeProbeConversation(conversation: RawConversation): URL {
  const rejected = safeProbeConversationRejection(conversation);
  if (rejected === 'read-evidence' || rejected === 'missing-url') {
    throw new AppError('READ_POLICY_BLOCK', 'Probe requires a network conversation with explicit read=true evidence');
  }
  if (rejected) throw new AppError('READ_POLICY_BLOCK', 'Probe conversation URL was not an exact safe LinkedIn thread URL');
  return canonicalUrlView(conversation.url!)!.url;
}

function safeProbeConversationRejection(conversation: RawConversation): string | undefined {
  if (conversation.sourceMetadata?.read !== true || conversation.sourceMetadata.readEvidence !== 'network-explicit') return 'read-evidence';
  if (!conversation.url) return 'missing-url';
  const canonical = canonicalUrlView(conversation.url);
  if (!canonical) return 'invalid-url';
  if (canonical.url.origin !== 'https://www.linkedin.com' || canonical.url.username || canonical.url.password) return 'origin';
  if (canonical.url.search || canonical.url.hash) return 'decorated-url';
  if (!/^\/messaging\/thread\/[^/]+\/?$/i.test(canonical.pathname)) return 'thread-path';
  if (!requestPolicy('GET', canonical.url.toString()).allow) return 'global-policy';
  const routeId = safeRouteConversationId(canonical.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1]);
  const knownIds = knownProbeConversationIds(conversation);
  const declaredIds = [safeKnownId(conversation.id), safeKnownId(conversationIdFromUrn(conversation.entityUrn))].filter((id): id is string => Boolean(id));
  if (!routeId) return 'route-id';
  if (!declaredIds.length) return 'declared-id';
  if ([...knownIds].some((id) => id !== routeId)) return 'identity-mismatch';
  return undefined;
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

export async function probeReadThread(config: AppConfig, logger: Logger): Promise<ObservedHistoryGet> {
  const manifest = createManifest();
  const context = await launchContext(config, 'export', manifest, logger);
  const selectionPage = await context.newPage();
  let targetPage: Page | undefined;
  const selectionManifest = createManifest();
  const selectionCapture = attachNetworkCapture(selectionPage, selectionManifest, logger);
  const templates = new Map<string, ProbeHistoryQuery>();
  let targetCapture: ReturnType<typeof attachNetworkCapture> | undefined;
  let requestHandler: ((request: Request) => void) | undefined;
  let observedRequest: Request | undefined;
  let result: ObservedHistoryGet | undefined;
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
    // Selection depends solely on the allowlisted list GET. Avoid waiting for
    // or manipulating LinkedIn's mutable DOM: once one response has been parsed,
    // the renderer can be fenced immediately.
    const selectionDeadline = Date.now() + Math.min(8_000, config.timeoutMs);
    do {
      await selectionPage.waitForTimeout(200);
      await selectionCapture.drain();
    } while (!selectionCapture.conversations.length && Date.now() < selectionDeadline);
    manifest.counts.probeObservedListRows = 0;
    // Keep only redacted structural diagnostics from selection. They contain
    // key paths and counts, never message values, identifiers, cookies or bodies.
    manifest.networkResponses = selectionManifest.networkResponses;
    manifest.counts.probeSelectionConversations = selectionCapture.conversations.length;
    manifest.counts.probeExplicitReadConversations = selectionCapture.conversations
      .filter((conversation) => conversation.sourceMetadata?.read === true
        && conversation.sourceMetadata.readEvidence === 'network-explicit').length;
    for (const conversation of selectionCapture.conversations) {
      if (conversation.sourceMetadata?.read !== true || conversation.sourceMetadata.readEvidence !== 'network-explicit') continue;
      const rejection = safeProbeConversationRejection(conversation);
      if (rejection) {
        manifest.counts[`probeCandidateRejected_${rejection}`] = (manifest.counts[`probeCandidateRejected_${rejection}`] ?? 0) + 1;
        const routeShape = probeRouteShape(conversation);
        manifest.counts[`probeCandidateRoute_${routeShape}`] = (manifest.counts[`probeCandidateRoute_${routeShape}`] ?? 0) + 1;
        const identityShape = conversationIdFromUrn(conversation.entityUrn) ? 'typed-urn'
          : safeKnownId(conversation.id) ? 'canonical-id' : conversation.entityUrn ? 'other-urn' : 'missing';
        manifest.counts[`probeCandidateIdentity_${identityShape}`] = (manifest.counts[`probeCandidateIdentity_${identityShape}`] ?? 0) + 1;
        const entityType = parseLinkedInUrn(conversation.entityUrn)?.entityType;
        if (entityType && /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(entityType)) {
          const strategy = `probe-candidate-entity-type:${entityType}`;
          if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy);
        }
      }
    }
    await navigationGate.assertSelectionSafe();
    const candidate = selectSafeProbeConversation(selectionCapture.conversations);
    const targetUrl = assertSafeProbeConversation(candidate);
    const candidateIds = knownProbeConversationIds(candidate);
    // No selection response/listener survives into the target lifecycle.
    selectionCapture.detach();
    targetPage = await navigationGate.armTarget(targetUrl.toString(), candidateIds);
    targetCapture = attachNetworkCapture(targetPage, manifest, logger);

    requestHandler = (request: Request) => {
      const template = observedHistoryQueryTemplate(request.method(), request.url(), candidateIds);
      if (template) {
        templates.set(JSON.stringify(template), template);
        observedRequest ??= request;
      }
      else {
        const canonical = canonicalUrlView(request.url());
        const decision = probeMessagingRequestPolicy('target', request.method(), request.url(), 'https://www.linkedin.com', candidateIds);
        if (canonical && decision.messaging) {
          const operation = canonical.query.find(({ name }) => name === 'queryId')?.value;
          const safeOperation = operation && /^[A-Za-z][A-Za-z0-9_.-]{0,160}$/.test(operation) ? operation : 'opaque';
          const safeMethod = request.method().toUpperCase() === 'GET' ? 'GET' : 'NON_GET';
          const matchingReferences = [...decision.referencedIds].filter((id) => candidateIds.has(id)).length;
          const shape = `probe-target-blocked:method ${safeMethod} path ${redactedPathShape(canonical.pathname)} operation ${safeOperation} references ${decision.referencedIds.size} matching ${matchingReferences}`;
          if (!manifest.strategies.includes(shape) && manifest.strategies.filter((value) => value.startsWith('probe-target-blocked:')).length < 20) {
            manifest.strategies.push(shape);
          }
        }
      }
    };
    targetPage.on('request', requestHandler);
    await navigateOneSafeProbeThread(targetPage, candidate, config.timeoutMs);
    await targetPage.waitForTimeout(Math.min(3_000, config.timeoutMs));
    await targetCapture.drain();
    await navigationGate.assertTargetSafe();
    manifest.probeHistoryQueries = [...templates.values()];
    manifest.counts.probeHistoryQueryTemplates = templates.size;
    if (!templates.size) throw new AppError('PARSER_NO_DATA', 'The one-thread probe observed no safe GET history query template', 4);
    if (!observedRequest) throw new AppError('PARSER_NO_DATA', 'The one-thread probe did not retain its validated history GET', 4);
    result = {
      url: observedRequest.url(),
      headers: safeObservedHeaders(await observedRequest.allHeaders()),
      targetIds: [...candidateIds],
      seedConversations: targetCapture.conversations.filter((conversation) =>
        Boolean(conversation.id && candidateIds.has(conversation.id))),
      paginationUrls: [...targetCapture.paginationUrls],
    };
    const variableShape = safeVariableShape(result.url);
    if (variableShape) manifest.strategies.push(`probe-history-variable-shape:${variableShape}`);
    manifest.counts.probeHistoryParsedConversations = result.seedConversations.length;
    manifest.counts.probeHistoryParsedMessages = result.seedConversations
      .reduce((sum, conversation) => sum + (conversation.messages?.length ?? 0), 0);
    manifest.status = 'success';
    logger.info('read-thread-probe-complete', { threadNavigations: navigationGate.snapshot().targetNavigationsAllowed, historyQueryTemplates: templates.size });
  } catch (error) {
    const safeError = error instanceof AppError ? error : new AppError('READ_POLICY_BLOCK', 'Read-thread probe failed before its safe target could be verified', 4);
    manifest.status = safeError.code;
    throw safeError;
  } finally {
    if (templates.size) {
      manifest.probeHistoryQueries = [...templates.values()];
      manifest.counts.probeHistoryQueryTemplates = templates.size;
    }
    if (requestHandler && targetPage) targetPage.off('request', requestHandler);
    targetCapture?.detach();
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
      manifest.counts.probeSelectionPopupAttemptsBlocked = snapshot.selectionPopupAttemptsBlocked;
      manifest.counts.probeSelectionSameDocumentAttemptsBlocked = snapshot.selectionSameDocumentAttemptsBlocked;
      manifest.counts.probeHardSafetyViolations = snapshot.hardSafetyViolations;
      manifest.counts.probeSelectionPreflightGets = snapshot.selectionPreflightGets;
      manifest.counts.probeTargetPreflightGets = snapshot.targetPreflightGets;
      manifest.counts.probeSelectionPreflightFailures = snapshot.selectionPreflightFailures;
      manifest.counts.probeTargetPreflightFailures = snapshot.targetPreflightFailures;
      manifest.strategies.push(...snapshot.selectionBlockedRequestShapes
        .map((shape) => `probe-selection-blocked:${shape}`));
      manifest.strategies.push(...snapshot.hardViolationReasons.map((reason) => `probe-hard-reason:${reason}`));
      manifest.strategies.push(...snapshot.apiProxyFailures.map((reason) => `probe-api-proxy-failure:${reason}`));
      await navigationGate.dispose().catch(() => undefined);
    }
    manifest.finishedAt = new Date().toISOString();
    await closeContext(context);
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
  if (!result) throw new AppError('PARSER_NO_DATA', 'The one-thread probe produced no validated history GET', 4);
  return result;
}
