import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExport, persistExportResult, saveExport } from '../../src/io/export-store.js';

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
});
