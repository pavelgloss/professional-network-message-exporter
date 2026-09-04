import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { assertAllowedReadUrl } from '../../src/linkedin/network/read-client.js';
import { createManifest } from '../../src/io/diagnostics.js';
import { followObservedPagination } from '../../src/linkedin/network/pagination.js';
import type { APIRequestContext } from 'playwright';

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

  it('resolves GraphQL reference arrays, composite URNs, and observed cursors', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/graphql-composite.json', import.meta.url), 'utf8'));
    const source = `https://www.linkedin.com/voyager/api/graphql?queryId=messengerConversations&variables=${encodeURIComponent(JSON.stringify({ cursor: 'cursor-old', count: 20 }))}`;
    const parsed = parseNetworkPayload(fixture, source);
    expect(parsed.conversations[0]).toMatchObject({ id: '2-XYZ', entityUrn: 'urn:li:msg_conversation:(urn:li:fsd_profile:SELF,2-XYZ)' });
    expect((parsed.conversations[0]?.participants ?? []).map((participant) => participant.id)).toEqual(['SELF', 'EXT']);
    expect(parsed.conversations[0]?.messages?.[0]).toMatchObject({ id: 'M-1', conversationId: '2-XYZ', senderId: 'SELF', text: 'Composite outbound' });
    expect(decodeURIComponent(parsed.paginationUrls[0] ?? '')).toContain('cursor-next');
  });

  it('follows relative history links across multiple anonymous pages', async () => {
    const page1 = JSON.parse(await readFile(new URL('../fixtures/network/history-page-1.json', import.meta.url), 'utf8'));
    const page2 = JSON.parse(await readFile(new URL('../fixtures/network/history-page-2.json', import.meta.url), 'utf8'));
    const fakeRequest = {
      get: async (url: string) => ({
        status: () => 200,
        ok: () => true,
        headers: () => ({}),
        body: async () => Buffer.from(url.includes('start=1') ? JSON.stringify(page2) : JSON.stringify(page1)),
      }),
    } as unknown as APIRequestContext;
    const manifest = createManifest();
    const conversations = await followObservedPagination(fakeRequest, ['https://www.linkedin.com/voyager/api/messaging/history?start=0&count=1'], manifest);
    expect(conversations.flatMap((conversation) => conversation.messages ?? []).map((message) => message.id)).toEqual(['H1', 'H2']);
    expect(manifest.counts.paginationPages).toBe(2);
  });
});
