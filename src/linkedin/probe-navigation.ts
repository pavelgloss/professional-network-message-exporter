import { request as playwrightRequest, type APIResponse, type BrowserContext, type CDPSession, type Page, type Request, type Route } from 'playwright';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { redactedPathShape } from '../domain/url-redaction.js';
import { AppError } from '../errors.js';
import { isProbeThreadUrl, parseProbeConversationReferences, probeMessagingRequestPolicy } from './probe-request-policy.js';
import { conversationIdFromUrn } from '../domain/stable-id.js';
import { probeTransport } from '../browser/probe-transport.js';
import { requestPolicy } from '../browser/request-guard.js';

export type ProbeNavigationSnapshot = {
  selectionNavigationsAllowed: number;
  targetNavigationsAllowed: number;
  targetEquivalentNavigationsAllowed: number;
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
  hardViolationReasons: string[];
  apiProxyFailures: string[];
  transportRequestsDenied: number;
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
const BROKER_TIMEOUT_MS = 5_000;

function exactCanonicalLocation(rawUrl: string): string | undefined {
  const canonical = canonicalUrlView(rawUrl);
  if (!canonical || canonical.url.username || canonical.url.password || canonical.url.hash) return undefined;
  const query = canonical.query.map(({ name, value }) => `${name}=${value}`).join('&');
  return `${canonical.url.origin}${canonical.pathname}${query ? `?${query}` : ''}`;
}

function normalizedId(value: string): string | undefined {
  const normalized = repeatedlyDecodeAndNormalize(value);
  return normalized && (/^[\p{L}\p{N}_.-]+$/u.test(normalized) || /^[A-Za-z0-9._~=-]+$/.test(normalized)) ? normalized : undefined;
}

function exactThreadRouteId(rawUrl: string, expectedOrigin: string): string | undefined {
  const canonical = canonicalUrlView(rawUrl);
  if (!canonical || canonical.url.origin !== expectedOrigin || canonical.url.username || canonical.url.password
    || canonical.url.search || canonical.url.hash) return undefined;
  const segment = canonical.pathname.match(/^\/messaging\/thread\/([^/]+)\/?$/i)?.[1];
  const normalized = segment ? repeatedlyDecodeAndNormalize(segment) : undefined;
  return normalized ? normalizedId(conversationIdFromUrn(normalized) ?? normalized) : undefined;
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

async function isolatedCachedDocument(context: BrowserContext, rawUrl: string, expectedLocation: string, active: () => boolean): Promise<CachedDocument | undefined> {
  // APIRequestContext receives a copy of the auth state. Response Set-Cookie
  // processing is confined to this short-lived context and can never mutate the
  // probe browser's cookie jar.
  const storageState = await context.storageState();
  const isolated = await playwrightRequest.newContext({ storageState });
  let response: APIResponse | undefined;
  try {
    if (!active()) return undefined;
    response = await isolated.get(rawUrl, { maxRedirects: 0, failOnStatusCode: false, timeout: BROKER_TIMEOUT_MS });
    return await cacheSafeDocument(response, expectedLocation);
  } catch {
    return undefined;
  } finally {
    await response?.dispose().catch(() => undefined);
    await isolated.dispose().catch(() => undefined);
  }
}

async function isolatedApiResponse(context: BrowserContext, browserRequest: Request, active: () => boolean, asset = false): Promise<{ document?: CachedDocument; failure?: string }> {
  const storageState = await context.storageState();
  const originalHeaders = await browserRequest.allHeaders();
  const headers = Object.fromEntries(Object.entries(originalHeaders).filter(([name]) =>
    /^(?:accept|accept-language|user-agent|referer|origin|csrf-token|x-li-[a-z0-9-]+|x-restli-protocol-version)$/i.test(name)));
  const isolated = await playwrightRequest.newContext(asset ? {} : { storageState });
  let response: APIResponse | undefined;
  try {
    if (!active()) return { failure: 'generation-retired' };
    response = await isolated.fetch(browserRequest.url(), { method: browserRequest.method(), headers: asset ? {} : headers,
      maxRedirects: 0, failOnStatusCode: false, timeout: BROKER_TIMEOUT_MS });
    const responseHeaders = response.headers();
    const contentType = responseHeaders['content-type'] ?? '';
    const declaredSize = Number(responseHeaders['content-length'] ?? 0);
    if (response.status() !== 200) return { failure: `status-${response.status()}` };
    if (responseHeaders.location) return { failure: 'redirect' };
    const permittedType = asset
      ? /^(?:text\/(?:css|javascript)|application\/(?:javascript|x-javascript|font-woff|vnd.ms-fontobject)|image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon)|font\/(?:woff2?|ttf|otf))(?:;|$)/i.test(contentType)
      : /(?:json|graphql)/i.test(contentType);
    if (!permittedType) return { failure: 'content-type' };
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PROBE_API_BYTES) return { failure: 'declared-size' };
    const body = await response.body();
    if (body.byteLength > MAX_PROBE_API_BYTES) return { failure: 'body-size' };
    return { document: { status: 200, headers: { 'content-type': contentType }, body } };
  } catch {
    return { failure: 'request-error' };
  } finally {
    await response?.dispose().catch(() => undefined);
    await isolated.dispose().catch(() => undefined);
  }
}

