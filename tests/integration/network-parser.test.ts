import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNetworkPayload, type ParsedNetworkData } from '../../src/linkedin/network/response-parser.js';
import { assertAllowedReadUrl } from '../../src/linkedin/network/read-client.js';
import { createManifest } from '../../src/io/diagnostics.js';
import { followObservedPagination } from '../../src/linkedin/network/pagination.js';
import type { APIRequestContext } from 'playwright';
import { coalesceRaw, coverageIsPartial, enrichParticipantNamesFromDomHints } from '../../src/linkedin/exporter.js';
import { normalizeConversation } from '../../src/domain/normalize.js';
import { loadExport, persistExportResult, saveExport } from '../../src/io/export-store.js';
import type { LinkedInExport, RawConversation } from '../../src/domain/schema.js';

async function expectPartialPersistence(parsed: ParsedNetworkData, prefix: string): Promise<void> {
  const partial = coverageIsPartial({
    incomplete: false,
    listCoverageComplete: true,
    historyCoverageComplete: parsed.conversations.every((conversation) => conversation.sourceMetadata?.historyComplete === true),
    parserMisses: parsed.misses,
    warnings: [],
  });
  expect(partial).toBe(true);

  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
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
    stats: { requestedConversationLimit: 100, exportedConversationCount: conversations.length, exportedMessageCount: conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0), partial, warnings: ['RELEVANT_NETWORK_EVENTS_SKIPPED'] },
    conversations,
  };
  const persisted = await persistExportResult(output, candidate);
  expect(persisted.destination).toBe(`${output}.partial`);
  expect(await readFile(output, 'utf8')).toBe(completeBytes);
  expect((await loadExport(`${output}.partial`))?.stats.partial).toBe(true);
}

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
    expect(assertAllowedReadUrl('https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation').pathname).toBe('/voyager/api/voyagerMessagingGraphQL/graphql');
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

  it('parses current Dash messaging identities without duplicating embedded conversation references', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/dash-messaging-graphql.json', import.meta.url), 'utf8'));
    const source = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations';
    const parsed = parseNetworkPayload(fixture, source);

    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]).toMatchObject({
      id: 'CONV-ONE',
      entityUrn: 'urn:li:fsd_messengerConversation:CONV-ONE',
      url: 'https://www.linkedin.com/messaging/thread/CONV-ONE/',
    });
    expect(parsed.conversations[0]?.participants).toEqual([
      expect.objectContaining({ id: 'SELF', entityUrn: 'urn:li:fsd_profile:SELF', name: 'Account Owner' }),
      expect.objectContaining({ id: 'EXT', entityUrn: 'urn:li:fsd_profile:EXT', name: 'External Person' }),
    ]);
    expect(parsed.conversations[0]?.messages).toEqual([
      expect.objectContaining({ id: 'EVENT-ONE', conversationId: 'CONV-ONE', senderId: 'EXT', senderName: 'External Person', text: 'Modern Dash message' }),
    ]);
    expect(parsed.conversations[0]?.sourceMetadata).toMatchObject({ historyComplete: false, parserMisses: 1 });
    expect(parsed.misses).toBe(1);
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

    await expectPartialPersistence(parsed, 'linkedin-standalone-miss-');
  });

  it('resolves top-level event references and fails closed for referenced unsupported content', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-referenced-parser-miss.json', import.meta.url), 'utf8'));
    const parsed = parseNetworkPayload(fixture, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=2');
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]?.messages?.map((message) => message.id)).toEqual(['KNOWN-REF']);
    expect(parsed.conversations[0]?.participants).toEqual([expect.objectContaining({ id: 'EXT-REF', name: 'External Reference' })]);
    expect(parsed.misses).toBe(1);
    expect(parsed.conversations[0]?.sourceMetadata).toMatchObject({ parserMisses: 1, historyComplete: false });
    await expectPartialPersistence(parsed, 'linkedin-reference-miss-');
  });

  it('counts unresolved message refs, ignores profile refs, and deduplicates repeated refs', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-referenced-parser-miss.json', import.meta.url), 'utf8'));
    fixture.elements = [
      'urn:li:messagingMessage:KNOWN-REF',
      'urn:li:messagingMessage:KNOWN-REF',
      'urn:li:messagingMessage:MISSING-REF',
      'urn:li:messagingMessage:MISSING-REF',
      'urn:li:fsd_profile:MISSING-PROFILE',
    ];
    fixture.paging = { start: 0, count: 2, total: 2, hasNextPage: false, links: [] };
    const parsed = parseNetworkPayload(fixture, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=2');
    expect(parsed.conversations[0]?.messages?.map((message) => message.id)).toEqual(['KNOWN-REF']);
    expect(parsed.misses).toBe(1);
    expect(parsed.conversations[0]?.sourceMetadata?.historyComplete).toBe(false);
  });

  it('bounds cyclic included reference resolution and fails an event chain closed', () => {
    const parsed = parseNetworkPayload({
      elements: ['urn:li:collection:CHAIN-A'],
      included: [
        { entityUrn: 'urn:li:collection:CHAIN-A', '*event': 'urn:li:collection:CHAIN-B' },
        { entityUrn: 'urn:li:collection:CHAIN-B', '*event': 'urn:li:collection:CHAIN-A' },
      ],
      paging: { start: 0, count: 1, total: 1, hasNextPage: false },
    }, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=1');
    expect(parsed.misses).toBe(1);
    expect(parsed.conversations).toHaveLength(0);
  });

  it('preserves ordered id-less event multiplicity and deterministic fallback IDs', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-idless-events.json', import.meta.url), 'utf8')) as Record<'different' | 'identical', unknown>;
    for (const name of ['different', 'identical'] as const) {
      const sourceUrl = `https://www.linkedin.com/voyager/api/messaging/history?case=${name}&start=0&count=2`;
      const first = parseNetworkPayload(fixture[name], sourceUrl);
      const repeated = parseNetworkPayload(fixture[name], sourceUrl);
      expect(first.misses).toBe(0);
      expect(first.conversations[0]?.messages).toHaveLength(2);
      expect(first.conversations[0]?.sourceMetadata?.historyComplete).toBe(true);

      const coalesced = coalesceRaw([...first.conversations, ...repeated.conversations]);
      expect(coalesced[0]?.messages).toHaveLength(2);
      const normalized = normalizeConversation(coalesced[0]!, 'SELF');
      const normalizedAgain = normalizeConversation(coalesced[0]!, 'SELF');
      expect(new Set(normalized.messages.map((message) => message.id)).size).toBe(2);
      expect(normalizedAgain.messages.map((message) => message.id)).toEqual(normalized.messages.map((message) => message.id));
      expect(normalized.messages.map((message) => message.text)).toEqual(name === 'different'
        ? ['first anonymous event', 'second anonymous event']
        : ['identical anonymous event', 'identical anonymous event']);
      if (name === 'identical') expect(normalized.messages[1]?.id).toBe(`${normalized.messages[0]?.id}_2`);
    }
  });

  it('does not collapse undefined aliases in the generic nested-message path', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-idless-events.json', import.meta.url), 'utf8')) as { identical: unknown };
    const parsed = parseNetworkPayload(fixture.identical, 'https://www.linkedin.com/voyager/api/messaging/conversations');
    expect(parsed.conversations[0]?.messages).toHaveLength(2);
  });

  it('deduplicates an actually repeated stable top-level URN reference', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/history-referenced-parser-miss.json', import.meta.url), 'utf8'));
    fixture.elements = ['urn:li:messagingMessage:KNOWN-REF', 'urn:li:messagingMessage:KNOWN-REF'];
    fixture.included = fixture.included.filter((value: { entityUrn?: string }) => value.entityUrn !== 'urn:li:messagingMessage:UNKNOWN-REF');
    fixture.paging = { start: 0, count: 1, total: 1, hasNextPage: false };
    const parsed = parseNetworkPayload(fixture, 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=1');
    expect(parsed.misses).toBe(0);
    expect(parsed.conversations[0]?.messages?.map((message) => message.id)).toEqual(['KNOWN-REF']);
    expect(parsed.conversations[0]?.sourceMetadata?.historyComplete).toBe(true);
  });

  it('derives an observed Rest.li cursor without changing the GET template', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/graphql-composite.json', import.meta.url), 'utf8'));
    const source = 'https://www.linkedin.com/voyager/api/graphql?queryId=messengerConversations&variables=(cursor:cursor-old,count:20)';
    const parsed = parseNetworkPayload(fixture, source);
    const next = decodeURIComponent(parsed.paginationUrls[0] ?? '');
    expect(next).toContain('variables=(cursor:cursor-next,count:20)');
    expect(next).toContain('queryId=messengerConversations');
  });

  it('enriches a single external participant only from a unique verified DOM preview', () => {
    const conversations: RawConversation[] = [
      { id: 'one', participants: [{ id: 'SELF' }, { id: 'EXT-ONE' }], messages: [{ senderId: 'EXT-ONE', text: 'A uniquely identifying preview message' }] },
      { id: 'two', participants: [{ id: 'SELF' }, { id: 'EXT-TWO' }], messages: [{ senderId: 'EXT-TWO', text: 'An ambiguous repeated preview' }] },
      { id: 'three', participants: [{ id: 'SELF' }, { id: 'EXT-THREE' }], messages: [{ senderId: 'EXT-THREE', text: 'An ambiguous repeated preview' }] },
    ];
    const enriched = enrichParticipantNamesFromDomHints(conversations, [
      { participantName: 'Verified Person', messageSnippet: 'External Person sent: A uniquely identifying preview message' },
      { participantName: 'Must Not Be Guessed', messageSnippet: 'An ambiguous repeated preview' },
    ], 'SELF');

    expect(enriched).toBe(1);
    expect(conversations[0]?.participants?.[1]?.name).toBe('Verified Person');
    expect(conversations[1]?.participants?.[1]?.name).toBeUndefined();
    expect(conversations[2]?.participants?.[1]?.name).toBeUndefined();
  });
});
