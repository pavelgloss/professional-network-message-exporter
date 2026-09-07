import { describe, expect, it } from 'vitest';
import type { APIRequestContext } from 'playwright';
import type { RawConversation } from '../../src/domain/schema.js';
import { createManifest } from '../../src/io/diagnostics.js';
import type { Logger } from '../../src/logger.js';
import { coalesceRaw } from '../../src/linkedin/exporter.js';
import { readObservedConversationHistories } from '../../src/linkedin/history-reader.js';
import type { ObservedHistoryGet } from '../../src/linkedin/probe.js';

describe('observed anchored history reader', () => {
  it('derives a byte-preserving anchor, walks backward, and emits complete contiguous evidence', async () => {
    const targetId = 'CONV';
    const conversationUrn = `urn:li:msg_conversation:${targetId}`;
    const operation = `messengerMessages.${'a'.repeat(32)}`;
    const initialVariables = `(conversationUrn:${conversationUrn},urn:urn:li:fsd_profile:SELF)`;
    const endpoint = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql';
    const initialUrl = `${endpoint}?variables=${encodeURIComponent(initialVariables)}&queryId=${operation}`;
    const newest = 1_760_000_030_000;
    const older = Array.from({ length: 20 }, (_, index) => ({
      id: `M${index + 1}`,
      deliveredAt: newest - ((index + 1) * 1_000),
    }));
    const oldest = older.at(-1)!.deliveredAt;
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
          ? payload([element('M0', newest)])
          : Number(anchor) === newest
            ? payload(older.map((value) => element(value.id, value.deliveredAt)))
            : Number(anchor) === oldest
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
      continuationUrls: [],
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

    expect(anchors).toEqual([undefined, newest, oldest]);
    expect(merged).toHaveLength(1);
    expect(new Set(merged[0]?.messages?.map((message) => message.id))).toEqual(new Set(['M0', ...older.map((value) => value.id)]));
    expect(merged[0]?.sourceMetadata).toMatchObject({ historyComplete: true });
    expect(manifest.counts).toMatchObject({
      historyOlderTemplates: 0,
      historyOlderPageSize: 20,
      historyDerivedTemplates: 1,
      historyConversationsRequested: 1,
      historyConversationsRead: 1,
      historyConversationsFailed: 0,
      historyPages: 3,
      parserMisses: 0,
    });
    expect(manifest.warnings).toEqual([]);
  });
});
