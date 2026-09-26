import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../../src/domain/normalize.js';
import { ExportSchema } from '../../src/domain/schema.js';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { coverageIsPartial } from '../../src/linkedin/exporter.js';
import { loadExport, persistExportResult } from '../../src/io/export-store.js';

const historyUrl = 'https://www.linkedin.com/voyager/api/messaging/history?start=0&count=1';
const event = (content: Record<string, unknown>) => ({
  entityUrn: 'urn:li:fsd_messageEvent:EVENT',
  backendConversationUrn: 'urn:li:msg_conversation:THREAD',
  sender: { hostIdentityUrn: 'urn:li:fsd_profile:EXT', name: 'External' },
  deliveredAt: 1760000000000,
  ...content,
});
const parsedEvent = (content: Record<string, unknown>) => parseNetworkPayload({ elements: [event(content)], paging: { start: 0, count: 1, total: 1 } }, historyUrl);

describe('InMail body integrity quality gate', () => {
  it('preserves exact bodies, identities, times, directions and attachment through persistence', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/network/inmail-body-integrity.json', import.meta.url), 'utf8'));
    const parsed = parseNetworkPayload(fixture, historyUrl);
    expect(parsed.misses).toBe(0);
    const conversations = parsed.conversations.map((raw) => normalizeConversation(raw, 'SELF'));
    const data = ExportSchema.parse({ schemaVersion: 1, exportedAt: '2026-09-26T00:00:00.000Z', account: { id: 'SELF', name: 'Account Owner' },
      stats: { requestedConversationLimit: 1, exportedConversationCount: 1, exportedMessageCount: 2, partial: false, warnings: [] }, conversations });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'inmail-quality-'));
    const output = path.join(directory, 'messages.json');
    await persistExportResult(output, data);
    const saved = await loadExport(output);
    expect(saved?.conversations[0]?.messages.map(({ id, text, sentAt, direction }) => ({ id, text, sentAt, direction }))).toEqual([
      { id: 'INMAIL-IN', text: 'Hello, would you like the project details?', sentAt: '2025-10-09T08:53:20.000Z', direction: 'inbound' },
      { id: 'INMAIL-OUT', text: 'Thank you. Please send the technical scope.', sentAt: '2025-10-09T08:53:21.000Z', direction: 'outbound' },
    ]);
    expect(saved?.conversations[0]?.messages[0]?.attachments).toBeUndefined();
    expect(saved?.conversations[0]?.messages[1]?.attachments).toEqual([{ id: 'FILE-EXAMPLE', name: 'example.pdf', type: 'application/pdf', url: 'https://www.linkedin.com/dms/document/example' }]);
    expect(saved?.conversations[0]?.messages.every((message) => message.text !== fixture.elements[0].messages.elements[0].subject)).toBe(true);

    // A new subject-only event must poison completeness, not overwrite the good file.
    fixture.elements[0].messages.elements.push(event({ subject: 'Example position at Example Company', backendConversationUrn: 'urn:li:msg_conversation:INMAIL-THREAD' }));
    const broken = parseNetworkPayload(fixture, historyUrl);
    expect(broken.misses).toBe(1);
    expect(broken.conversations[0]?.sourceMetadata?.historyComplete).toBe(false);
    const partial = coverageIsPartial({ incomplete: false, listCoverageComplete: true, historyCoverageComplete: false, parserMisses: broken.misses, warnings: [] });
    expect(partial).toBe(true);
    const before = await readFile(output, 'utf8');
    const candidate = { ...data, conversations: broken.conversations.map((raw) => normalizeConversation(raw, 'SELF')), stats: { ...data.stats, partial } };
    const result = await persistExportResult(output, candidate);
    expect(result.destination).toBe(`${output}.partial`);
    expect(await readFile(output, 'utf8')).toBe(before);
  });

  it.each([
    ['body', { body: { text: 'actual' } }],
    ['messageBody', { messageBody: { text: 'actual' } }],
    ['attributedBody', { attributedBody: { text: 'actual' } }],
    ['eventContent', { eventContent: { attributedBody: { text: 'actual' } } }],
    ['content', { content: { body: 'actual' } }],
    ['commentary', { commentary: { text: 'actual' } }],
    ['direct text', { text: 'actual' }],
  ])('extracts only the known %s body path', (_name, body) => {
    const parsed = parsedEvent({ subject: 'SUBJECT', title: 'TITLE', headline: 'HEADLINE', ...body });
    expect(parsed.misses).toBe(0);
    expect(parsed.conversations[0]?.messages?.[0]?.text).toBe('actual');
  });

  it('uses documented body precedence and skips whitespace without traversing metadata', () => {
    expect(parsedEvent({ body: { text: 'body' }, messageBody: 'messageBody', attributedBody: { text: 'attributed' }, text: 'generic' }).conversations[0]?.messages?.[0]?.text).toBe('body');
    expect(parsedEvent({ body: { text: ' \r\n ' }, messageBody: { text: ' second\r\nline ' }, text: 'generic' }).conversations[0]?.messages?.[0]?.text).toBe('second\nline');
    expect(parsedEvent({ subject: 'same', body: { text: 'same' } }).conversations[0]?.messages?.[0]?.text).toBe('same');
  });

  it.each([
    { subject: 'subject' },
    { body: { title: 'title', headline: 'headline', subject: 'subject', attributes: [{ text: 'attribute' }] } },
    { content: { unknown: { text: 'unknown wrapper' } } },
    { body: { text: '  ' }, renderContent: [{ renderer: { type: 'genericRendererDiscriminator' } }] },
    { renderContent: [{ title: 'card title', tracking: { id: 'TRACKING' }, type: 'file' }] },
    { attachments: [{ title: 'not a filename', tracking: { id: 'TRACKING' }, type: 'genericRenderer' }] },
  ])('rejects metadata as body or fake attachment and counts one miss: %#', (metadata) => {
    const parsed = parsedEvent(metadata);
    expect(parsed.misses).toBe(1);
    expect(parsed.conversations[0]?.messages).toEqual([]);
    expect(parsed.conversations[0]?.sourceMetadata).toMatchObject({ parserMisses: 1, historyComplete: false });
  });

  it('preserves meaningful attachment-only events with no subject contamination', () => {
    const parsed = parsedEvent({ subject: 'not the body', attachments: [{ id: 'FILE', name: 'file.pdf', mimeType: 'application/pdf' }] });
    expect(parsed.misses).toBe(0);
    expect(parsed.conversations[0]?.messages?.[0]?.text).toBeUndefined();
    expect(parsed.conversations[0]?.messages?.[0]?.attachments).toEqual([{ id: 'FILE', name: 'file.pdf', type: 'application/pdf' }]);
  });

  it('counts subject-only generic nested and id-less candidates and avoids envelope double counts', () => {
    const unknown = event({ subject: 'not body' });
    const idless = { ...unknown } as Record<string, unknown>;
    delete idless.entityUrn;
    const nested = parseNetworkPayload({ custom: [unknown, idless] }, '/voyager/api/messaging/conversations');
    expect(nested.misses).toBe(2);
    expect(nested.conversations[0]?.sourceMetadata?.parserMisses).toBe(2);
    const wrapped = { entityUrn: 'urn:li:msg_conversation:THREAD', events: [unknown], paging: { total: 1 } };
    const both = parseNetworkPayload({ elements: [unknown], wrapped, included: [unknown] }, historyUrl);
    expect(both.misses).toBe(1);
    expect(both.conversations[0]?.sourceMetadata?.parserMisses).toBe(1);
    const referenced = parseNetworkPayload({ elements: ['urn:li:fsd_messageEvent:EVENT'], included: [unknown] }, historyUrl);
    expect(referenced.misses).toBe(1);
  });

  it('keeps fallback identities independent of subject and bounds cyclic body wrappers', () => {
    const fallback = (subject: string) => {
      const value = event({ subject, body: { text: 'actual' } }) as Record<string, unknown>;
      delete value.entityUrn;
      return normalizeConversation(parseNetworkPayload({ elements: [value] }, historyUrl).conversations[0]!, 'SELF').messages[0];
    };
    expect(fallback('first')?.id).toBe(fallback('second')?.id);
    expect(fallback('first')?.text).toBe('actual');
    const cycle: Record<string, unknown> = { subject: 'never body' };
    cycle.body = cycle;
    expect(parsedEvent({ body: cycle }).misses).toBe(1);
  });
});
