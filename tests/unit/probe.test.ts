import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { RawConversation } from '../../src/domain/schema.js';
import { assertSafeProbeConversation, navigateOneSafeProbeThread, observedHistoryQueryTemplate, selectSafeProbeConversation } from '../../src/linkedin/probe.js';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';

describe('one already-read thread probe', () => {
  const readConversation: RawConversation = {
    id: 'READ', url: 'https://www.linkedin.com/messaging/thread/READ/', sourceMetadata: { read: true, readEvidence: 'network-explicit' },
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
  });

  it('preserves explicit read booleans from network conversations without inferring from unreadCount', () => {
    const source = 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations';
    const make = (state: Record<string, unknown>) => parseNetworkPayload({ data: { elements: [{ entityUrn: 'urn:li:messagingThread:ONE', participants: [{ id: 'P' }], events: [], ...state }] } }, source).conversations[0];
    expect(make({ read: true })?.sourceMetadata?.read).toBe(true);
    expect(make({ read: false })?.sourceMetadata?.read).toBe(false);
    expect(make({ unreadCount: 0 })?.sourceMetadata?.read).toBeUndefined();
  });

  it('performs exactly one thread navigation with no retry or iteration', async () => {
    const goto = vi.fn(async (_url: string, _options?: object) => null);
    await navigateOneSafeProbeThread({ goto } as unknown as Pick<Page, 'goto'>, readConversation, 5_000);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[0]).toBe('https://www.linkedin.com/messaging/thread/READ/');
  });

  it('records only safe GET history template metadata and redacts opaque paths and query values', () => {
    const canary = 'privateAlphabeticIdentifier';
    const template = observedHistoryQueryTemplate('GET', `https://www.linkedin.com/voyager/api/messaging/conversations/${canary}/events?queryId=messengerMessages&cursor=${canary}`);
    expect(template).toEqual({
      method: 'GET', origin: 'https://www.linkedin.com',
      pathShape: '/voyager/api/messaging/conversations/:opaque/events',
      queryParameterNames: ['cursor', 'queryid'],
    });
    expect(JSON.stringify(template)).not.toContain(canary);
    expect(observedHistoryQueryTemplate('POST', 'https://www.linkedin.com/voyager/api/messaging/messages')).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', 'https://www.linkedin.com/voyager/api/graphql?queryId=sendMessageMutation')).toBeUndefined();
    expect(observedHistoryQueryTemplate('GET', 'https://evil.example/voyager/api/messaging/messages')).toBeUndefined();
  });
});
