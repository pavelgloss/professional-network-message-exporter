import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createInmailWitness } from '../../scripts/manual-tests/inmail-witness.js';
import { parseNetworkPayload } from '../../src/linkedin/network/response-parser.js';
import { normalizeConversation } from '../../src/domain/normalize.js';
import { ExportSchema } from '../../src/domain/schema.js';

it('independently detects subject substitution after normalization without exposing content', async () => {
  const payload = JSON.parse(await readFile(new URL('../fixtures/network/inmail-body-integrity.json', import.meta.url), 'utf8'));
  const witness = createInmailWitness();
  const parsed = parseNetworkPayload(payload);
  witness.observe(payload, parsed.misses);
  const data = ExportSchema.parse({ schemaVersion: 1, exportedAt: '2026-09-26T00:00:00.000Z', account: { id: 'SELF', name: 'Account Owner' },
    stats: { requestedConversationLimit: 1, exportedConversationCount: 1, exportedMessageCount: 2, partial: true, warnings: [] },
    conversations: parsed.conversations.map((raw) => normalizeConversation(raw, 'SELF')) });
  expect(witness.compare(data)).toMatchObject({ passed: true, checked: 2, inbound: 1, outbound: 1, distinctSubjectBody: 2, attachmentOnly: 0, mismatches: 0, partial: true });
  const sameSubjectPayload = structuredClone(payload);
  for (const event of sameSubjectPayload.elements[0].messages.elements) event.subject = event.body.text;
  const sameSubjectWitness = createInmailWitness();
  sameSubjectWitness.observe(sameSubjectPayload, 0);
  expect(sameSubjectWitness.compare(data)).toMatchObject({ passed: false, checked: 2, mismatches: 0, distinctSubjectBody: 0 });
  data.conversations[0]!.messages[0]!.text = payload.elements[0].messages.elements[0].subject;
  expect(witness.compare(data)).toMatchObject({ passed: false, mismatches: 1 });
  data.conversations[0]!.messages.pop();
  expect(witness.compare(data)).toMatchObject({ passed: false, missing: 1 });
  expect(Object.values(witness.compare(data)).every((value) => typeof value === 'number' || typeof value === 'boolean')).toBe(true);
  expect(createInmailWitness().compare(data).passed).toBe(false);
  const missed = createInmailWitness();
  missed.observe(payload, 1);
  expect(missed.compare(data)).toMatchObject({ passed: false, parserMisses: 1 });
});
