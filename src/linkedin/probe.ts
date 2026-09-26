import type { Page, Request } from 'playwright';
import { readFile } from 'node:fs/promises';
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
import { domSelectors } from './dom/selectors.js';

export type ProbeHistoryQuery = NonNullable<DiagnosticsManifest['probeHistoryQueries']>[number];
export type ObservedHistoryGet = {
  url: string;
  headers: Record<string, string>;
  targetIds: string[];
  seedConversations: RawConversation[];
  paginationUrls: string[];
  continuationUrls: string[];
};

async function preferredProbeIds(outputPath: string): Promise<Set<string>> {
  const output = new Set<string>();
  for (const candidatePath of [`${outputPath}.partial`, outputPath]) {
    try {
      const parsed = JSON.parse(await readFile(candidatePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { conversations?: unknown }).conversations)) continue;
      const conversations = (parsed as { conversations: unknown[] }).conversations
        .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
        .sort((left, right) => (Array.isArray(left.messages) ? left.messages.length : Number.POSITIVE_INFINITY)
          - (Array.isArray(right.messages) ? right.messages.length : Number.POSITIVE_INFINITY));
      for (const conversation of conversations) {
        if (!Array.isArray(conversation.messages) || conversation.messages.length < 1
          || conversation.messages.length >= 20 || typeof conversation.url !== 'string') continue;
        const canonical = canonicalUrlView(conversation.url);
        const id = safeRouteConversationId(canonical?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1]);
        if (id) output.add(id);
      }
    } catch { /* A missing/stale local candidate is only a selection hint. */ }
  }
  return output;
}

async function scrollTargetHistoryWithoutReading(page: Page, observedUrlCount: () => number): Promise<number> {
  await page.locator(domSelectors.messageContainers.join(',')).first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
  const baseline = observedUrlCount();
  let scrollableCandidates = 0;
  let stableAfterNewRequest = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    scrollableCandidates = Math.max(scrollableCandidates, await page.evaluate(() => {
      const visible = (element: Element): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && element.scrollHeight > element.clientHeight + 2;
      };
      const candidates = [...document.querySelectorAll('*')].filter(visible);
      for (const element of candidates) {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      return candidates.length;
    }).catch(() => 0));
    await page.waitForTimeout(700);
    if (observedUrlCount() > baseline) {
      stableAfterNewRequest += 1;
      if (stableAfterNewRequest >= 3) break;
    }
  }
  return scrollableCandidates;
}

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
      .map((match) => match[2] === undefined ? match[1]! : `${match[1]}=number`);
    const rawVariables = url.search.match(/(?:^|[?&])variables=([^&]*)/)?.[1] ?? '';
    const encoding = rawVariables.startsWith('(') ? 'restli-raw'
      : /^%28/i.test(rawVariables) ? 'restli-encoded'
        : rawVariables.startsWith('{') ? 'json-raw'
          : /^%7b/i.test(rawVariables) ? 'json-encoded' : 'other';
    const entityTypes = [...variables.matchAll(/urn:li:([A-Za-z][A-Za-z0-9_-]{0,80}):/g)]
      .map((match) => match[1]!).filter((value, index, all) => all.indexOf(value) === index).sort();
    return `format=${encoding};fields=${[...new Set(fields)].slice(0, 40).join(',')};urnTypes=${entityTypes.join(',') || 'none'}`;
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

