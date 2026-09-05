import type { APIRequestContext } from 'playwright';
import { AppError } from '../../errors.js';
import { requestPolicy } from '../../browser/request-guard.js';
import { canonicalUrlView } from '../../domain/url-safety.js';
import { redactedPathShape, safeDiagnosticOrigin } from '../../domain/url-redaction.js';
import { isAllowedLinkedInReadPath } from './read-policy.js';

export function assertAllowedReadUrl(rawUrl: string): URL {
  const canonical = canonicalUrlView(rawUrl, 'https://www.linkedin.com');
  if (!canonical) throw new AppError('READ_POLICY_BLOCK', 'Read URL contained invalid or ambiguous encoding');
  const { url } = canonical;
  const policy = requestPolicy('GET', url.toString());
  const safeLocation = `${safeDiagnosticOrigin(url)}${redactedPathShape(canonical.pathname)}`;
  if (!policy.allow || url.origin !== 'https://www.linkedin.com' || url.username || url.password || !isAllowedLinkedInReadPath(canonical.pathname)) throw new AppError('READ_POLICY_BLOCK', `Read URL was blocked: ${safeLocation}`);
  const canonicalQuery = canonical.query.map(({ name, value }) => `${name}=${value}`).join('&');
  if (/(?:mutation|sendMessage|delete|archive|markRead|markUnread|reaction|typing)/i.test(`${canonical.pathname}?${canonical.search}&${canonicalQuery}`)) throw new AppError('READ_POLICY_BLOCK', `Ambiguous GraphQL/read URL was blocked: ${safeLocation}`);
  url.hash = '';
  return url;
}

export async function readJson(request: APIRequestContext, rawUrl: string, csrfToken?: string): Promise<unknown> {
  const url = assertAllowedReadUrl(rawUrl);
  const response = await request.get(url.toString(), { maxRedirects: 0, failOnStatusCode: false, ...(csrfToken ? { headers: { 'csrf-token': csrfToken } } : {}) });
  if (response.status() >= 300 && response.status() < 400) {
    const location = response.headers().location;
    if (!location) throw new AppError('READ_POLICY_BLOCK', 'Read endpoint redirected without a location');
    assertAllowedReadUrl(new URL(location, url).toString());
    throw new AppError('READ_POLICY_BLOCK', 'Read endpoint redirect was not followed automatically');
  }
  if (!response.ok()) throw new Error(`LinkedIn read endpoint returned HTTP ${response.status()}`);
  const body = await response.body();
  if (body.byteLength > 8 * 1024 * 1024) throw new Error('LinkedIn read response exceeded safe size limit');
  return JSON.parse(body.toString('utf8'));
}
