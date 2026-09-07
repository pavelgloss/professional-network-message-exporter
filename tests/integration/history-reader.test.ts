import { describe, expect, it } from 'vitest';
import type { APIRequestContext } from 'playwright';
import type { RawConversation } from '../../src/domain/schema.js';
import { createManifest } from '../../src/io/diagnostics.js';
import type { Logger } from '../../src/logger.js';
import { coalesceRaw } from '../../src/linkedin/exporter.js';
import { readObservedConversationHistories } from '../../src/linkedin/history-reader.js';
import type { ObservedHistoryGet } from '../../src/linkedin/probe.js';

describe('observed anchored history reader', () => {
  it('walks backward to a short terminal page and emits complete contiguous evidence', async () => {
    const targetId = 'CONV';
    const conversationUrn = `urn:li:msg_conversation:${targetId}`;
    const operation = `messengerMessages.${'a'.repeat(32)}`;
    const initialVariables = `(conversationUrn:${conversationUrn},urn:urn:li:fsd_profile:SELF)`;
    const anchoredVariables = `(deliveredAt:1760000004000,conversationUrn:${conversationUrn},urn:urn:li:fsd_profile:SELF,countBefore:2,countAfter:0)`;
    const endpoint = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql';
    const initialUrl = `${endpoint}?variables=${encodeURIComponent(initialVariables)}&queryId=${operation}`;
    const anchoredUrl = `${endpoint}?variables=${encodeURIComponent(anchoredVariables)}&queryId=${operation}`;
    const times = {
      newest: 1_760_000_003_000,
      middle: 1_760_000_002_000,
      oldest: 1_760_000_001_000,
    };
    const element = (id: string, deliveredAt: number) => ({
      entityUrn: `urn:li:messagingMessage:${id}`,
      backendConversationUrn: `urn:li:messagingThread:${targetId}`,
      sender: { hostIdentityUrn: 'urn:li:fsd_profile:EXT', name: 'External' },
      deliveredAt,
      body: { text: `message-${id}` },
    });
    const payload = (elements: unknown[]) => ({ data: { operationSpecificField: { elements } } });
    const anchors: Array<number | undefined> = [];
    const fakeRequest = {
      get: async (url: string) => {
        const variables = decodeURIComponent(new URL(url).searchParams.get('variables') ?? '');
        const anchor = /(?:^|\()deliveredAt:(\d+)/.exec(variables)?.[1];
        anchors.push(anchor ? Number(anchor) : undefined);
        const value = !anchor
          ? payload([element('M3', times.newest)])
          : Number(anchor) === times.newest
            ? payload([element('M2', times.middle), element('M1', times.oldest)])
            : Number(anchor) === times.oldest
              ? payload([])
              : payload([element('UNEXPECTED', Number(anchor))]);
        return {
          status: () => 200,
          ok: () => true,
          headers: () => ({}),
          body: async () => Buffer.from(JSON.stringify(value)),
        };
      },
    } as unknown as APIRequestContext;
    const observed: ObservedHistoryGet = {
      url: initialUrl,
      headers: {},
      targetIds: [targetId],
      seedConversations: [],
      paginationUrls: [],
      continuationUrls: [anchoredUrl],
    };
    const conversations: RawConversation[] = [{
      id: targetId,
      entityUrn: `urn:li:messagingThread:${targetId}`,
      participants: [],
      messages: [],
    }];
    const manifest = createManifest();
    const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;

    const pages = await readObservedConversationHistories(fakeRequest, observed, conversations, manifest, logger);
    const merged = coalesceRaw(pages);

    expect(anchors).toEqual([undefined, times.newest, times.oldest]);
    expect(merged).toHaveLength(1);
    expect(new Set(merged[0]?.messages?.map((message) => message.id))).toEqual(new Set(['M1', 'M2', 'M3']));
    expect(merged[0]?.sourceMetadata).toMatchObject({ historyComplete: true });
    expect(manifest.counts).toMatchObject({
      historyOlderTemplates: 1,
      historyOlderPageSize: 2,
      historyConversationsRequested: 1,
      historyConversationsRead: 1,
      historyConversationsFailed: 0,
      historyPages: 3,
      parserMisses: 0,
    });
    expect(manifest.warnings).toEqual([]);
  });
});
