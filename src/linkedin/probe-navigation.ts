import { request as playwrightRequest, type APIResponse, type BrowserContext, type Page, type Route } from 'playwright';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { AppError } from '../errors.js';
import { isProbeThreadUrl, parseProbeConversationReferences, probeMessagingRequestPolicy } from './probe-request-policy.js';

export type ProbeNavigationSnapshot = {
  selectionNavigationsAllowed: number;
  targetNavigationsAllowed: number;
  navigationAttemptsBlocked: number;
  popupPagesBlocked: number;
  crossThreadRequestsBlocked: number;
  selectionPreflightGets: number;
  targetPreflightGets: number;
};

export type ProbeNavigationGate = {
  assertSelectionSafe(): Promise<void>;
  armTarget(targetUrl: string, knownConversationIds: Iterable<string>): Promise<void>;
  assertTargetSafe(): Promise<void>;
  snapshot(): ProbeNavigationSnapshot;
  dispose(): Promise<void>;
};

type Phase = 'selection' | 'armed' | 'target-used';
type CachedDocument = { status: 200; headers: Record<string, string>; body: Buffer };
const MAX_PROBE_DOCUMENT_BYTES = 8 * 1024 * 1024;

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

async function pageHistoryWasBlocked(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => Boolean((globalThis as typeof globalThis & { __linkedinReaderProbeHistoryBlocked?: boolean }).__linkedinReaderProbeHistoryBlocked));
  } catch { return true; }
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

export async function installProbeNavigationGate(context: BrowserContext, page: Page, selectionUrl: string): Promise<ProbeNavigationGate> {
  const selectionLocation = exactCanonicalLocation(selectionUrl);
  if (!selectionLocation) throw new AppError('READ_POLICY_BLOCK', 'Probe selection URL was ambiguous');
  const expectedOrigin = new URL(selectionLocation).origin;
  let phase: Phase = 'selection';
  let selectionDocument: CachedDocument | undefined;
  let targetLocation: string | undefined;
  let targetIds = new Set<string>();
  let targetDocument: CachedDocument | undefined;
  let violated = false;
  const counts: ProbeNavigationSnapshot = {
    selectionNavigationsAllowed: 0,
    targetNavigationsAllowed: 0,
    navigationAttemptsBlocked: 0,
    popupPagesBlocked: 0,
    crossThreadRequestsBlocked: 0,
    selectionPreflightGets: 1,
    targetPreflightGets: 0,
  };

  selectionDocument = await isolatedCachedDocument(context, selectionUrl, selectionLocation);

  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __linkedinReaderProbeHistoryBlocked?: boolean };
    let blocked = false;
    Object.defineProperty(state, '__linkedinReaderProbeHistoryBlocked', { configurable: false, get: () => blocked, set: () => undefined });
    const patch = (name: 'pushState' | 'replaceState') => {
      const original = history[name].bind(history);
      const guarded = ((...args: Parameters<History['pushState']>) => {
        const destination = args[2];
        if (destination === undefined || new URL(String(destination), location.href).href === location.href) return original(...args);
        blocked = true;
        throw new DOMException('Probe blocked client-side navigation', 'SecurityError');
      }) as History[typeof name];
      Object.defineProperty(history, name, { configurable: false, writable: false, value: guarded });
    };
    patch('pushState');
    patch('replaceState');
    const guardedOpen = (() => {
      blocked = true;
      return null;
    }) as typeof window.open;
    Object.defineProperty(window, 'open', { configurable: false, writable: false, value: guardedOpen });
  });

  const popupHandler = (opened: Page) => {
    if (opened === page) return;
    violated = true;
    counts.popupPagesBlocked += 1;
    void opened.close().catch(() => undefined);
  };
  context.on('page', popupHandler);

  const block = async (route: Route, kind: 'navigation' | 'cross-thread'): Promise<void> => {
    violated = true;
    if (kind === 'navigation') counts.navigationAttemptsBlocked += 1;
    else counts.crossThreadRequestsBlocked += 1;
    await route.abort('blockedbyclient').catch(() => undefined);
  };

  const mainPageNavigation = (route: Route): boolean => {
    const navigationRequest = route.request();
    if (!navigationRequest.isNavigationRequest()) return false;
    try { return navigationRequest.frame() === page.mainFrame() && navigationRequest.frame().page() === page; }
    catch { return false; }
  };

  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const location = exactCanonicalLocation(request.url());
    if (phase === 'selection' && counts.selectionNavigationsAllowed === 0 && location === selectionLocation
      && selectionDocument && mainPageNavigation(route)) {
      counts.selectionNavigationsAllowed += 1;
      const document = selectionDocument;
      selectionDocument = undefined;
      await route.fulfill(document);
      return;
    }
    if (phase === 'armed' && counts.targetNavigationsAllowed === 0 && location === targetLocation
      && targetDocument && mainPageNavigation(route)) {
      counts.targetNavigationsAllowed += 1;
      phase = 'target-used';
      const document = targetDocument;
      targetDocument = undefined;
      await route.fulfill(document);
      return;
    }

    // A thread route is never allowed onto the wire, for any resource type or
    // frame. The sole target document exception was fulfilled from memory above.
    if (isProbeThreadUrl(request.url(), expectedOrigin)) {
      await block(route, 'cross-thread');
      return;
    }

    const decision = probeMessagingRequestPolicy(phase === 'selection' ? 'selection' : 'target', request.method(), request.url(), expectedOrigin, targetIds);
    if (decision.messaging) {
      if (decision.allow) await route.fallback();
      else await block(route, 'cross-thread');
      return;
    }

    // No frame may navigate away from either cached document. Ordinary
    // non-messaging subresources still pass through the global read-only guard.
    if (request.isNavigationRequest()) {
      await block(route, 'navigation');
      return;
    }
    await route.fallback();
  };
  await context.route('**/*', routeHandler);

  const assertLocation = async (expected: string, expectedAllowed: number, phaseName: string): Promise<void> => {
    const actual = exactCanonicalLocation(page.url());
    if (violated || actual !== expected || expectedAllowed !== 1 || await pageHistoryWasBlocked(page)) {
      throw new AppError('READ_POLICY_BLOCK', `Probe ${phaseName} navigation did not remain within its exact safe target`, 4);
    }
  };

  return {
    async assertSelectionSafe() {
      await assertLocation(selectionLocation, counts.selectionNavigationsAllowed, 'selection');
    },
    async armTarget(targetUrl, knownConversationIds) {
      if (phase !== 'selection' || counts.selectionNavigationsAllowed !== 1 || violated) {
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
      targetLocation = location;
      targetIds = ids;
      counts.targetPreflightGets += 1;
      targetDocument = await isolatedCachedDocument(context, targetUrl, location);
      if (!targetDocument) {
        violated = true;
        counts.navigationAttemptsBlocked += 1;
        throw new AppError('READ_POLICY_BLOCK', 'Probe target preflight did not return one exact safe document', 4);
      }
      phase = 'armed';
    },
    async assertTargetSafe() {
      if (!targetLocation) throw new AppError('READ_POLICY_BLOCK', 'Probe target was not armed', 4);
      await assertLocation(targetLocation, counts.targetNavigationsAllowed, 'target');
    },
    snapshot() { return { ...counts }; },
    async dispose() {
      context.off('page', popupHandler);
      await context.unroute('**/*', routeHandler);
    },
  };
}
