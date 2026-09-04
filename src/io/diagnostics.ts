import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { redact } from '../logger.js';
import type { Page } from 'playwright';

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

export async function saveContentDiagnostics(page: Page, baseDir: string, runId: string): Promise<void> {
  const directory = path.join(baseDir, runId);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, 'page.png'), fullPage: false });
  const sanitized = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, noscript, input, textarea, meta[http-equiv], meta[name*="token" i]').forEach((node) => node.remove());
    clone.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) if (/^(value|nonce|integrity)$/i.test(attribute.name) || /(csrf|token|session|cookie)/i.test(attribute.name)) node.removeAttribute(attribute.name);
    });
    return clone.outerHTML.slice(0, 2_000_000);
  });
  await writeFile(path.join(directory, 'page.sanitized.html'), sanitized, 'utf8');
}
