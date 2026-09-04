import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { redact } from '../logger.js';

export type DiagnosticsManifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  counts: Record<string, number>;
  strategies: string[];
  warnings: string[];
  blockedRequests: Array<{ method: string; origin: string; pathname: string; reason: string }>;
};

export function createManifest(): DiagnosticsManifest {
  const startedAt = new Date().toISOString();
  return { runId: startedAt.replace(/[.:]/g, '-'), startedAt, status: 'running', counts: {}, strategies: [], warnings: [], blockedRequests: [] };
}

export async function saveManifest(baseDir: string, manifest: DiagnosticsManifest): Promise<string> {
  const directory = path.join(baseDir, manifest.runId);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, 'manifest.json');
  await writeFileAtomic(destination, `${JSON.stringify(redact(manifest), null, 2)}\n`, { encoding: 'utf8', fsync: true });
  return destination;
}

