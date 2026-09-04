import { createHash } from 'node:crypto';

export function sha256Id(prefix: string, parts: unknown[]): string {
  const canonical = JSON.stringify(parts.map(canonicalPart));
  return `${prefix}_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function canonicalPart(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFKC').trim().replace(/\r\n/g, '\n');
  if (Array.isArray(value)) return value.map(canonicalPart);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalPart(v)]));
  }
  return value ?? null;
}

export function extractUrnId(value?: string): string | undefined {
  if (!value) return undefined;
  const decoded = decodeURIComponent(value);
  const match = decoded.match(/urn:li:[^:]+:([^?/,)]+)/i);
  return match?.[1] ?? undefined;
}

export function normalizeUrn(value?: string): string | undefined {
  if (!value) return undefined;
  const candidate = decodeURIComponent(value.trim());
  return /^urn:li:[\w-]+:[^\s]+$/i.test(candidate) ? candidate : undefined;
}

