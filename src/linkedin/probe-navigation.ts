import { request as playwrightRequest, type APIResponse, type BrowserContext, type CDPSession, type Page, type Request, type Route } from 'playwright';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { redactedPathShape } from '../domain/url-redaction.js';
import { AppError } from '../errors.js';
import { isProbeThreadUrl, parseProbeConversationReferences, probeMessagingRequestPolicy } from './probe-request-policy.js';

export type ProbeNavigationSnapshot = {
  selectionNavigationsAllowed: number;
  targetNavigationsAllowed: number;
  navigationAttemptsBlocked: number;
  popupPagesBlocked: number;
  crossThreadRequestsBlocked: number;
  selectionSubrequestsBlocked: number;
  selectionHistoryAttemptsBlocked: number;
  selectionPopupAttemptsBlocked: number;
  selectionSameDocumentAttemptsBlocked: number;
  hardSafetyViolations: number;
  selectionPreflightGets: number;
  targetPreflightGets: number;
  selectionPreflightFailures: number;
  targetPreflightFailures: number;
  selectionBlockedRequestShapes: string[];
};

export type ProbeNavigationGate = {
  assertSelectionSafe(): Promise<void>;
  armTarget(targetUrl: string, knownConversationIds: Iterable<string>): Promise<Page>;
  assertTargetSafe(): Promise<void>;
  snapshot(): ProbeNavigationSnapshot;
  dispose(): Promise<void>;
};

type Phase = 'selection' | 'closing-selection' | 'target-preflight' | 'armed' | 'target-used' | 'failed';
type CachedDocument = { status: 200; headers: Record<string, string>; body: Buffer };
const MAX_PROBE_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_PROBE_API_BYTES = 16 * 1024 * 1024;

function exactCanonicalLocation(rawUrl: string): string | undefined {
  const canonical = canonicalUrlView(rawUrl);
  if (!canonical || canonical.url.username || canonical.url.password || canonical.url.hash) return undefined;
  const query = canonical.query.map(({ name, value }) => `${name}=${value}`).join('&');
  return `${canonical.url.origin}${canonical.pathname}${query ? `?${query}` : ''}`;
}

function normalizedId(value: string): string | undefined {
  const normalized = repeatedlyDecodeAndNormalize(value);
  return normalized && /^[\p{L}\p{N}_.-]+$/u.test(normalized) ? normalized : undefined;
}

export function explicitProbeGraphqlConversationIds(method: string, rawUrl: string): Set<string> {
  const canonical = canonicalUrlView(rawUrl);
  if (method.toUpperCase() !== 'GET' || !canonical || canonical.url.origin !== 'https://www.linkedin.com'
    || canonical.pathname !== '/voyager/api/voyagerMessagingGraphQL/graphql') return new Set();
  const references = parseProbeConversationReferences(canonical.query);
  return references.valid ? references.ids : new Set();
}

type ProbePageState = {
  href: string;
  historyBlocked: boolean;
  historyAttemptsBlocked: number;
  popupAttemptsBlocked: number;
  hardClientViolation: boolean;
  guardReady: boolean;
};

async function probePageState(page: Page): Promise<ProbePageState | undefined> {
  try {
    return await page.evaluate(() => ({
      href: location.href,
      historyBlocked: Boolean((globalThis as typeof globalThis & { __linkedinReaderProbeHistoryBlocked?: boolean }).__linkedinReaderProbeHistoryBlocked),
      historyAttemptsBlocked: Number((globalThis as typeof globalThis & { __linkedinReaderProbeHistoryAttemptsBlocked?: number }).__linkedinReaderProbeHistoryAttemptsBlocked ?? 0),
      popupAttemptsBlocked: Number((globalThis as typeof globalThis & { __linkedinReaderProbePopupAttemptsBlocked?: number }).__linkedinReaderProbePopupAttemptsBlocked ?? 0),
      hardClientViolation: Boolean((globalThis as typeof globalThis & { __linkedinReaderProbeHardClientViolation?: boolean }).__linkedinReaderProbeHardClientViolation),
      guardReady: Boolean((globalThis as typeof globalThis & { __linkedinReaderProbeGuardReady?: boolean }).__linkedinReaderProbeGuardReady),
    }));
  } catch { return undefined; }
}

