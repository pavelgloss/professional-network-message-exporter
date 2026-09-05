import type { BrowserContext, Route } from 'playwright';
import type { DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import { canonicalUrlView } from '../domain/url-safety.js';
import { redactedPathShape, safeDiagnosticOrigin } from '../domain/url-redaction.js';

export type PolicyDecision = { allow: boolean; reason: string; origin?: string; pathname?: string };
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const forbiddenAccountPath = /\/(?:logout|checkpoint\/logout|settings\/.*(?:delete|close))(?:\/|$)/i;
const forbiddenAction = /(?:mutation|sendMessage|delete|archive|markRead|markUnread|reaction|typing)/i;

export function requestPolicy(method: string, rawUrl: string): PolicyDecision {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allow: false, reason: 'invalid-url' }; }
  const details = { origin: safeDiagnosticOrigin(url), pathname: url.pathname };
  if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return { allow: false, reason: 'unsupported-protocol', ...details };
  const canonical = canonicalUrlView(url.toString());
  if (!canonical) return { allow: false, reason: 'invalid-url-encoding', ...details };
  if (!safeMethods.has(method.toUpperCase())) return { allow: false, reason: 'non-read-http-method', ...details };
  if (url.protocol === 'data:' || url.protocol === 'blob:') return { allow: true, reason: 'local-resource', ...details };
  const linkedin = /(^|\.)linkedin\.com$/i.test(url.hostname);
  const actionScope = /^\/(?:voyager\/api|messaging)(?:\/|$)/i.test(canonical.pathname);
  const canonicalQuery = canonical.query.map(({ name, value }) => `${name}=${value}`).join('&');
  if (linkedin && (forbiddenAccountPath.test(canonical.pathname) || (actionScope && forbiddenAction.test(`${canonical.pathname}?${canonical.search}&${canonicalQuery}`)))) {
    return { allow: false, reason: 'known-mutating-path', origin: safeDiagnosticOrigin(url), pathname: canonical.pathname };
  }
  return { allow: true, reason: 'read-only-request', ...details };
}

export async function installRequestGuard(context: BrowserContext, manifest: DiagnosticsManifest, logger: Logger): Promise<void> {
  await context.routeWebSocket('**/*', async (webSocket) => {
    manifest.counts.blockedWebSockets = (manifest.counts.blockedWebSockets ?? 0) + 1;
    let origin = '<redacted-origin>';
    let pathname = '/';
    try { const url = new URL(webSocket.url()); origin = safeDiagnosticOrigin(url); pathname = redactedPathShape(url.pathname); } catch { /* redacted defaults */ }
    logger.warn('websocket-blocked', { origin, pathname });
    await webSocket.close({ code: 1008, reason: 'Read-only export blocks WebSockets' });
  });
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const decision = requestPolicy(request.method(), request.url());
    const key = decision.allow ? 'allowedRequests' : 'blockedRequests';
    manifest.counts[key] = (manifest.counts[key] ?? 0) + 1;
    if (!decision.allow) {
      const entry = { method: request.method(), origin: decision.origin ?? '<redacted-origin>', pathname: redactedPathShape(decision.pathname ?? '/'), reason: decision.reason };
      if (manifest.blockedRequests.length < 200) manifest.blockedRequests.push(entry);
      logger.warn('request-blocked', entry);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
