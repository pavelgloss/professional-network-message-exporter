import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeTimestamp, canonicalLinkedInUrl } from '../../src/domain/normalize.js';
import { classifyRecruiter } from '../../src/domain/recruiter.js';
import { sha256Id } from '../../src/domain/stable-id.js';
import { mergeExports } from '../../src/domain/merge.js';
import type { LinkedInExport } from '../../src/domain/schema.js';

describe('normalization and stable IDs', () => {
  it('normalizes time and strips URL tracking', () => {
    expect(normalizeTimestamp(1_725_000_000_000)).toBe('2024-08-30T06:40:00.000Z');
    expect(canonicalLinkedInUrl('https://linkedin.com/in/jane/?trk=x#y')).toBe('https://www.linkedin.com/in/jane');
    expect(sha256Id('x', [' žluťoučký '])).toBe(sha256Id('x', ['žluťoučký']));
  });

  it('creates a normalized direction and stable fallback ID', () => {
    const raw = { participants: [{ id: 'me', name: 'Me', isSelf: true }, { id: 'p1', name: 'Jane' }], messages: [{ senderId: 'p1', senderName: 'Jane', sentAt: 1_725_000_000_000, text: ' Hi\r\nthere ' }] };
    const a = normalizeConversation(raw, 'me');
    const b = normalizeConversation(raw, 'me');
    expect(a.id).toBe(b.id);
    expect(a.messages[0]).toMatchObject({ direction: 'inbound', text: 'Hi\nthere', sequence: 0 });
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
});

