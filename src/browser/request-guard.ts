import type { BrowserContext, Route } from 'playwright';
import type { DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';

export type PolicyDecision = { allow: boolean; reason: string; origin?: string; pathname?: string };
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const forbiddenPaths = /\/(logout|checkpoint\/logout|settings\/.*(?:delete|close)|voyager\/api\/.*(?:delete|archive|send|react|typing|markRead|markUnread))/i;

export function requestPolicy(method: string, rawUrl: string): PolicyDecision {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allow: false, reason: 'invalid-url' }; }
  const details = { origin: url.origin, pathname: url.pathname };
  if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return { allow: false, reason: 'unsupported-protocol', ...details };
  if (url.protocol === 'data:' || url.protocol === 'blob:') return { allow: true, reason: 'local-resource', ...details };
  if (!safeMethods.has(method.toUpperCase())) return { allow: false, reason: 'non-read-http-method', ...details };
  if (/(^|\.)linkedin\.com$/i.test(url.hostname) && forbiddenPaths.test(url.pathname)) return { allow: false, reason: 'known-mutating-path', ...details };
  return { allow: true, reason: 'read-only-request', ...details };
}

export async function installRequestGuard(context: BrowserContext, manifest: DiagnosticsManifest, logger: Logger): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const decision = requestPolicy(request.method(), request.url());
    const key = decision.allow ? 'allowedRequests' : 'blockedRequests';
    manifest.counts[key] = (manifest.counts[key] ?? 0) + 1;
    if (!decision.allow) {
      const entry = { method: request.method(), origin: decision.origin ?? 'invalid', pathname: decision.pathname ?? '/', reason: decision.reason };
      if (manifest.blockedRequests.length < 200) manifest.blockedRequests.push(entry);
      logger.warn('request-blocked', entry);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

