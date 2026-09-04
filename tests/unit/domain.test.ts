import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeTimestamp, canonicalLinkedInUrl } from '../../src/domain/normalize.js';
import { classifyRecruiter } from '../../src/domain/recruiter.js';
import { conversationIdFromUrn, extractUrnId, personIdFromUrn, sha256Id } from '../../src/domain/stable-id.js';
import { mergeExports } from '../../src/domain/merge.js';
import type { LinkedInExport } from '../../src/domain/schema.js';

describe('normalization and stable IDs', () => {
  it('normalizes time and strips URL tracking', () => {
    expect(normalizeTimestamp(1_725_000_000_000)).toBe('2024-08-30T06:40:00.000Z');
    expect(canonicalLinkedInUrl('https://linkedin.com/in/jane/?trk=x#y')).toBe('https://www.linkedin.com/in/jane');
    expect(sha256Id('x', [' žluťoučký '])).toBe(sha256Id('x', ['žluťoučký']));
  });

  it('parses typed and composite URNs without truncating identity', () => {
    const composite = 'urn:li:msg_conversation:(urn:li:fsd_profile:ABC,2-XYZ)';
    expect(extractUrnId(composite)).toBe('(urn:li:fsd_profile:ABC,2-XYZ)');
    expect(conversationIdFromUrn(composite)).toBe('2-XYZ');
    expect(personIdFromUrn('urn:li:fs_miniProfile:ABC')).toBe('ABC');
    expect(personIdFromUrn(composite)).toBeUndefined();
  });

  it('creates a normalized direction and stable fallback ID', () => {
    const raw = { participants: [{ id: 'me', name: 'Me', isSelf: true }, { id: 'p1', name: 'Jane' }], messages: [{ senderId: 'p1', senderName: 'Jane', sentAt: 1_725_000_000_000, text: ' Hi\r\nthere ' }] };
    const a = normalizeConversation(raw, 'me');
    const b = normalizeConversation(raw, 'me');
    expect(a.id).toBe(b.id);
    expect(a.messages[0]).toMatchObject({ direction: 'inbound', text: 'Hi\nthere', sequence: 0 });
  });

  it('keeps deterministic ordinal IDs for identical fallback messages', () => {
    const raw = { id: 'c', participants: [{ id: 'me', name: 'Me', isSelf: true }], messages: [0, 1].map(() => ({ senderId: 'me', senderName: 'Me', sentAt: '2026-01-01T00:00:00Z', text: 'same' })) };
    const messages = normalizeConversation(raw, 'me').messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe(`${messages[0]?.id}_2`);
  });

  it('fails closed for missing or unlinked sender identity', () => {
    expect(() => normalizeConversation({ id: 'c', participants: [{ id: 'me', name: 'Me', isSelf: true }], messages: [{ text: 'ambiguous' }] }, 'me')).toThrow(/sender identity/);
    expect(() => normalizeConversation({ id: 'c', participants: [{ id: 'other', name: 'Other' }], messages: [{ senderId: 'unlinked', senderName: 'Unknown', text: 'ambiguous' }] }, 'me')).toThrow(/cannot be proven/);
  });

  it('matches self across supported person URN namespaces', () => {
    const conversation = normalizeConversation({ id: 'c', participants: [{ entityUrn: 'urn:li:fs_miniProfile:ABC', name: 'Me', isSelf: true }], messages: [{ senderId: personIdFromUrn('urn:li:fsd_profile:ABC')!, senderName: 'Me', text: 'sent' }] }, 'ABC');
    expect(conversation.messages[0]?.direction).toBe('outbound');
  });
});

describe('recruiter classification', () => {
  it('is conservative and never classifies self', () => {
    expect(classifyRecruiter({ isSelf: false, headline: 'Senior Technical Recruiter' }).probablyRecruiter).toBe(true);
    expect(classifyRecruiter({ isSelf: false, messages: ['We have an open role', 'Would you join an interview?'] }).probablyRecruiter).toBe(true);
    expect(classifyRecruiter({ isSelf: false, messages: ['We are hiring in our own team'] }).probablyRecruiter).toBe(false);
    expect(classifyRecruiter({ isSelf: true, headline: 'Recruiter' }).probablyRecruiter).toBe(false);
  });
});

describe('merge', () => {
  const make = (texts: string[]): LinkedInExport => {
    const conversation = normalizeConversation({ id: 'c1', lastActivityAt: '2026-01-01T00:00:00Z', participants: [{ id: 'me', name: 'Me', isSelf: true }, { id: 'p1', name: 'Jane', headline: 'Recruiter' }], messages: texts.map((text, i) => ({ id: `m${i}`, senderId: 'p1', senderName: 'Jane', sentAt: `2026-01-0${i + 1}T00:00:00Z`, text })) }, 'me');
    return { schemaVersion: 1, exportedAt: '2026-01-03T00:00:00.000Z', account: { id: 'me', name: 'Me' }, stats: { requestedConversationLimit: 100, exportedConversationCount: 1, exportedMessageCount: texts.length, partial: false, warnings: [] }, conversations: [conversation] };
  };
  it('is idempotent and keeps prior history', () => {
    const first = make(['one']);
    expect(mergeExports(first, first).conversations[0]?.messages).toHaveLength(1);
    expect(mergeExports(first, make(['one', 'two'])).conversations[0]?.messages.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('merges conversation URN, plain ID, and route aliases without duplication', () => {
    const old = make(['one']);
    old.conversations[0]!.entityUrn = 'urn:li:messagingThread:c1';
    old.conversations[0]!.url = 'https://www.linkedin.com/messaging/thread/c1';
    const next = make(['one', 'two']);
    delete next.conversations[0]!.entityUrn;
    const merged = mergeExports(old, next);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.conversations[0]?.messages).toHaveLength(2);
  });

  it('preserves stronger account identity across a weak partial run', () => {
    const old = make([]);
    old.account = { id: 'ABC', entityUrn: 'urn:li:fsd_profile:ABC', name: 'Stable', profileUrl: 'https://www.linkedin.com/in/account' };
    old.conversations = [];
    const next = make([]);
    next.account = { id: 'self_weak', name: 'Localized label', profileUrl: 'https://www.linkedin.com/in/account' };
    next.conversations = [];
    expect(mergeExports(old, next).account).toMatchObject({ id: 'ABC', entityUrn: 'urn:li:fsd_profile:ABC', profileUrl: 'https://www.linkedin.com/in/account' });
  });

  it('upgrades fallback message identity through an unambiguous fingerprint', () => {
    const old = make(['one']);
    old.conversations[0]!.messages[0]!.id = 'message_fallback';
    const next = make(['one']);
    next.conversations[0]!.messages[0]!.id = 'linkedin-message-id';
    const merged = mergeExports(old, next);
    expect(merged.conversations[0]?.messages.map((message) => message.id)).toEqual(['linkedin-message-id']);
  });
});
