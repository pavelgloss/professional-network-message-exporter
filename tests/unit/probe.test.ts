import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { RawConversation } from '../../src/domain/schema.js';
import { assertSafeProbeConversation, navigateOneSafeProbeThread, observedHistoryQueryTemplate, selectSafeProbeConversation } from '../../src/linkedin/probe.js';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { explicitProbeGraphqlConversationIds } from '../../src/linkedin/probe-navigation.js';
import { instantiateObservedHistoryUrl, instantiateObservedSyncUrl } from '../../src/linkedin/history-reader.js';

describe('one already-read thread probe', () => {
  const readConversation: RawConversation = {
    id: 'READ', url: 'https://www.linkedin.com/messaging/thread/READ/', sourceMetadata: { read: true, readEvidence: 'network-explicit' },
  };

  const paddedReadConversation: RawConversation = {
    id: 'READ==', url: 'https://www.linkedin.com/messaging/thread/READ%3D%3D/', sourceMetadata: { read: true, readEvidence: 'network-explicit' },
  };

  it('accepts only exact thread URLs with explicit network read=true evidence', () => {
    expect(selectSafeProbeConversation([
      { id: 'UNREAD', url: 'https://www.linkedin.com/messaging/thread/UNREAD/', sourceMetadata: { read: false } },
      { id: 'UNKNOWN', url: 'https://www.linkedin.com/messaging/thread/UNKNOWN/' },
      readConversation,
    ])).toBe(readConversation);
    expect(() => selectSafeProbeConversation([
      { id: 'UNREAD', url: 'https://www.linkedin.com/messaging/thread/UNREAD/', sourceMetadata: { read: false } },
      { id: 'UNKNOWN', url: 'https://www.linkedin.com/messaging/thread/UNKNOWN/' },
    ])).toThrow(/explicit read=true/);
    expect(() => assertSafeProbeConversation({ ...readConversation, url: 'https://www.linkedin.com/messaging/thread/READ/extra' })).toThrow();
    expect(() => assertSafeProbeConversation({ ...readConversation, url: 'https://evil.example/messaging/thread/READ/' })).toThrow();
    expect(() => assertSafeProbeConversation({ ...readConversation, id: 'OTHER' })).toThrow();
    expect(assertSafeProbeConversation({
      ...readConversation,
      entityUrn: 'urn:li:messagingThread:READ',
      url: `https://www.linkedin.com/messaging/thread/${encodeURIComponent('urn:li:messagingThread:READ')}/`,
    }).pathname).toContain('/messaging/thread/');
    expect(() => assertSafeProbeConversation({ url: 'https://www.linkedin.com/messaging/thread/READ/', sourceMetadata: { read: true, readEvidence: 'network-explicit' } })).toThrow();
    expect(assertSafeProbeConversation(paddedReadConversation).pathname).toBe('/messaging/thread/READ%3D%3D/');
    expect(assertSafeProbeConversation({
      ...paddedReadConversation,
      entityUrn: 'urn:li:msg_conversation:(urn:li:fsd_profile:SELF,READ==)',
    }).pathname).toBe('/messaging/thread/READ%3D%3D/');
    expect(selectSafeProbeConversation([readConversation, paddedReadConversation], new Set(['READ==']))).toBe(paddedReadConversation);
  });

  it('preserves explicit read booleans and trusted unreadCount evidence from network conversations', () => {
    const source = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations';
    const payload = (state: Record<string, unknown>) => ({ data: { messengerConversations: { elements: [{ entityUrn: 'urn:li:messagingThread:ONE', participants: [{ id: 'P' }], events: [], ...state }] } } });
    const make = (state: Record<string, unknown>) => parseNetworkPayload(payload(state), source, { observedMethod: 'GET' }).conversations[0];
    expect(make({ read: true })?.sourceMetadata?.read).toBe(true);
    expect(make({ read: false })?.sourceMetadata?.read).toBe(false);
    expect(make({ unreadCount: 0 })?.sourceMetadata?.read).toBe(true);
    expect(make({ unreadCount: 2 })?.sourceMetadata?.read).toBe(false);
    expect(make({ unreadCount: -1 })?.sourceMetadata?.read).toBeUndefined();
    const renamed = parseNetworkPayload({ data: { messengerConversationsByCategory: { elements: [{ entityUrn: 'urn:li:messagingThread:RENAMED', participants: [{ id: 'P' }], events: [], unreadCount: 0 }] } } }, source, { observedMethod: 'GET' });
    expect(renamed.conversations[0]?.sourceMetadata?.read).toBe(true);
    expect(parseNetworkPayload(payload({ read: true }), source).conversations[0]?.sourceMetadata?.read).toBeUndefined();
    expect(parseNetworkPayload(payload({ read: true }), source, { observedMethod: 'POST' }).conversations[0]?.sourceMetadata?.read).toBeUndefined();
    expect(parseNetworkPayload(payload({ read: true }), 'https://tracking.linkedin.com/random/conversation.json', { observedMethod: 'GET' }).conversations[0]?.sourceMetadata?.read).toBeUndefined();
    expect(parseNetworkPayload(payload({ read: true }), 'https://www.linkedin.com/unrelated/conversation.json', { observedMethod: 'GET' }).conversations[0]?.sourceMetadata?.read).toBeUndefined();
    expect(parseNetworkPayload({ data: { unrelated: payload({ read: true }) } }, source, { observedMethod: 'GET' }).conversations[0]?.sourceMetadata?.read).toBeUndefined();
    const mixed = parseNetworkPayload({
      ...payload({ read: true }),
      tracking: { entityUrn: 'urn:li:messagingThread:TRACKING', participants: [{ id: 'P' }], events: [], read: true },
    }, source, { observedMethod: 'GET' });
    expect(mixed.conversations.find((conversation) => conversation.id === 'ONE')?.sourceMetadata?.read).toBe(true);
    expect(mixed.conversations.find((conversation) => conversation.id === 'TRACKING')?.sourceMetadata?.read).toBeUndefined();
  });

  it('rejects a read=true candidate when the same network identity has conflicting read=false evidence', () => {
    expect(() => selectSafeProbeConversation([
      readConversation,
      { id: 'READ', url: 'https://www.linkedin.com/messaging/thread/READ/', sourceMetadata: { read: false, readEvidence: 'network-explicit' } },
    ])).toThrow(/No network conversation/);
  });

  it('performs exactly one thread navigation with no retry or iteration', async () => {
    const goto = vi.fn(async (_url: string, _options?: object) => null);
    await navigateOneSafeProbeThread({ goto } as unknown as Pick<Page, 'goto'>, readConversation, 5_000);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[0]).toBe('https://www.linkedin.com/messaging/thread/READ/');
  });

  it('converts raw navigation errors to a URL-free policy error', async () => {
    const canary = 'pavelPrivateConversation';
    const goto = vi.fn(async (_url: string, _options?: object) => { throw new Error(`page.goto https://www.linkedin.com/messaging/thread/${canary}/`); });
    await expect(navigateOneSafeProbeThread({ goto } as unknown as Pick<Page, 'goto'>, readConversation, 5_000)).rejects.not.toThrow(canary);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('records only safe GET history template metadata and redacts opaque paths and query values', () => {
    const canary = 'privateAlphabeticIdentifier';
    const template = observedHistoryQueryTemplate('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=${canary}`, [canary]);
    expect(template).toEqual({
      method: 'GET', origin: 'https://www.linkedin.com',
      pathShape: '/voyager/api/voyagermessaginggraphql/graphql',
      queryParameterNames: ['<opaque-key>', 'queryid'],
    });
    expect(JSON.stringify(template)).not.toContain(canary);
    expect(observedHistoryQueryTemplate('POST', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=${canary}`, [canary])).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', 'https://www.linkedin.com/voyager/api/graphql?queryId=sendMessageMutation', [canary])).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', `https://evil.example/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=${canary}`, [canary])).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=OTHER`, [canary])).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.${'b'.repeat(32)}&conversationId=${canary}`, [canary])).toBeDefined();
    for (const separator of ['%C2%85', '%E2%80%8B', '%C2%AD', '%E2%80%AE', '%25E2%2580%258B']) {
      expect(observedHistoryQueryTemplate('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessa${separator}ges&conversationId=${canary}`, [canary])).toBeUndefined();
    }
  });

  it('extracts explicit conversation identities only from the exact Dash GET path', () => {
    const path = '/voyager/api/voyagerMessagingGraphQL/graphql';
    const ids = explicitProbeGraphqlConversationIds('GET', `https://www.linkedin.com${path}?queryId=messengerMessagesByConversation&variables=(conversationUrn:urn%3Ali%3AmessagingThread%3AOTHER)`);
    expect([...ids]).toEqual(['OTHER']);
    expect([...explicitProbeGraphqlConversationIds('GET', `https://www.linkedin.com${path}?queryId=messengerMessagesByConversation&variables=(conversationUrn:OTHER)`)]).toEqual(['OTHER']);
    expect(explicitProbeGraphqlConversationIds('GET', 'https://www.linkedin.com/voyager/api/graphql?urn=urn%3Ali%3AmessagingThread%3AOTHER').size).toBe(0);
    expect(explicitProbeGraphqlConversationIds('POST', 'https://www.linkedin.com/voyager/api/graphql?urn=urn%3Ali%3AmessagingThread%3AOTHER').size).toBe(0);
  });

  it('rebinds only the target identity while preserving an observed history URL encoding', () => {
    const oldId = 'READ==';
    const newId = 'NEXT==';
    const variables = encodeURIComponent(JSON.stringify({
      conversationUrn: `urn:li:messagingThread:${oldId}`,
      mailboxUrn: 'urn:li:fsd_profile:SELF',
    }));
    const template = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?variables=${variables}&queryId=messengerMessages.${'a'.repeat(32)}&includeWebMetadata=true`;
    const rebound = instantiateObservedHistoryUrl(template, [oldId], newId);
    expect(rebound).toBe(template.replace(encodeURIComponent(oldId), encodeURIComponent(newId)));
    expect(instantiateObservedHistoryUrl(template, [oldId], oldId)).toBe(template);
    expect(() => instantiateObservedHistoryUrl(template, [oldId], 'UNSAFE/ID')).toThrow(/identity/);
  });

  it('leaves unrelated tracking fields and persisted query bytes unchanged when rebinding', () => {
    const oldId = 'ABCDEF123==';
    const newId = 'ZYX987654==';
    const variables = encodeURIComponent(JSON.stringify({
      conversationUrn: `urn:li:messagingThread:${oldId}`,
      tracking: oldId,
    }));
    const queryId = `messengerMessages.${'a'.repeat(32)}`;
    const template = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?variables=${variables}&queryId=${queryId}`;
    const rebound = instantiateObservedHistoryUrl(template, [oldId], newId);
    const decodedVariables = JSON.parse(new URL(rebound).searchParams.get('variables')!) as Record<string, string>;
    expect(decodedVariables).toEqual({ conversationUrn: `urn:li:messagingThread:${newId}`, tracking: oldId });
    expect(new URL(rebound).searchParams.get('queryId')).toBe(queryId);
  });

  it('adds a sync token only inside the raw Rest.li variables parameter', () => {
    const id = 'READ==';
    const variables = `(conversationUrn:${encodeURIComponent(`urn:li:msg_conversation:(urn:li:fsd_profile:SELF,${id})`)},urn:${encodeURIComponent('urn:li:fsd_profile:SELF')})`;
    const queryId = `messengerMessages.${'a'.repeat(32)}`;
    const source = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?variables=${variables}&queryId=${queryId}&includeWebMetadata=true`;
    const next = instantiateObservedSyncUrl(source, id, 'opaque+/==');
    const variableSuffix = '&queryId=';
    const boundary = source.indexOf(variableSuffix);
    const expected = `${source.slice(0, boundary - 1)},syncToken:<redacted>)${source.slice(boundary)}`;
    expect(next.replace(/syncToken:[^)]*/, 'syncToken:<redacted>')).toBe(expected);
    expect(decodeURIComponent(new URL(next).searchParams.get('variables')!)).toContain('syncToken:opaque+/==');
    expect(new URL(next).searchParams.get('queryId')).toBe(queryId);
    expect(() => instantiateObservedSyncUrl(next, id, 'another')).toThrow(/Rest.li variable shape/);
  });
});
