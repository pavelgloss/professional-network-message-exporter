import type { APIResponse, BrowserContext, Page, Request, Route } from 'playwright';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { conversationIdFromUrn } from '../domain/stable-id.js';
import { AppError } from '../errors.js';

export type ProbeNavigationSnapshot = {
  selectionNavigationsAllowed: number;
  targetNavigationsAllowed: number;
  navigationAttemptsBlocked: number;
  popupPagesBlocked: number;
  crossThreadRequestsBlocked: number;
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
  const ids = new Set<string>();
  if (method.toUpperCase() !== 'GET') return ids;
  const canonical = canonicalUrlView(rawUrl);
  if (!canonical || canonical.url.origin !== 'https://www.linkedin.com'
    || !/^\/voyager\/api\/(?:graphql|voyagerMessagingGraphQL\/graphql)$/.test(canonical.pathname)) return ids;
  const addUrn = (value: string) => {
    const id = conversationIdFromUrn(value);
    if (id) ids.add(id);
  };
  for (const { name, value } of canonical.query) {
    if (/^(?:conversationUrn|urn)$/i.test(name)) {
      addUrn(value);
      if (!/^urn:/i.test(value)) {
        const id = normalizedId(value);
        if (id) ids.add(id);
      }
    }
    for (const match of value.matchAll(/urn:li:(?:msg_conversation|fsd_messengerConversation|messagingThread|messagingConversation|conversation):(?:\([^)]*\)|[\p{L}\p{N}_.-]+)/giu)) {
      if (match[0]) addUrn(match[0]);
    }
    for (const match of value.matchAll(/"?(?:conversationUrn|urn)"?\s*[:=]\s*"?([\p{L}\p{N}_.-]+)/giu)) {
      const id = match[1] && !/^urn$/i.test(match[1]) ? normalizedId(match[1]) : undefined;
      if (id) ids.add(id);
    }
  }
  return ids;
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

export async function installProbeNavigationGate(context: BrowserContext, page: Page, selectionUrl: string): Promise<ProbeNavigationGate> {
  const selectionLocation = exactCanonicalLocation(selectionUrl);
  if (!selectionLocation) throw new AppError('READ_POLICY_BLOCK', 'Probe selection URL was ambiguous');
  let phase: Phase = 'selection';
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
    targetPreflightGets: 0,
  };

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

  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const referencedIds = explicitProbeGraphqlConversationIds(request.method(), request.url());
    if (referencedIds.size && (!targetIds.size || [...referencedIds].some((id) => !targetIds.has(id)))) {
      await block(route, 'cross-thread');
      return;
    }
    if (!request.isNavigationRequest()) {
      await route.fallback();
      return;
    }
    let frame;
    try { frame = request.frame(); } catch {
      await block(route, 'navigation');
      return;
    }
    if (frame.page() !== page) {
      counts.popupPagesBlocked += 1;
      await block(route, 'navigation');
      return;
    }
    if (frame !== page.mainFrame()) {
      await route.fallback();
      return;
    }
    const location = exactCanonicalLocation(request.url());
    if (phase === 'selection' && counts.selectionNavigationsAllowed === 0 && location === selectionLocation) {
      counts.selectionNavigationsAllowed += 1;
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        let document: CachedDocument | undefined;
        try { document = await cacheSafeDocument(response, selectionLocation); } finally { await response.dispose(); }
        if (!document) {
          counts.navigationAttemptsBlocked += 1;
          violated = true;
          await route.abort('blockedbyclient').catch(() => undefined);
          return;
        }
        await route.fulfill(document);
      } catch {
        counts.navigationAttemptsBlocked += 1;
        violated = true;
        await route.abort('blockedbyclient').catch(() => undefined);
      }
      return;
    }
    if (phase === 'armed' && counts.targetNavigationsAllowed === 0 && location === targetLocation && targetDocument) {
      counts.targetNavigationsAllowed += 1;
      phase = 'target-used';
      const document = targetDocument;
      targetDocument = undefined;
      await route.fulfill(document);
      return;
    }
    await block(route, 'navigation');
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
      const ids = new Set([...knownConversationIds].map(normalizedId).filter((id): id is string => Boolean(id)));
      if (!location || !ids.size) throw new AppError('READ_POLICY_BLOCK', 'Probe target URL or identity was ambiguous', 4);
      targetLocation = location;
      targetIds = ids;
      counts.targetPreflightGets += 1;
      try {
        const response = await context.request.get(targetUrl, { maxRedirects: 0, failOnStatusCode: false });
        try { targetDocument = await cacheSafeDocument(response, location); } finally { await response.dispose(); }
      } catch {
        targetDocument = undefined;
      }
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
