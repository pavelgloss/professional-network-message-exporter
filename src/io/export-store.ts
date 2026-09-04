import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { AppError } from '../errors.js';
import { ExportSchema, type LinkedInExport } from '../domain/schema.js';

export async function loadExport(filePath: string): Promise<LinkedInExport | undefined> {
  try {
    return ExportSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AppError('VALIDATION_FAILED', `Existing export is invalid and was not overwritten: ${filePath}`);
  }
}

export function serializeExport(data: LinkedInExport): string {
  return `${JSON.stringify(ExportSchema.parse(data), null, 2)}\n`;
}

export async function saveExport(filePath: string, data: LinkedInExport): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, serializeExport(data), { encoding: 'utf8', fsync: true });
}

