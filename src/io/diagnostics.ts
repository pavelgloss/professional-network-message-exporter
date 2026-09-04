import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { redact } from '../logger.js';
import type { Page } from 'playwright';

export type JsonStructuralSignature = {
  keyPaths: string[];
  arrays: Array<{ path: string; count: number }>;
  truncated: boolean;
};

export type NetworkResponseDiagnostic = {
  pathShape: string;
  status: number;
  contentTypeFamily: string;
  size: number;
  queryParameterNames: string[];
  relevant: boolean;
  outcome: string;
  jsonStructure?: JsonStructuralSignature;
  parserOutput?: {
    conversations: number;
    messages: number;
    participants: number;
    paginationUrls: number;
    misses: number;
    accounts: number;
  };
};

export type DiagnosticsManifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  counts: Record<string, number>;
  strategies: string[];
  warnings: string[];
  blockedRequests: Array<{ method: string; origin: string; pathname: string; reason: string }>;
  networkResponses: NetworkResponseDiagnostic[];
};

export function createManifest(): DiagnosticsManifest {
  const startedAt = new Date().toISOString();
  return { runId: startedAt.replace(/[.:]/g, '-'), startedAt, status: 'running', counts: {}, strategies: [], warnings: [], blockedRequests: [], networkResponses: [] };
}

const sensitiveName = /(?:auth|cookie|csrf|password|secret|session|token)/i;
const schemaName = /^[*$]?[a-z][A-Za-z_]{0,63}$/;
const opaqueDigitRun = /\d{3,}/;

export function safeStructuralName(value: string): string {
  if (sensitiveName.test(value) || opaqueDigitRun.test(value)) return '<redacted-key>';
  return schemaName.test(value) ? value : '<opaque-key>';
}

export function queryParameterNames(url: URL): string[] {
  return [...new Set([...url.searchParams.keys()].map(safeStructuralName))].sort();
}

export function redactedPathShape(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const output: string[] = [];
  let redactNext = false;
  const idParent = /^(?:in|thread|threads|profile|profiles|member|members|company|companies|conversation|conversations|message|messages)$/i;
  for (const segment of segments) {
    const decoded = safeDecode(segment);
    const structural = schemaName.test(decoded) && !sensitiveName.test(decoded);
    const redact = redactNext || !structural;
    output.push(redact ? ':opaque' : decoded);
    redactNext = idParent.test(decoded);
  }
  return `/${output.join('/')}` || '/';
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return ''; }
}

export function contentTypeFamily(contentType: string): string {
  const value = contentType.toLowerCase();
  if (/json|graphql/.test(value)) return 'json';
  if (/html/.test(value)) return 'html';
  if (/javascript|ecmascript/.test(value)) return 'javascript';
  if (/css/.test(value)) return 'css';
  if (/image/.test(value)) return 'image';
  if (/font|woff/.test(value)) return 'font';
  if (/^text\//.test(value)) return 'text';
  return value ? 'other' : 'none';
}

export function jsonStructuralSignature(value: unknown, maxDepth = 6, maxPaths = 240, maxArrays = 120): JsonStructuralSignature {
  const keyPaths = new Set<string>();
  const arrays: Array<{ path: string; count: number }> = [];
  let truncated = false;
  let nodes = 0;
  const visit = (current: unknown, pathName: string, depth: number): void => {
    nodes += 1;
    if (nodes > 2_000 || keyPaths.size >= maxPaths || arrays.length >= maxArrays || depth > maxDepth) { truncated = true; return; }
    if (Array.isArray(current)) {
      arrays.push({ path: pathName, count: current.length });
      keyPaths.add(`${pathName}[]`);
      for (const item of current) visit(item, `${pathName}[]`, depth + 1);
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        const childPath = `${pathName}.${safeStructuralName(key)}`;
        keyPaths.add(childPath);
        visit(child, childPath, depth + 1);
      }
      return;
    }
    keyPaths.add(`${pathName}:${current === null ? 'null' : typeof current}`);
  };
  visit(value, '$', 0);
  return { keyPaths: [...keyPaths].sort(), arrays: arrays.sort((a, b) => a.path.localeCompare(b.path) || a.count - b.count), truncated };
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
      for (const attribute of [...node.attributes]) {
        if (/^(value|nonce|integrity|on.*)$/i.test(attribute.name) || /(csrf|token|session|cookie)/i.test(attribute.name)) node.removeAttribute(attribute.name);
        else if (/^(href|src|action)$/i.test(attribute.name)) {
          try { const url = new URL(attribute.value, document.baseURI); url.search = ''; url.hash = ''; node.setAttribute(attribute.name, url.toString()); } catch { node.removeAttribute(attribute.name); }
        }
      }
    });
    return clone.outerHTML.slice(0, 2_000_000);
  });
  await writeFile(path.join(directory, 'page.sanitized.html'), sanitized, 'utf8');
}

export async function saveContentDiagnosticsOnFailure(page: Page, baseDir: string, runId: string, options: { enabled: boolean; authenticated: boolean; errorCode?: string }): Promise<boolean> {
  if (!options.enabled || !options.authenticated || options.errorCode !== 'PARSER_NO_DATA') return false;
  await saveContentDiagnostics(page, baseDir, runId);
  return true;
}
