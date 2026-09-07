import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExport, persistExportResult, saveExport } from '../../src/io/export-store.js';
import { reuseProvenHistorySnapshots } from '../../src/linkedin/exporter.js';

describe('export store', () => {
  it('round trips a validated export and rejects corruption', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedin-export-'));
    const file = path.join(dir, 'messages.json');
    const data = { schemaVersion: 1 as const, exportedAt: '2026-01-01T00:00:00.000Z', account: { id: 'me', name: 'Me' }, stats: { requestedConversationLimit: 100, exportedConversationCount: 0, exportedMessageCount: 0, partial: false, warnings: [] }, conversations: [] };
    await saveExport(file, data);
    expect(await loadExport(file)).toEqual(data);
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
    await writeFile(file, '{bad', 'utf8');
    await expect(loadExport(file)).rejects.toThrow(/not overwritten/);
  });

  it('writes partial results beside, never over, the last complete export', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'linkedin-export-partial-'));
    const file = path.join(dir, 'messages.json');
    const complete = { schemaVersion: 1 as const, exportedAt: '2026-01-01T00:00:00.000Z', account: { id: 'me', name: 'Me' }, stats: { requestedConversationLimit: 100, exportedConversationCount: 0, exportedMessageCount: 0, partial: false, warnings: [] }, conversations: [] };
    await saveExport(file, complete);
    const completeBytes = await readFile(file, 'utf8');
    const partial = { ...complete, exportedAt: '2026-01-02T00:00:00.000Z', stats: { ...complete.stats, partial: true, warnings: ['INCOMPLETE'] } };
    const saved = await persistExportResult(file, partial);
    expect(saved.destination).toBe(`${file}.partial`);
    expect(await readFile(file, 'utf8')).toBe(completeBytes);
    expect(await loadExport(file)).toEqual(complete);
    expect((await loadExport(`${file}.partial`))?.stats.partial).toBe(true);
  });

  it('adds current messages while reusing only an exact proven history snapshot', () => {
    const evidence = JSON.stringify([{ resource: 'prior', page: 'page-0', start: 0, count: 1, end: true, valid: true }]);
    const previous = [{
      id: 'CONV',
      participants: [{ id: 'EXT', name: 'External' }],
      messages: [{ id: 'M1', conversationId: 'CONV', senderId: 'EXT', senderName: 'External', text: 'older' }],
      sourceMetadata: { historyComplete: true, historyEvidence: evidence },
    }];
    const current = [{
      id: 'CONV',
      participants: [{ id: 'EXT', name: 'External' }],
      messages: [
        { id: 'M1', conversationId: 'CONV', senderId: 'EXT', senderName: 'External', text: 'older' },
        { id: 'M2', conversationId: 'CONV', senderId: 'EXT', senderName: 'External', text: 'newer' },
      ],
      sourceMetadata: { read: true, historyComplete: false, historyEvidence: JSON.stringify([{ resource: 'failed', page: 'page-1', start: 0, count: 2, end: false, valid: false }]), parserMisses: 1 },
    }];

    const result = reuseProvenHistorySnapshots(current, previous);

    expect(result.reused).toBe(1);
    expect(result.conversations[0]?.messages?.map((message) => message.id)).toEqual(['M1', 'M2']);
    expect(result.conversations[0]?.sourceMetadata).toMatchObject({ read: true, historyComplete: true, historyEvidence: evidence });
  });

  it('refuses to reuse a proven snapshot when the fresh window has no stable overlap', () => {
    const evidence = JSON.stringify([{ resource: 'prior', page: 'page-0', start: 0, count: 2, end: true, valid: true }]);
    const previous = [{
      id: 'CONV', participants: [],
      messages: [1, 2].map((value) => ({ id: `M${value}`, conversationId: 'CONV', senderId: 'EXT', text: `old-${value}` })),
      sourceMetadata: { historyComplete: true, historyEvidence: evidence },
    }];
    const current = [{
      id: 'CONV', participants: [],
      messages: [31, 32].map((value) => ({ id: `M${value}`, conversationId: 'CONV', senderId: 'EXT', text: `new-${value}` })),
      sourceMetadata: { historyComplete: false, parserMisses: 1 },
    }];

    const result = reuseProvenHistorySnapshots(current, previous);

    expect(result.reused).toBe(0);
    expect(result.conversations).toEqual(current);
    expect(result.conversations[0]?.sourceMetadata?.historyComplete).toBe(false);
  });
});