async function cacheSafeDocument(response: APIResponse, expectedLocation: string): Promise<CachedDocument | undefined> {
  const headers = response.headers();
  if (response.status() !== 200 || headers.location || exactCanonicalLocation(response.url()) !== expectedLocation) return undefined;
  const contentType = headers['content-type'] ?? '';
  if (!/^text\/html(?:;|$)/i.test(contentType)) return undefined;
  const declaredSize = Number(headers['content-length'] ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PROBE_DOCUMENT_BYTES) return undefined;
  const body = await response.body();
  if (body.byteLength > MAX_PROBE_DOCUMENT_BYTES) return undefined;
  // Never forward Set-Cookie, Location, authentication, tracing, or opaque
  // headers from the preflight response into the synthetic browser document.
  const safeHeaders: Record<string, string> = { 'content-type': contentType };
  for (const name of ['content-language', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) {
    if (headers[name]) safeHeaders[name] = headers[name];
  }
  return { status: 200, headers: safeHeaders, body };
}

async function isolatedCachedDocument(context: BrowserContext, rawUrl: string, expectedLocation: string): Promise<CachedDocument | undefined> {
  // APIRequestContext receives a copy of the auth state. Response Set-Cookie
  // processing is confined to this short-lived context and can never mutate the
  // probe browser's cookie jar.
  const storageState = await context.storageState();
  const isolated = await playwrightRequest.newContext({ storageState });
  let response: APIResponse | undefined;
  try {
    response = await isolated.get(rawUrl, { maxRedirects: 0, failOnStatusCode: false });
    return await cacheSafeDocument(response, expectedLocation);
  } catch {
    return undefined;
  } finally {
    await response?.dispose().catch(() => undefined);
    await isolated.dispose().catch(() => undefined);
  }
}

async function isolatedApiResponse(context: BrowserContext, browserRequest: Request): Promise<CachedDocument | undefined> {
  const storageState = await context.storageState();
  const originalHeaders = await browserRequest.allHeaders();
  const headers = Object.fromEntries(Object.entries(originalHeaders).filter(([name]) =>
    /^(?:accept|accept-language|user-agent|referer|origin|csrf-token|x-li-[a-z0-9-]+|x-restli-protocol-version)$/i.test(name)));
  const isolated = await playwrightRequest.newContext({ storageState });
  let response: APIResponse | undefined;
  try {
    response = await isolated.get(browserRequest.url(), { headers, maxRedirects: 0, failOnStatusCode: false });
    const responseHeaders = response.headers();
    const contentType = responseHeaders['content-type'] ?? '';
    const declaredSize = Number(responseHeaders['content-length'] ?? 0);
    if (response.status() !== 200 || responseHeaders.location || !/(?:json|graphql)/i.test(contentType)
      || (Number.isFinite(declaredSize) && declaredSize > MAX_PROBE_API_BYTES)) return undefined;
    const body = await response.body();
    if (body.byteLength > MAX_PROBE_API_BYTES) return undefined;
    return { status: 200, headers: { 'content-type': contentType }, body };
  } catch {
    return undefined;
  } finally {
    await response?.dispose().catch(() => undefined);
    await isolated.dispose().catch(() => undefined);
  }
}

async function retireSelectionPage(session: CDPSession, page: Page): Promise<boolean> {
  // Never close the live selection renderer directly: Chromium can race a
  // timer-dispatched fetch past route teardown. Its CDP fence is prepared before
  // selection starts. Block every URL at the target network layer, terminate the
  // old JS execution, and replace the document with local about:blank while the
  // context route remains installed. The retired blank Page stays alive until
  // the whole isolated context is closed.
  try {
    await session.send('Network.setBlockedURLs', { urls: ['*'] });
    await session.send('Runtime.terminateExecution');
    const navigation = await session.send('Page.navigate', { url: 'about:blank' });
    if (navigation.errorText) return false;
    await page.waitForURL('about:blank', { waitUntil: 'commit', timeout: 5_000 });
    const state = await probePageState(page);
    return !page.isClosed() && page.url() === 'about:blank' && page.frames().length === 1
      && state?.href === 'about:blank' && state.guardReady && !state.historyBlocked;
  } catch {
    return false;
  }
}

export async function installProbeNavigationGate(context: BrowserContext, selectionPage: Page, selectionUrl: string): Promise<ProbeNavigationGate> {
  const selectionLocation = exactCanonicalLocation(selectionUrl);
  if (!selectionLocation) throw new AppError('READ_POLICY_BLOCK', 'Probe selection URL was ambiguous');
  const expectedOrigin = new URL(selectionLocation).origin;
  let phase: Phase = 'selection';
  let selectionDocument: CachedDocument | undefined;
  let targetLocation: string | undefined;
  let targetIds = new Set<string>();
  let targetDocument: CachedDocument | undefined;
  let targetPage: Page | undefined;
  let hardViolated = false;
  let historyViolationReported = false;
  let expectedTargetPageCreation = false;
  let internallyCreatedPage: Page | undefined;
  let selectionSession: CDPSession | undefined;
  const counts: ProbeNavigationSnapshot = {
    selectionNavigationsAllowed: 0,
    targetNavigationsAllowed: 0,
    navigationAttemptsBlocked: 0,
    popupPagesBlocked: 0,
    crossThreadRequestsBlocked: 0,
    selectionSubrequestsBlocked: 0,
    selectionHistoryAttemptsBlocked: 0,
    selectionPopupAttemptsBlocked: 0,
    selectionSameDocumentAttemptsBlocked: 0,
    hardSafetyViolations: 0,
    selectionPreflightGets: 1,
    targetPreflightGets: 0,
    selectionPreflightFailures: 0,
    targetPreflightFailures: 0,
    selectionBlockedRequestShapes: [],
  };

  const markHardViolation = (): void => {
    hardViolated = true;
    phase = 'failed';
    selectionDocument = undefined;
    targetDocument = undefined;
    counts.hardSafetyViolations += 1;
  };

  try {
    selectionSession = await context.newCDPSession(selectionPage);
    await selectionSession.send('Network.enable');
  } catch {
    throw new AppError('READ_POLICY_BLOCK', 'Probe could not prepare the selection network fence', 4);
  }

  selectionDocument = await isolatedCachedDocument(context, selectionUrl, selectionLocation);
  if (!selectionDocument) {
    counts.selectionPreflightFailures += 1;
    markHardViolation();
  }

  await context.exposeBinding('__linkedinReaderProbeReportHistoryViolation', ({ page: sourcePage }, kind: unknown) => {
    if (sourcePage !== selectionPage && sourcePage !== targetPage) return;
    if (sourcePage === selectionPage && (kind === 'history' || kind === 'popup' || kind === 'same-document')) {
      if (kind === 'history') counts.selectionHistoryAttemptsBlocked += 1;
      else if (kind === 'popup') counts.selectionPopupAttemptsBlocked += 1;
      else counts.selectionSameDocumentAttemptsBlocked += 1;
      return;
    }
    historyViolationReported = true;
    markHardViolation();
  });

  await context.addInitScript(() => {
    const state = globalThis as typeof globalThis & {
      __linkedinReaderProbeHistoryBlocked?: boolean;
      __linkedinReaderProbeHistoryAttemptsBlocked?: number;
      __linkedinReaderProbePopupAttemptsBlocked?: number;
      __linkedinReaderProbeHardClientViolation?: boolean;
      __linkedinReaderProbeGuardReady?: boolean;
      __linkedinReaderProbeReportHistoryViolation?: (kind: 'history' | 'same-document' | 'popup') => Promise<void>;
    };
    let blocked = false;
    let historyAttemptsBlocked = 0;
    let popupAttemptsBlocked = 0;
    let hardClientViolation = false;
    const reportViolation = state.__linkedinReaderProbeReportHistoryViolation;
    if (reportViolation) {
      Object.defineProperty(state, '__linkedinReaderProbeReportHistoryViolation', {
        configurable: false,
        writable: false,
        value: reportViolation,
      });
    }
    const rememberViolation = (kind: 'history' | 'same-document' | 'popup') => {
      blocked = true;
      if (kind === 'history') historyAttemptsBlocked += 1;
      else if (kind === 'popup') popupAttemptsBlocked += 1;
      else hardClientViolation = true;
      void reportViolation?.(kind).catch(() => undefined);
    };
    Object.defineProperty(state, '__linkedinReaderProbeHistoryBlocked', { configurable: false, get: () => blocked, set: () => undefined });
    Object.defineProperty(state, '__linkedinReaderProbeHistoryAttemptsBlocked', { configurable: false, get: () => historyAttemptsBlocked, set: () => undefined });
    Object.defineProperty(state, '__linkedinReaderProbePopupAttemptsBlocked', { configurable: false, get: () => popupAttemptsBlocked, set: () => undefined });
    Object.defineProperty(state, '__linkedinReaderProbeHardClientViolation', { configurable: false, get: () => hardClientViolation, set: () => undefined });
    const patch = (name: 'pushState' | 'replaceState') => {
      const original = History.prototype[name];
      const guarded = (function (this: History, ...args: Parameters<History['pushState']>) {
        const destination = args[2];
        if (destination === undefined || new URL(String(destination), location.href).href === location.href) {
          return Reflect.apply(original, this, args);
        }
        rememberViolation('history');
        throw new DOMException('Probe blocked client-side navigation', 'SecurityError');
      }) as History[typeof name];
      Object.defineProperty(History.prototype, name, { configurable: false, writable: false, value: guarded });
      Object.defineProperty(history, name, { configurable: false, writable: false, value: guarded });
    };
    patch('pushState');
    patch('replaceState');
    const initialHref = location.href;
    const rememberSameDocumentNavigation = () => {
      if (location.href !== initialHref) rememberViolation('same-document');
    };
    addEventListener('hashchange', rememberSameDocumentNavigation, true);
    addEventListener('popstate', rememberSameDocumentNavigation, true);
    const guardedOpen = (() => {
      rememberViolation('popup');
      return null;
    }) as typeof window.open;
    Object.defineProperty(window, 'open', { configurable: false, writable: false, value: guardedOpen });
    Object.defineProperty(state, '__linkedinReaderProbeGuardReady', { configurable: false, writable: false, value: true });
  });

  const popupHandler = (opened: Page) => {
    if (opened === selectionPage || opened === targetPage) return;
    if (expectedTargetPageCreation && !internallyCreatedPage && opened.url() === 'about:blank') {
      internallyCreatedPage = opened;
      return;
    }
    markHardViolation();
    counts.popupPagesBlocked += 1;
    void opened.close().catch(() => undefined);
  };
  context.on('page', popupHandler);

  const block = async (route: Route, kind: 'navigation' | 'cross-thread' | 'subrequest', fatal = true): Promise<void> => {
    if (fatal) markHardViolation();
    const navigation = route.request().isNavigationRequest();
    try {
      await route.abort('blockedbyclient');
      if (navigation) counts.navigationAttemptsBlocked += 1;
      if (kind === 'cross-thread') counts.crossThreadRequestsBlocked += 1;
      if (!fatal) counts.selectionSubrequestsBlocked += 1;
    } catch {
      // A tolerated attempt is only safe after Playwright confirms the abort.
      // Any inability to abort becomes terminal and the cached target is lost.
      if (!fatal) markHardViolation();
    }
  };

  const blockedMessagingAttemptIsFatal = (request: Request): boolean =>
    !['selection', 'closing-selection'].includes(phase) || request.isNavigationRequest();
  const selectionIsClosing = (): boolean => phase === 'closing-selection';

  const mainPageNavigation = (route: Route, expectedPage: Page): boolean => {
    const navigationRequest = route.request();
    if (!navigationRequest.isNavigationRequest()) return false;
    try { return navigationRequest.frame() === expectedPage.mainFrame() && navigationRequest.frame().page() === expectedPage; }
    catch { return false; }
  };

  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const location = exactCanonicalLocation(request.url());
    if (phase === 'selection' && counts.selectionNavigationsAllowed === 0 && location === selectionLocation
      && selectionDocument && mainPageNavigation(route, selectionPage)) {
      counts.selectionNavigationsAllowed += 1;
      const document = selectionDocument;
      selectionDocument = undefined;
      await route.fulfill(document);
      return;
    }
    if (phase === 'armed' && counts.targetNavigationsAllowed === 0 && location === targetLocation
      && targetDocument && targetPage && mainPageNavigation(route, targetPage)) {
      // The old selection execution lifecycle is already closed. The sole
      // target exception consumes the cache synchronously from one internally
      // created pristine about:blank page; there is no browser timer barrier.
      if (hardViolated || historyViolationReported || targetPage.url() !== 'about:blank'
        || targetPage.frames().length !== 1 || selectionPage.url() !== 'about:blank'
        || context.pages().length !== 2
        || context.pages().some((candidate) => candidate !== targetPage && candidate !== selectionPage)) {
        await block(route, 'cross-thread');
        return;
      }
      counts.targetNavigationsAllowed += 1;
      phase = 'target-used';
      const document = targetDocument;
      targetDocument = undefined;
      await route.fulfill(document);
      return;
    }

    // Once final selection validation starts, every late subrequest is aborted
    // while the old page is being destroyed. Non-navigation cancellation is
    // safe and nonfatal; navigations remain hard failures. Nothing is proxied.
    if (phase === 'closing-selection') {
      const messaging = isProbeThreadUrl(request.url(), expectedOrigin)
        || probeMessagingRequestPolicy('selection', request.method(), request.url(), expectedOrigin, targetIds).messaging;
      await block(route, messaging ? 'cross-thread' : request.isNavigationRequest() ? 'navigation' : 'subrequest', request.isNavigationRequest());
      return;
    }

    // A thread route is never allowed onto the wire, for any resource type or
    // frame. The sole target document exception was fulfilled from memory above.
    if (isProbeThreadUrl(request.url(), expectedOrigin)) {
      await block(route, 'cross-thread', blockedMessagingAttemptIsFatal(request));
      return;
    }

    const decision = probeMessagingRequestPolicy(phase === 'selection' ? 'selection' : 'target', request.method(), request.url(), expectedOrigin, targetIds);
    if (decision.messaging) {
      if (!decision.allow) {
        if (phase === 'selection' && counts.selectionBlockedRequestShapes.length < 20) {
          const canonical = canonicalUrlView(request.url());
          const operation = canonical?.query.find(({ name }) => name === 'queryId')?.value;
          const safeOperation = operation && /^[A-Za-z][A-Za-z0-9_.-]{0,160}$/.test(operation)
            ? operation : 'opaque';
          const shape = `path ${redactedPathShape(canonical?.pathname ?? '')} operation ${safeOperation}`;
          if (!counts.selectionBlockedRequestShapes.includes(shape)) counts.selectionBlockedRequestShapes.push(shape);
        }
        await block(route, 'cross-thread', blockedMessagingAttemptIsFatal(request));
        return;
      }
      const requestPhase = phase;
      const response = await isolatedApiResponse(context, request);
      if (response && !hardViolated && phase === requestPhase) await route.fulfill(response);
      else if (requestPhase === 'selection' && selectionIsClosing() && !request.isNavigationRequest()) {
        await block(route, 'cross-thread', false);
      }
      // An allowlisted request whose isolated response is not an exact safe
      // response (including a redirect) is a hard failure in every phase.
      else await block(route, 'cross-thread');
      return;
    }

    // No frame may navigate away from either cached document. Ordinary
    // non-messaging subresources still pass through the global read-only guard.
    if (request.isNavigationRequest()) {
      // A denied ordinary child-frame navigation cannot escape the route or
      // reach the wire. Only a main-page navigation changes the trusted probe
      // document and is therefore terminal. Messaging/thread frames were
      // already handled by the stricter branch above and remain terminal.
      const mainPage = mainPageNavigation(route, selectionPage)
        || Boolean(targetPage && mainPageNavigation(route, targetPage));
      await block(route, 'navigation', mainPage);
      return;
    }
    await route.fallback();
  };
  const pendingRoutes = new Set<Promise<void>>();
  const trackedRouteHandler = (route: Route): Promise<void> => {
    const task = routeHandler(route).finally(() => pendingRoutes.delete(task));
    pendingRoutes.add(task);
    return task;
  };
  await context.route('**/*', trackedRouteHandler);

  const drainRoutes = async (): Promise<void> => {
    while (pendingRoutes.size) await Promise.allSettled([...pendingRoutes]);
  };

  const pageMatches = async (candidatePage: Page, expected: string): Promise<boolean> => {
    if (hardViolated) return false;
    const state = await probePageState(candidatePage);
    // This second hard-state read closes races while page.evaluate was pending.
    if (candidatePage === selectionPage && state) {
      counts.selectionHistoryAttemptsBlocked = Math.max(counts.selectionHistoryAttemptsBlocked, state.historyAttemptsBlocked);
      counts.selectionPopupAttemptsBlocked = Math.max(counts.selectionPopupAttemptsBlocked, state.popupAttemptsBlocked);
    }
    if (candidatePage === selectionPage && phase === 'selection') {
      const current = state ? canonicalUrlView(state.href) : undefined;
      return !hardViolated && Boolean(state?.guardReady && current
        && current.url.origin === expectedOrigin && !current.url.username && !current.url.password);
    }
    const toleratedSelectionClientAttempt = candidatePage === selectionPage && phase === 'selection'
      && Boolean(state && !state.hardClientViolation
        && state.historyAttemptsBlocked + state.popupAttemptsBlocked > 0);
    return !hardViolated && Boolean(state?.guardReady && exactCanonicalLocation(state.href) === expected
      && !state.hardClientViolation && (!state.historyBlocked || toleratedSelectionClientAttempt));
  };

  const selectionReady = (): boolean => phase === 'selection' && !hardViolated
    && !selectionPage.isClosed() && counts.selectionNavigationsAllowed === 1;

  return {
    async assertSelectionSafe() {
      // The selection document is untrusted SPA code. Its local execution
      // context may churn while lazy modules mount, so page.evaluate is not a
      // safety boundary here. Node-side routing proves the only material facts:
      // one exact cached document, no later browser navigation/popup, and every
      // denied messaging request aborted before the wire. The renderer is fenced
      // and retired before any target preflight.
      if (!selectionReady()) {
        if (!hardViolated) markHardViolation();
        throw new AppError('READ_POLICY_BLOCK', 'Probe selection navigation did not remain within its exact safe target', 4);
      }
    },
    async armTarget(targetUrl, knownConversationIds) {
      if (phase !== 'selection' || counts.selectionNavigationsAllowed !== 1 || hardViolated) {
        throw new AppError('READ_POLICY_BLOCK', 'Probe target could not be armed after an unsafe selection navigation', 4);
      }
      const location = exactCanonicalLocation(targetUrl);
      const providedIds = [...knownConversationIds];
      const normalizedIds = providedIds.map(normalizedId);
      const ids = new Set(normalizedIds.filter((id): id is string => Boolean(id)));
      const routeId = location ? normalizedId(canonicalUrlView(location)?.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/)?.[1] ?? '') : undefined;
      if (!location || new URL(location).origin !== expectedOrigin || !routeId || !providedIds.length
        || normalizedIds.some((id) => !id) || !ids.has(routeId) || [...ids].some((id) => id !== routeId)) {
        throw new AppError('READ_POLICY_BLOCK', 'Probe target URL or identity was ambiguous', 4);
      }
      // Revalidate at the boundary even if the caller already asserted the
      // selection page before choosing a candidate.
      if (!selectionReady()) {
        if (!hardViolated) markHardViolation();
        throw new AppError('READ_POLICY_BLOCK', 'Probe target could not be armed after the selection page changed', 4);
      }
      targetLocation = location;
      targetIds = ids;
      phase = 'closing-selection';
      if (!selectionSession || !await retireSelectionPage(selectionSession, selectionPage)) markHardViolation();
      await drainRoutes();
      if (hardViolated || selectionPage.isClosed() || selectionPage.url() !== 'about:blank') {
        if (!hardViolated) markHardViolation();
        throw new AppError('READ_POLICY_BLOCK', 'Probe selection page was not safely retired before target setup', 4);
      }

      expectedTargetPageCreation = true;
      let createdPage: Page | undefined;
      try { createdPage = await context.newPage(); }
      catch { markHardViolation(); }
      finally { expectedTargetPageCreation = false; }
      if (!createdPage || (internallyCreatedPage && internallyCreatedPage !== createdPage)) {
        markHardViolation();
        await createdPage?.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', 'Probe could not create one isolated target page', 4);
      }
      targetPage = createdPage;
      internallyCreatedPage = undefined;
      const pristine = await probePageState(targetPage);
      if (hardViolated || targetPage.isClosed() || targetPage.url() !== 'about:blank' || targetPage.frames().length !== 1
        || await targetPage.opener() !== null || context.pages().length !== 2
        || context.pages().some((candidate) => candidate !== targetPage && candidate !== selectionPage)
        || !pristine?.guardReady || pristine.href !== 'about:blank' || pristine.historyBlocked) {
        if (!hardViolated) markHardViolation();
        await targetPage.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', 'Probe target page was not pristine before preflight', 4);
      }

      phase = 'target-preflight';
      counts.targetPreflightGets += 1;
      const document = await isolatedCachedDocument(context, targetUrl, location);
      if (!document) {
        counts.targetPreflightFailures += 1;
        markHardViolation();
        await targetPage.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', 'Probe target preflight did not return one exact safe document', 4);
      }
      const stillPristine = await probePageState(targetPage);
      if (hardViolated || phase !== 'target-preflight' || targetPage.isClosed() || targetPage.url() !== 'about:blank'
        || targetPage.frames().length !== 1 || selectionPage.isClosed() || selectionPage.url() !== 'about:blank'
        || context.pages().length !== 2
        || context.pages().some((candidate) => candidate !== targetPage && candidate !== selectionPage)
        || !stillPristine?.guardReady || stillPristine.href !== 'about:blank' || stillPristine.historyBlocked) {
        if (!hardViolated) markHardViolation();
        await targetPage.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', 'Probe target preflight did not preserve one pristine target page', 4);
      }
      targetDocument = document;
      phase = 'armed';
      return targetPage;
    },
    async assertTargetSafe() {
      if (!targetLocation || !targetPage) throw new AppError('READ_POLICY_BLOCK', 'Probe target was not armed', 4);
      const unsafePageState = counts.targetNavigationsAllowed !== 1 || !await pageMatches(targetPage, targetLocation);
      if (unsafePageState && !hardViolated) markHardViolation();
      if (hardViolated || unsafePageState) {
        throw new AppError('READ_POLICY_BLOCK', 'Probe target navigation did not remain within its exact safe target', 4);
      }
    },
    snapshot() { return { ...counts }; },
    async dispose() {
      context.off('page', popupHandler);
      await context.unroute('**/*', trackedRouteHandler);
      await selectionSession?.detach().catch(() => undefined);
    },
  };
}