function allowedAsset(request: Request, expectedOrigin: string): boolean {
  const canonical = canonicalUrlView(request.url());
  if (!canonical || canonical.url.username || canonical.url.password || canonical.url.hash
    || !['GET', 'HEAD'].includes(request.method())
    || !['script', 'stylesheet', 'image', 'font'].includes(request.resourceType())) return false;
  const sameOrigin = canonical.url.origin === expectedOrigin;
  const staticOrigin = canonical.url.origin === 'https://static.licdn.com';
  const mediaOrigin = canonical.url.origin === 'https://media.licdn.com';
  return ((sameOrigin || staticOrigin) && /^\/(?:aero-v1\/)?sc\/h\/[A-Za-z0-9._/-]+$/.test(canonical.pathname))
    || (mediaOrigin && /^\/dms\/image\/[A-Za-z0-9._/-]+$/.test(canonical.pathname))
    // Local anonymous fixtures exercise the identical broker without internet.
    || (sameOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(expectedOrigin)
      && /^\/assets\/[A-Za-z0-9._/-]+$/.test(canonical.pathname));
}

async function retireSelectionPage(session: CDPSession, page: Page, onFenced: () => void, drainRoutes: () => Promise<void>): Promise<boolean> {
  // Freeze and CDP blocking reduce teardown activity. The context's lifetime
  // deny proxy is the authority when Playwright bypasses routes for lost frames;
  // these page-scoped commands alone were not a deterministic network barrier.
  try {
    // Freeze first so no new timer can enter the narrow interval between the
    // route drain and Chromium's network fence. Already-started routes are
    // drained only after the fence is active and before page.close.
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    await session.send('Network.setBlockedURLs', { urls: ['*'] });
    onFenced();
    await drainRoutes();
    await page.close({ runBeforeUnload: false });
    return page.isClosed();
  } catch {
    return false;
  }
}

