import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { assertAllowedReadUrl } from '../../src/linkedin/network/read-client.js';

describe('network parser', () => {
  it('parses anonymized Voyager envelopes and explicit pagination', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/voyager.json', import.meta.url), 'utf8'));
    const parsed = parseNetworkPayload(fixture, '/voyager/api/messaging/conversations');
    expect(parsed.conversations[0]).toMatchObject({ id: 'conv-1' });
    expect(parsed.conversations[0]?.messages?.[0]).toMatchObject({ id: 'msg-1', text: 'Hello from fixture', senderId: 'person-2' });
    expect(parsed.paginationUrls).toHaveLength(1);
  });
  it('fails closed for unknown, foreign, and mutation-like read URLs', () => {
    expect(() => assertAllowedReadUrl('https://evil.example/voyager/api/messaging')).toThrow();
    expect(() => assertAllowedReadUrl('https://www.linkedin.com/voyager/api/feed')).toThrow();
    expect(() => assertAllowedReadUrl('https://www.linkedin.com/voyager/api/graphql?queryId=sendMessageMutation')).toThrow();
  });
});

