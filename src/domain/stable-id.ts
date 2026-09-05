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

export type LinkedInUrn = { entityType: string; value: string; urn: string };

export function parseLinkedInUrn(value?: string): LinkedInUrn | undefined {
  const urn = normalizeUrn(value);
  if (!urn) return undefined;
  const match = urn.match(/^urn:li:([\w-]+):(.+)$/i);
  if (!match?.[1] || !match[2]) return undefined;
  return { entityType: match[1], value: match[2], urn };
}

/** Returns the complete value component. Do not use it as a route ID. */
export function extractUrnId(value?: string): string | undefined {
  return parseLinkedInUrn(value)?.value;
}

const PERSON_TYPES = /^(?:fsd_profile|fs_miniProfile|miniProfile|fsd_messagingParticipant|messagingParticipant|member|person)$/i;
const CONVERSATION_TYPES = /^(?:msg_conversation|fsd_messengerConversation|messagingThread|messagingConversation|conversation)$/i;
const MESSAGE_TYPES = /^(?:msg_message|fsd_messageEvent|messagingMessage|messageEvent|event)$/i;

function typedRouteId(value: string | undefined, expected: RegExp): string | undefined {
  const parsed = parseLinkedInUrn(value);
  if (!parsed || !expected.test(parsed.entityType)) return undefined;
  if (!parsed.value.startsWith('(')) return safeRouteId(parsed.value);
  const components = splitComposite(parsed.value);
  return safeRouteId(components.at(-1));
}

function safeRouteId(value?: string): string | undefined {
  const clean = value?.trim();
  return clean && /^[\w.-]+$/u.test(clean) ? clean : undefined;
}

export function personIdFromUrn(value?: string): string | undefined { return typedRouteId(value, PERSON_TYPES); }
export function conversationIdFromUrn(value?: string): string | undefined { return typedRouteId(value, CONVERSATION_TYPES); }
export function messageIdFromUrn(value?: string): string | undefined { return typedRouteId(value, MESSAGE_TYPES); }

export function splitComposite(value: string): string[] {
  const body = value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1) : value;
  const output: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '(') depth += 1;
    else if (body[index] === ')') depth -= 1;
    else if (body[index] === ',' && depth === 0) { output.push(body.slice(start, index).trim()); start = index + 1; }
  }
  output.push(body.slice(start).trim());
  return output.filter(Boolean);
}

export function normalizeUrn(value?: string): string | undefined {
  if (!value) return undefined;
  let candidate: string;
  try { candidate = decodeURIComponent(value.trim()); } catch { return undefined; }
  return /^urn:li:[\w-]+:[^\s]+$/i.test(candidate) ? candidate : undefined;
}
