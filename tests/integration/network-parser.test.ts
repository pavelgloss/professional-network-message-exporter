import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { assertAllowedReadUrl } from '../../src/linkedin/network/read-client.js';
import { createManifest } from '../../src/io/diagnostics.js';
import { followObservedPagination } from '../../src/linkedin/network/pagination.js';
import type { APIRequestContext } from 'playwright';
import { coalesceRaw, coverageIsPartial } from '../../src/linkedin/exporter.js';
import { normalizeConversation } from '../../src/domain/normalize.js';
import { loadExport, persistExportResult, saveExport } from '../../src/io/export-store.js';
import type { LinkedInExport } from '../../src/domain/schema.js';

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
    expect(coalesceRaw(conversations)[0]?.sourceMetadata?.historyComplete).toBe(true);
    expect(manifest.counts.paginationPages).toBe(2);
  });

  it('fails history completion closed when any relevant event misses the parser', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-parser-miss.json', import.meta.url), 'utf8'));
    const parsed = parseNetworkPayload(fixture, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=2');
    expect(parsed.conversations[0]?.messages?.map((message) => message.id)).toEqual(['KNOWN']);
    expect(parsed.conversations[0]?.sourceMetadata).toMatchObject({ historyComplete: false, parserMisses: 1 });
    expect(parsed.misses).toBeGreaterThan(0);
  });

  it('fails closed and preserves the main export for a missed top-level REST history event', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-standalone-parser-miss.json', import.meta.url), 'utf8'));
    const parsed = parseNetworkPayload(fixture, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=2');
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]?.messages?.map((message) => message.id)).toEqual(['KNOWN-TOP']);
    expect(parsed.misses).toBe(1);
    expect(parsed.conversations[0]?.sourceMetadata).toMatchObject({ parserMisses: 1, historyComplete: false });

    const partial = coverageIsPartial({
      incomplete: false,
      listCoverageComplete: true,
      historyCoverageComplete: parsed.conversations.every((conversation) => conversation.sourceMetadata?.historyComplete === true),
      parserMisses: parsed.misses,
      warnings: [],
    });
    expect(partial).toBe(true);

    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-standalone-miss-'));
    const output = path.join(directory, 'messages.json');
    const complete: LinkedInExport = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      account: { id: 'SELF', name: 'Account Owner' },
      stats: { requestedConversationLimit: 100, exportedConversationCount: 0, exportedMessageCount: 0, partial: false, warnings: [] },
      conversations: [],
    };
    await saveExport(output, complete);
    const completeBytes = await readFile(output, 'utf8');
    const conversations = parsed.conversations.map((conversation) => normalizeConversation(conversation, 'SELF'));
    const candidate: LinkedInExport = {
      ...complete,
      exportedAt: '2026-01-02T00:00:00.000Z',
      stats: { requestedConversationLimit: 100, exportedConversationCount: conversations.length, exportedMessageCount: 1, partial, warnings: ['RELEVANT_NETWORK_EVENTS_SKIPPED'] },
      conversations,
    };
    const persisted = await persistExportResult(output, candidate);
    expect(persisted.destination).toBe(`${output}.partial`);
    expect(await readFile(output, 'utf8')).toBe(completeBytes);
    expect((await loadExport(`${output}.partial`))?.stats.partial).toBe(true);
  });

  it('derives an observed Rest.li cursor without changing the GET template', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/graphql-composite.json', import.meta.url), 'utf8'));
    const source = 'https://www.linkedin.com/voyager/api/graphql?queryId=messengerConversations&variables=(cursor:cursor-old,count:20)';
    const parsed = parseNetworkPayload(fixture, source);
    const next = decodeURIComponent(parsed.paginationUrls[0] ?? '');
    expect(next).toContain('variables=(cursor:cursor-next,count:20)');
    expect(next).toContain('queryId=messengerConversations');
  });
});