export function selectSafeProbeConversation(conversations: RawConversation[], preferredIds: ReadonlySet<string> = new Set()): RawConversation {
  const activity = (value: RawConversation['lastActivityAt']): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return Number.POSITIVE_INFINITY;
  };
  const ordered = [...conversations].sort((left, right) => {
    const leftPreferred = [...knownProbeConversationIds(left)].some((id) => preferredIds.has(id));
    const rightPreferred = [...knownProbeConversationIds(right)].some((id) => preferredIds.has(id));
    return Number(rightPreferred) - Number(leftPreferred)
      || activity(left.lastActivityAt) - activity(right.lastActivityAt);
  });
  for (const conversation of ordered) {
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
  const context = await launchContext(config, 'export', manifest, logger, { probe: true });
  const selectionPage = await context.newPage();
  let targetPage: Page | undefined;
  const selectionManifest = createManifest();
  const selectionCapture = attachNetworkCapture(selectionPage, selectionManifest, logger);
  const templates = new Map<string, ProbeHistoryQuery>();
  let targetCapture: ReturnType<typeof attachNetworkCapture> | undefined;
  let requestHandler: ((request: Request) => void) | undefined;
  let observedRequest: Request | undefined;
  const observedRequests = new Map<string, Request>();
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
    const preferredIds = await preferredProbeIds(config.outputPath);
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
    // Local exports may only influence ordering. The selected object and its
    // read evidence must always come from this run's current list response.
    const candidate = selectSafeProbeConversation(selectionCapture.conversations, preferredIds);
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
        observedRequests.set(request.url(), request);
      }
      else {
        const canonical = canonicalUrlView(request.url());
        const decision = probeMessagingRequestPolicy('target', request.method(), request.url(), 'https://www.linkedin.com', candidateIds);
        if (canonical && decision.messaging && !decision.allow) {
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
    manifest.counts.probeTargetScrollableContainers = await scrollTargetHistoryWithoutReading(targetPage, () => observedRequests.size);
    await targetCapture.drain();
    await navigationGate.assertTargetSafe();
    manifest.probeHistoryQueries = [...templates.values()];
    manifest.counts.probeHistoryQueryTemplates = templates.size;
    if (!templates.size) throw new AppError('PARSER_NO_DATA', 'The one-thread probe observed no safe GET history query template', 4);
    if (!observedRequest) throw new AppError('PARSER_NO_DATA', 'The one-thread probe did not retain its validated history GET', 4);
    manifest.counts.probeHistoryRequestUrls = observedRequests.size;
    result = {
      url: observedRequest.url(),
      headers: safeObservedHeaders(await observedRequest.allHeaders()),
      targetIds: [...candidateIds],
      seedConversations: targetCapture.conversations.filter((conversation) =>
        Boolean(conversation.id && candidateIds.has(conversation.id))),
      paginationUrls: [...targetCapture.paginationUrls],
      continuationUrls: [...observedRequests.keys()].filter((url) => url !== observedRequest!.url()),
    };
    for (const url of observedRequests.keys()) {
      const variableShape = safeVariableShape(url);
      if (variableShape) {
        const strategy = `probe-history-variable-shape:${variableShape}`;
        if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy);
      }
      const canonical = canonicalUrlView(url);
      const operation = canonical?.query.find(({ name }) => name === 'queryId')?.value;
      const operationName = operation?.split('.')[0];
      if (operationName && /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(operationName)) {
        const strategy = `probe-history-operation:${operationName}`;
        if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy);
      }
    }
    manifest.counts.probeHistoryParsedConversations = result.seedConversations.length;
    manifest.counts.probeHistoryParsedMessages = result.seedConversations
      .reduce((sum, conversation) => sum + (conversation.messages?.length ?? 0), 0);
    manifest.status = 'success';
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
    await navigationGate?.dispose().catch(() => undefined);
    // Snapshot only after browser shutdown: a lost-frame request may hit the
    // deny transport during dispose/close, and must invalidate a cached result.
    await closeContext(context);
    if (navigationGate) {
      const snapshot = navigationGate.snapshot();
      manifest.counts.probeSelectionNavigations = snapshot.selectionNavigationsAllowed;
      manifest.counts.probeThreadNavigations = snapshot.targetNavigationsAllowed;
      manifest.counts.probeEquivalentThreadNavigations = snapshot.targetEquivalentNavigationsAllowed;
      manifest.counts.probeNavigationAttemptsBlocked = snapshot.navigationAttemptsBlocked;
      manifest.counts.probePopupPagesBlocked = snapshot.popupPagesBlocked;
      manifest.counts.probeCrossThreadRequestsBlocked = snapshot.crossThreadRequestsBlocked;
      manifest.counts.probeSelectionSubrequestsBlocked = snapshot.selectionSubrequestsBlocked;
      manifest.counts.probeSelectionHistoryAttemptsBlocked = snapshot.selectionHistoryAttemptsBlocked;
      manifest.counts.probeSelectionPopupAttemptsBlocked = snapshot.selectionPopupAttemptsBlocked;
      manifest.counts.probeSelectionSameDocumentAttemptsBlocked = snapshot.selectionSameDocumentAttemptsBlocked;
      manifest.counts.probeHardSafetyViolations = snapshot.hardSafetyViolations;
      manifest.counts.probeTransportRequestsDenied = snapshot.transportRequestsDenied;
      manifest.counts.probeSelectionPreflightGets = snapshot.selectionPreflightGets;
      manifest.counts.probeTargetPreflightGets = snapshot.targetPreflightGets;
      manifest.counts.probeSelectionPreflightFailures = snapshot.selectionPreflightFailures;
      manifest.counts.probeTargetPreflightFailures = snapshot.targetPreflightFailures;
      manifest.strategies.push(...snapshot.selectionBlockedRequestShapes
        .map((shape) => `probe-selection-blocked:${shape}`));
      manifest.strategies.push(...snapshot.hardViolationReasons.map((reason) => `probe-hard-reason:${reason}`));
      manifest.strategies.push(...snapshot.apiProxyFailures.map((reason) => `probe-api-proxy-failure:${reason}`));
      if (snapshot.hardSafetyViolations > 0) {
        result = undefined;
        manifest.status = 'READ_POLICY_BLOCK';
      }
    }
    manifest.finishedAt = new Date().toISOString();
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
  if (manifest.counts.probeHardSafetyViolations) throw new AppError('READ_POLICY_BLOCK', 'Probe transport or lifecycle safety failed', 4);
  if (!result) throw new AppError('PARSER_NO_DATA', 'The one-thread probe produced no validated history GET', 4);
  logger.info('read-thread-probe-complete', { threadNavigations: manifest.counts.probeThreadNavigations, historyQueryTemplates: templates.size });
  return result;
}