export async function installProbeNavigationGate(context: BrowserContext, selectionPage: Page, selectionUrl: string): Promise<ProbeNavigationGate> {
  const transport = probeTransport(context);
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
  let selectionNetworkFenced = false;
  let generation = 0;
  let disposed = false;
  const counts: ProbeNavigationSnapshot = {
    selectionNavigationsAllowed: 0,
    targetNavigationsAllowed: 0,
    targetEquivalentNavigationsAllowed: 0,
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
    hardViolationReasons: [],
    apiProxyFailures: [],
    transportRequestsDenied: transport.hits,
  };

  const markHardViolation = (reason = 'unspecified'): void => {
    hardViolated = true;
    phase = 'failed';
    selectionDocument = undefined;
    targetDocument = undefined;
    counts.hardSafetyViolations += 1;
    if (!counts.hardViolationReasons.includes(reason)) counts.hardViolationReasons.push(reason);
  };
  const transportDenied = () => {
    counts.transportRequestsDenied = transport.hits;
    markHardViolation('transport-denied');
  };
  transport.listeners.add(transportDenied);
  if (transport.hits) transportDenied();

  try {
    selectionSession = await context.newCDPSession(selectionPage);
    await selectionSession.send('Network.enable');
    // A renderer can dispatch a timer-backed request in the tiny interval in
    // which page.close tears down Playwright routing. Block every legacy or UI
    // thread surface at Chromium's lower network layer for the entire selection
    // lifetime. The one exact modern GraphQL path remains available only through
    // the stricter route proxy below.
    await selectionSession.send('Network.setBlockedURLs', { urls: [
      '*://*/messaging/thread/*',
      '*://*/voyager/api/messaging*',
      '*://*/voyager/api/*MessagingRest*',
      '*://*/voyager/api/*MessagingGraphQLV2*',
      '*://*/voyager/api/graphqlV2*',
    ] });
  } catch {
    throw new AppError('READ_POLICY_BLOCK', 'Probe could not prepare the selection network fence', 4);
  }

  selectionDocument = await isolatedCachedDocument(context, selectionUrl, selectionLocation, () => !hardViolated && !disposed);
  if (!selectionDocument) {
    counts.selectionPreflightFailures += 1;
    markHardViolation('selection-preflight');
  }

  await context.exposeBinding('__linkedinReaderProbeReportHistoryViolation', ({ page: sourcePage }, kind: unknown) => {
    if (sourcePage !== selectionPage && sourcePage !== targetPage) return;
    if ((sourcePage === selectionPage || sourcePage === targetPage) && (kind === 'history' || kind === 'popup')) {
      if (sourcePage === selectionPage && kind === 'history') counts.selectionHistoryAttemptsBlocked += 1;
      else if (sourcePage === selectionPage) counts.selectionPopupAttemptsBlocked += 1;
      return;
    }
    if (sourcePage === selectionPage && kind === 'same-document') {
      counts.selectionSameDocumentAttemptsBlocked += 1;
      return;
    }
    historyViolationReported = true;
    markHardViolation(`client-${String(kind)}`);
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

  const block = async (route: Route, kind: 'navigation' | 'cross-thread' | 'subrequest', fatal = true, networkFenced = false, source = 'unspecified'): Promise<void> => {
    if (fatal) markHardViolation(`blocked-${kind}:${source}`);
    const navigation = route.request().isNavigationRequest();
    try {
      await route.abort('blockedbyclient');
      if (navigation) counts.navigationAttemptsBlocked += 1;
      if (kind === 'cross-thread') counts.crossThreadRequestsBlocked += 1;
      if (!fatal) counts.selectionSubrequestsBlocked += 1;
    } catch {
      // A tolerated attempt is only safe after Playwright confirms the abort.
      // Any inability to abort becomes terminal and the cached target is lost.
      if (!fatal && !networkFenced) markHardViolation(`abort-failed-${kind}`);
    }
  };

  // A subrequest confirmed aborted by Playwright cannot reach LinkedIn, so it
  // is safe to tolerate in either phase. Navigations remain terminal unless
  // handled as the redundant exact-target case below; abort failures are still
  // promoted to hard violations by block().
  const blockedMessagingAttemptIsFatal = (request: Request): boolean => request.isNavigationRequest();
  const selectionIsClosing = (): boolean => phase === 'closing-selection';

  const mainPageNavigation = (route: Route, expectedPage: Page): boolean => {
    const navigationRequest = route.request();
    if (!navigationRequest.isNavigationRequest()) return false;
    try { return navigationRequest.frame() === expectedPage.mainFrame() && navigationRequest.frame().page() === expectedPage; }
    catch { return false; }
  };

  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const requestGeneration = generation;
    let owner: Page | undefined;
    try { owner = request.frame().page(); } catch { /* workers never inherit page authority */ }
    const active = () => !disposed && !hardViolated && generation === requestGeneration
      && ((phase === 'selection' && owner === selectionPage)
        || (['armed', 'target-used'].includes(phase) && owner === targetPage));
    if (!active() && phase !== 'closing-selection' && phase !== 'failed') {
      await block(route, 'subrequest', false, true, 'unowned-request');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method()) || !requestPolicy(request.method(), request.url()).allow) {
      await block(route, 'subrequest', false, true, 'read-policy');
      return;
    }
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
        || targetPage.frames().length !== 1 || !selectionPage.isClosed()
        || context.pages().length !== 1 || context.pages()[0] !== targetPage) {
        await block(route, 'cross-thread', true, false, 'target-document-precondition');
        return;
      }
      counts.targetNavigationsAllowed += 1;
      phase = 'target-used';
      const document = targetDocument;
      targetDocument = undefined;
      await route.fulfill(document);
      return;
    }

    // Final selection validation revokes this generation synchronously. No new
    // request is brokered while the old page is being destroyed.
    if (phase === 'closing-selection') {
      const messaging = isProbeThreadUrl(request.url(), expectedOrigin)
        || probeMessagingRequestPolicy('selection', request.method(), request.url(), expectedOrigin, targetIds).messaging;
      // Target selection is already final. Every late request is aborted; a
      // confirmed abort is sufficient even for navigation, while an abort
      // failure remains terminal until the CDP network fence is active.
      await block(route, messaging ? 'cross-thread' : request.isNavigationRequest() ? 'navigation' : 'subrequest',
        false, selectionNetworkFenced, 'closing-selection');
      return;
    }

    // A thread route is never allowed onto the wire, for any resource type or
    // frame. The sole target document exception was fulfilled from memory above.
    if (isProbeThreadUrl(request.url(), expectedOrigin)) {
      const routeId = exactThreadRouteId(request.url(), expectedOrigin);
      const equivalentTarget = phase === 'target-used' && request.isNavigationRequest() && Boolean(routeId && targetIds.has(routeId));
      if (equivalentTarget && counts.targetEquivalentNavigationsAllowed < 2) {
        const equivalentLocation = exactCanonicalLocation(request.url());
        const document = equivalentLocation ? await isolatedCachedDocument(context, request.url(), equivalentLocation, active) : undefined;
        if (document && !hardViolated) {
          counts.targetEquivalentNavigationsAllowed += 1;
          await route.fulfill(document);
          return;
        }
      }
      await block(route, 'cross-thread', equivalentTarget ? false : blockedMessagingAttemptIsFatal(request), false,
        equivalentTarget ? 'equivalent-thread-budget' : 'thread-route');
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
        const targetDocumentAttempt = phase === 'target-used' && request.resourceType() === 'document';
        const selectionNonThreadDocumentAttempt = phase === 'selection' && request.isNavigationRequest()
          && !isProbeThreadUrl(request.url(), expectedOrigin);
        await block(route, 'cross-thread', (targetDocumentAttempt || selectionNonThreadDocumentAttempt)
          ? false : blockedMessagingAttemptIsFatal(request), false,
          `messaging-policy-${phase}-${request.resourceType()}-${redactedPathShape(canonicalUrlView(request.url())?.pathname ?? '')}`);
        return;
      }
      const requestPhase = phase;
      const proxied = await isolatedApiResponse(context, request, active);
      const sameTargetLifecycle = ['armed', 'target-used'].includes(requestPhase)
        && ['armed', 'target-used'].includes(phase);
      if (proxied.document && !hardViolated && (phase === requestPhase || sameTargetLifecycle)) await route.fulfill(proxied.document);
      else if (requestPhase === 'selection' && selectionIsClosing() && !request.isNavigationRequest()) {
        await block(route, 'cross-thread', false, false, 'selection-proxy-retired');
      }
      // An allowlisted request whose isolated response is not an exact safe
      // response (including a redirect) is a hard failure in every phase.
      else {
        const failure = proxied.failure ?? (hardViolated ? 'prior-hard-state' : `phase-${requestPhase}-to-${phase}`);
        if (!counts.apiProxyFailures.includes(failure)) counts.apiProxyFailures.push(failure);
        await block(route, 'cross-thread', true, false, 'api-proxy-response');
      }
      return;
    }

    // No frame may navigate away from either cached document. Only explicitly
    // allowlisted assets may use the isolated broker below.
    if (request.isNavigationRequest()) {
      // A denied ordinary child-frame navigation cannot escape the route or
      // reach the wire. Only a main-page navigation changes the trusted probe
      // document and is therefore terminal. Messaging/thread frames were
      // already handled by the stricter branch above and remain terminal.
      const mainPage = phase !== 'target-used' && (mainPageNavigation(route, selectionPage)
        || Boolean(targetPage && mainPageNavigation(route, targetPage)));
      await block(route, 'navigation', mainPage, false, 'ordinary-navigation');
      return;
    }
    if (active() && allowedAsset(request, expectedOrigin)) {
      const proxied = await isolatedApiResponse(context, request, active, true);
      if (proxied.document && active()) await route.fulfill(proxied.document);
      else await block(route, 'subrequest', active(), true, 'asset-broker');
      return;
    }
    await block(route, 'subrequest', false, true, 'unapproved-resource');
  };
  const pendingRoutes = new Set<Promise<void>>();
  const trackedRouteHandler = (route: Route): Promise<void> => {
    const task = routeHandler(route).catch(() => {
      if (!disposed && phase !== 'closing-selection') markHardViolation('route-error');
    }).finally(() => pendingRoutes.delete(task));
    pendingRoutes.add(task);
    return task;
  };
  await context.route('**/*', trackedRouteHandler);

  const drainRoutes = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { while (pendingRoutes.size) await Promise.allSettled([...pendingRoutes]); })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            markHardViolation('broker-drain-timeout');
            reject(new AppError('READ_POLICY_BLOCK', 'Probe broker drain exceeded its bounded deadline', 4));
          }, BROKER_TIMEOUT_MS + 2_000);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
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
    const toleratedClientAttempt = ((candidatePage === selectionPage && phase === 'selection') || candidatePage === targetPage)
      && Boolean(state && !state.hardClientViolation
        && state.historyAttemptsBlocked + state.popupAttemptsBlocked > 0);
    // Chromium may replace the target renderer with an inert error document
    // after a later main-document navigation is deliberately aborted. That
    // document keeps the exact target URL but does not rerun init scripts. The
    // Node-side route gate remains authoritative and the inert target is safe;
    // selection still requires the client marker above.
    const clientBoundaryReady = Boolean(state?.guardReady || (candidatePage === targetPage && state));
    const exactOrEquivalentLocation = exactCanonicalLocation(state?.href ?? '') === expected
      || Boolean(candidatePage === targetPage && exactThreadRouteId(state?.href ?? '', expectedOrigin)
        && targetIds.has(exactThreadRouteId(state?.href ?? '', expectedOrigin)!));
    return !hardViolated && Boolean(clientBoundaryReady && exactOrEquivalentLocation
      && !state?.hardClientViolation && (!state?.historyBlocked || toleratedClientAttempt));
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
      generation += 1;
      if (!selectionSession || !await retireSelectionPage(selectionSession, selectionPage, () => {
        selectionNetworkFenced = true;
      }, drainRoutes)) markHardViolation();
      await drainRoutes();
      if (hardViolated || !selectionPage.isClosed() || context.pages().length !== 0) {
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
      const targetOpener = await targetPage.opener();
      if (hardViolated || targetPage.isClosed() || targetPage.url() !== 'about:blank' || targetPage.frames().length !== 1
        || targetOpener !== null || context.pages().length !== 1 || context.pages()[0] !== targetPage
        || pristine?.href !== 'about:blank' || pristine.historyBlocked) {
        const reasons = [
          hardViolated && 'prior-safety-state', targetPage.isClosed() && 'closed', targetPage.url() !== 'about:blank' && 'url',
          targetPage.frames().length !== 1 && 'frames', targetOpener !== null && 'opener',
          (context.pages().length !== 1 || context.pages()[0] !== targetPage) && 'page-count',
          pristine?.href !== 'about:blank' && 'href', pristine?.historyBlocked && 'history',
        ].filter(Boolean).join(',');
        if (!hardViolated) markHardViolation();
        await targetPage.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', `Probe target page was not pristine before preflight (${reasons})`, 4);
      }

      phase = 'target-preflight';
      counts.targetPreflightGets += 1;
      const document = await isolatedCachedDocument(context, targetUrl, location, () => !disposed && !hardViolated && phase === 'target-preflight');
      if (!document) {
        counts.targetPreflightFailures += 1;
        markHardViolation();
        await targetPage.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new AppError('READ_POLICY_BLOCK', 'Probe target preflight did not return one exact safe document', 4);
      }
      const stillPristine = await probePageState(targetPage);
      if (hardViolated || phase !== 'target-preflight' || targetPage.isClosed() || targetPage.url() !== 'about:blank'
        || targetPage.frames().length !== 1 || !selectionPage.isClosed()
        || context.pages().length !== 1 || context.pages()[0] !== targetPage
        || stillPristine?.href !== 'about:blank' || stillPristine.historyBlocked) {
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
      if (unsafePageState && !hardViolated) {
        const state = await probePageState(targetPage);
        const toleratedClientAttempt = Boolean(state && !state.hardClientViolation
          && state.historyAttemptsBlocked + state.popupAttemptsBlocked > 0);
        const reasons = [
          counts.targetNavigationsAllowed !== 1 && 'navigation-count', !state && 'state-unavailable',
          state && !state.guardReady && 'guard', state && exactCanonicalLocation(state.href) !== targetLocation
            && !targetIds.has(exactThreadRouteId(state.href, expectedOrigin) ?? '') && 'location',
          state?.hardClientViolation && 'hard-client', state?.historyBlocked && !toleratedClientAttempt && 'client-attempt',
        ].filter(Boolean).join(',') || 'race';
        markHardViolation(`target-state-${reasons}`);
      }
      if (hardViolated || unsafePageState) {
        throw new AppError('READ_POLICY_BLOCK', 'Probe target navigation did not remain within its exact safe target', 4);
      }
    },
    snapshot() { return { ...counts }; },
    async dispose() {
      disposed = true;
      generation += 1;
      await drainRoutes();
      context.off('page', popupHandler);
      await context.unroute('**/*', trackedRouteHandler);
      await selectionSession?.detach().catch(() => undefined);
      // The transport deny listener stays alive until context.close: teardown
      // must not hide a late route-bypass attempt from the final hard state.
    },
  };
}
