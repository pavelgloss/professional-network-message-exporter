import { describe, expect, it } from 'vitest';
import type { Page, Response } from 'playwright';
import { attachNetworkCapture } from '../../src/linkedin/network/capture.js';
import { createManifest, jsonStructuralSignature, queryParameterNames, redactedPathShape } from '../../src/io/diagnostics.js';
import { createLogger } from '../../src/logger.js';

function response(url: string, contentType: string, body: string, status = 200): Response {
  return {
    url: () => url,
    status: () => status,
    headers: () => ({ 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }),
    body: async () => Buffer.from(body),
  } as unknown as Response;
}

describe('safe network diagnostics', () => {
  it('records only redacted paths, query names, shapes, skip reasons, and parser counts', async () => {
    const handlers = new Set<(value: Response) => void>();
    const page = {
      on: (_event: string, handler: (value: Response) => void) => handlers.add(handler),
      off: (_event: string, handler: (value: Response) => void) => handlers.delete(handler),
    } as unknown as Page;
    const manifest = createManifest();
    const capture = attachNetworkCapture(page, manifest, createLogger({ write: () => true }));
    const canary = 'CANARY_ULTRA_SECRET_123456';
    const json = JSON.stringify({ data: { elements: [{ entityUrn: `urn:li:messagingMessage:${canary}`, eventContent: { attributedBody: { text: canary } } }], csrfToken: canary } });
    for (const handler of handlers) {
      handler(response(`https://www.linkedin.com/voyager/api/messaging/conversations/${canary}?variables=${canary}&authToken=${canary}`, 'application/json', json));
      handler(response(`https://www.linkedin.com/unrelated/${canary}?value=${canary}`, 'application/json', JSON.stringify({ featureFlags: [canary] })));
      handler(response('https://www.linkedin.com/voyager/api/messaging', 'text/html', `<p>${canary}</p>`));
    }
    await capture.drain();
    capture.detach();

    expect(manifest.counts).toMatchObject({ linkedinResponses: 3, relevantResponses: 2, parsedResponses: 1, skippedIrrelevantPath: 1, skippedContentType: 1 });
    expect(manifest.networkResponses.map((entry) => entry.outcome).sort()).toEqual(['content-type-not-json', 'parsed', 'path-not-relevant']);
    expect(manifest.networkResponses.find((entry) => entry.outcome === 'parsed')?.parserOutput).toMatchObject({ conversations: 0, messages: 0, misses: 0 });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('urn:li:messagingMessage');
    expect(serialized).toContain('variables');
    expect(serialized).toContain('<redacted-key>');
  });

  it('bounds structural signatures and never records values or opaque path segments', () => {
    const canary = 'CANARY_SECRET_VALUE_987654';
    const signature = jsonStructuralSignature({ data: { items: Array.from({ length: 3_000 }, () => ({ opaqueDynamicKey123456: canary })) } });
    expect(JSON.stringify(signature)).not.toContain(canary);
    expect(JSON.stringify(signature)).not.toContain('opaqueDynamicKey123456');
    expect(signature.truncated).toBe(true);
    const url = new URL(`https://www.linkedin.com/messaging/thread/${canary}?cursor=${canary}&csrfToken=${canary}`);
    expect(redactedPathShape(url.pathname)).toBe('/messaging/thread/:opaque');
    expect(queryParameterNames(url)).toEqual(['<redacted-key>', 'cursor']);
  });
});
