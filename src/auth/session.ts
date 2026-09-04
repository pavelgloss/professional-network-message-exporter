import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import writeFileAtomic from 'write-file-atomic';
import { AppError } from '../errors.js';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export async function loadStorageState(statePath: string): Promise<StorageState> {
  let raw: string;
  try { raw = await readFile(statePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('AUTH_REQUIRED', 'LinkedIn session state is missing. Run: npm.cmd run login', 3);
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StorageState>;
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error('invalid shape');
    return parsed as StorageState;
  } catch {
    throw new AppError('AUTH_REQUIRED', 'LinkedIn session state is invalid. Run: npm.cmd run login', 3);
  }
}

export async function saveStorageState(context: BrowserContext, statePath: string): Promise<void> {
  const state = await context.storageState();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', fsync: true, mode: 0o600 });
}

