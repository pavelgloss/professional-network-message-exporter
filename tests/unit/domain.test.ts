import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeTimestamp, canonicalLinkedInUrl } from '../../src/domain/normalize.js';
import { classifyRecruiter } from '../../src/domain/recruiter.js';
import { conversationIdFromUrn, extractUrnId, personIdFromUrn, sha256Id } from '../../src/domain/stable-id.js';
import { mergeExports } from '../../src/domain/merge.js';
import { ExportSchema, type LinkedInExport } from '../../src/domain/schema.js';
import { coalesceRaw } from '../../src/linkedin/exporter.js';

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
    expect(conversationIdFromUrn('urn:li:messengerConversation:CONV')).toBe('CONV');
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

  it('preserves auditable conversation history coverage metadata', () => {
    const conversation = normalizeConversation({
      id: 'c',
      participants: [{ id: 'me', name: 'Me', isSelf: true }],
      messages: [{ id: 'm', senderId: 'me', senderName: 'Me', text: 'sent' }],
      sourceMetadata: { historyComplete: true, historyEvidence: '[]' },
    }, 'me');
    expect(conversation.sourceMetadata).toEqual({ historyComplete: true, historyEvidence: '[]' });
  });

  it('keeps deterministic ordinal IDs for identical fallback messages', () => {
    const raw = { id: 'c', participants: [{ id: 'me', name: 'Me', isSelf: true }], messages: [0, 1].map(() => ({ senderId: 'me', senderName: 'Me', sentAt: '2026-01-01T00:00:00Z', text: 'same' })) };
    const messages = normalizeConversation(raw, 'me').messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.id).toBe(`${messages[0]?.id}_2`);
  });

  it('preserves the multiset of identical raw fallback messages through coalescing', () => {
    const duplicate = { conversationId: 'c', senderId: 'me', senderName: 'Me', sentAt: '2026-01-01T00:00:00Z', text: 'same' };
    const conversations = coalesceRaw([
      { id: 'c', messages: [{ ...duplicate }, { ...duplicate }] },
      { id: 'c', messages: [{ ...duplicate }, { ...duplicate }] },
    ]);
    expect(conversations[0]?.messages).toHaveLength(2);
  });

  it('adds disjoint fallback pages but does not duplicate a repeated page snapshot', () => {
    const duplicate = { conversationId: 'c', senderId: 'me', senderName: 'Me', sentAt: '2026-01-01T00:00:00Z', text: 'same' };
    const page = (sourcePage: string, offset: number) => ({ id: 'c', messages: [0, 1].map((index) => ({ ...duplicate, sourceOrder: offset + index, sourceMetadata: { sourcePage } })) });
    expect(coalesceRaw([page('page-1', 0), page('page-2', 2)])[0]?.messages).toHaveLength(4);
    expect(coalesceRaw([page('page-1', 0), page('page-1', 0)])[0]?.messages).toHaveLength(2);
  });

  it('indexes stable raw messages by both plain ID and URN aliases', () => {
    const base = { conversationId: 'c', senderId: 'me', senderName: 'Me', text: 'same' };
    const conversation = coalesceRaw([
      { id: 'c', messages: [{ ...base, id: 'M', entityUrn: 'urn:li:messagingMessage:M' }] },
      { id: 'c', messages: [{ ...base, entityUrn: 'urn:li:messagingMessage:M' }] },
    ])[0]!;
    expect(conversation.messages).toHaveLength(1);
    expect(normalizeConversation({ ...conversation, participants: [{ id: 'me', name: 'Me', isSelf: true }] }, 'me').messages.map((message) => message.id)).toEqual(['M']);
  });

  it('does not add a name-only DOM participant beside authoritative network participants', () => {
    const conversation = coalesceRaw([
      { id: 'c', participants: [{ id: 'p', entityUrn: 'urn:li:fsd_profile:p', name: 'Jane', profileUrl: 'https://www.linkedin.com/in/jane' }] },
      { id: 'c', participants: [{ name: 'Jane' }] },
    ])[0]!;
    expect(conversation.participants).toEqual([expect.objectContaining({ id: 'p', name: 'Jane' })]);
  });

  it('fails closed for missing or unlinked sender identity', () => {
    expect(() => normalizeConversation({ id: 'c', participants: [{ id: 'me', name: 'Me', isSelf: true }], messages: [{ text: 'ambiguous' }] }, 'me')).toThrow(/sender identity/);
    expect(() => normalizeConversation({ id: 'c', participants: [{ id: 'other', name: 'Other' }], messages: [{ senderId: 'unlinked', senderName: 'Unknown', text: 'ambiguous' }] }, 'me')).toThrow(/cannot be proven/);
    expect(() => normalizeConversation({ id: 'c', participants: [{ id: 'other', name: 'Other' }], messages: [{ senderId: 'other', senderName: 'Other', text: 'ambiguous DOM', sourceMetadata: { directionEvidence: 'unknown-dom' } }] }, 'me')).toThrow(/DOM message direction is ambiguous/);
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
    next.conversations[0]!.participants[0]!.id = 'self_weak';
    next.conversations[0]!.messages = [{ id: 'out', conversationId: 'c1', senderId: 'self_weak', senderName: 'Localized label', direction: 'outbound', sequence: 0, text: 'sent' }];
    const merged = mergeExports(old, next);
    expect(merged.account).toMatchObject({ id: 'ABC', entityUrn: 'urn:li:fsd_profile:ABC', profileUrl: 'https://www.linkedin.com/in/account' });
    expect(merged.conversations[0]?.messages[0]?.senderId).toBe('ABC');
  });

  it('upgrades fallback message identity through an unambiguous fingerprint', () => {
    const old = make(['one']);
    old.conversations[0]!.messages[0]!.id = 'message_fallback';
    const next = make(['one']);
    next.conversations[0]!.messages[0]!.id = 'linkedin-message-id';
    const merged = mergeExports(old, next);
    expect(merged.conversations[0]?.messages.map((message) => message.id)).toEqual(['linkedin-message-id']);
  });

  it('schema rejects duplicate IDs and broken sender references', () => {
    const duplicate = make(['one']);
    duplicate.conversations.push(structuredClone(duplicate.conversations[0]!));
    expect(() => ExportSchema.parse(duplicate)).toThrow(/Duplicate conversation ID/);

    const broken = make(['one']);
    broken.conversations[0]!.messages[0]!.senderId = 'missing-participant';
    expect(() => ExportSchema.parse(broken)).toThrow(/Unknown message sender/);

    const duplicateMessage = make(['one', 'two']);
    duplicateMessage.conversations[0]!.messages[1]!.id = duplicateMessage.conversations[0]!.messages[0]!.id;
    expect(() => ExportSchema.parse(duplicateMessage)).toThrow(/Duplicate message ID/);
  });
});
