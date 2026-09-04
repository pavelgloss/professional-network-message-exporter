import type { APIRequestContext } from 'playwright';
import { AppError } from '../../errors.js';
import { requestPolicy } from '../../browser/request-guard.js';

const allowedReadPath = /^\/voyager\/api\/(?:messaging(?:\/|$)|graphql(?:\/|$)|me$)/i;

export function assertAllowedReadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl, 'https://www.linkedin.com');
  const policy = requestPolicy('GET', url.toString());
  if (!policy.allow || url.origin !== 'https://www.linkedin.com' || !allowedReadPath.test(url.pathname)) throw new AppError('READ_POLICY_BLOCK', `Read URL was blocked: ${url.origin}${url.pathname}`);
  if (/mutation|sendMessage|delete|archive|markRead|reaction/i.test(url.search)) throw new AppError('READ_POLICY_BLOCK', `Ambiguous GraphQL/read URL was blocked: ${url.origin}${url.pathname}`);
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
