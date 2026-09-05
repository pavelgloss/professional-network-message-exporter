import { conversationIdFromUrn } from '../domain/stable-id.js';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';

export type ProbeRequestPhase = 'selection' | 'target';
export type ProbeMessagingDecision = {
  messaging: boolean;
  allow: boolean;
  kind: 'non-messaging' | 'conversation-list' | 'conversation-history' | 'blocked';
  referencedIds: Set<string>;
};

type ReferenceResult = { sawKey: boolean; valid: boolean; ids: Set<string> };
const queryNames = new Set([
  'queryId', 'variables', 'includeWebMetadata',
  'conversationUrn', 'conversationId', 'urn',
  'threadUrn', 'threadId', 'messagingThreadUrn', 'messagingThreadId',
]);
const canonicalReferenceNames = new Map([
  ['conversationurn', 'conversationUrn'],
  ['conversationid', 'conversationId'],
  ['urn', 'urn'],
  ['threadurn', 'threadUrn'],
  ['threadid', 'threadId'],
  ['messagingthreadurn', 'messagingThreadUrn'],
  ['messagingthreadid', 'messagingThreadId'],
]);
const listOperation = /^messengerConversations$/;
const historyOperation = /^(?:messengerMessagesByConversation|messengerConversationMessages)$/;

function normalizedId(value: string): string | undefined {
  const normalized = repeatedlyDecodeAndNormalize(value.trim().replace(/^['"]|['"]$/g, ''));
  return normalized && /^[\p{L}\p{N}_.-]+$/u.test(normalized) ? normalized : undefined;
}

function parseReferenceValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = repeatedlyDecodeAndNormalize(value.trim().replace(/^['"]|['"]$/g, ''));
  if (!normalized) return undefined;
  const urnId = conversationIdFromUrn(normalized);
  if (urnId) return urnId;
  if (/^urn:/i.test(normalized)) return undefined;
  return normalizedId(normalized);
}

function mergeReference(result: ReferenceResult, key: string, value: unknown): void {
  result.sawKey = true;
  if (canonicalReferenceNames.get(key.toLocaleLowerCase('en-US')) !== key) result.valid = false;
  const id = parseReferenceValue(value);
  if (id) result.ids.add(id);
  else result.valid = false;
}

function walkJsonReferences(value: unknown, result: ReferenceResult, depth = 0, budget = { remaining: 2_000 }): void {
  budget.remaining -= 1;
  if (depth > 12 || budget.remaining < 0) { result.valid = false; return; }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry) => walkJsonReferences(entry, result, depth + 1, budget));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (canonicalReferenceNames.has(key.toLocaleLowerCase('en-US'))) mergeReference(result, key, child);
    else {
      if (/conversation|thread|urn/i.test(key)) result.valid = false;
      walkJsonReferences(child, result, depth + 1, budget);
    }
  }
}

function restLiReferenceValues(value: string): Array<{ key: string; value: string }> {
  const output: Array<{ key: string; value: string }> = [];
  const keyPattern = /(?:^|[({,])\s*"?(conversationUrn|conversationId|urn|threadUrn|threadId|messagingThreadUrn|messagingThreadId)"?\s*[:=]\s*/giu;
  for (const match of value.matchAll(keyPattern)) {
    const key = match[1];
    if (!key || match.index === undefined) continue;
    const start = match.index + match[0].length;
    let end = start;
    let depth = 0;
    let quote = '';
    for (; end < value.length; end += 1) {
      const character = value[end]!;
      if (quote) {
        if (character === quote && value[end - 1] !== '\\') quote = '';
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) break;
    }
    output.push({ key, value: value.slice(start, end).trim() });
  }
  return output;
}

export function parseProbeConversationReferences(query: Array<{ name: string; value: string }>): ReferenceResult {
  const result: ReferenceResult = { sawKey: false, valid: true, ids: new Set() };
  for (const { name, value } of query) {
    const lowerName = name.toLocaleLowerCase('en-US');
    if (canonicalReferenceNames.has(lowerName)) mergeReference(result, name, value);
    if (name !== 'variables') continue;
    if (value.length > 64 * 1024) { result.valid = false; continue; }
    try { walkJsonReferences(JSON.parse(value), result); } catch { /* Rest.li or non-JSON variables */ }
    for (const match of value.matchAll(/(?:^|[({,])\s*"?([A-Za-z][A-Za-z0-9_-]*(?:conversation|thread|urn)[A-Za-z0-9_-]*)"?\s*[:=]/giu)) {
      const key = match[1];
      if (key && canonicalReferenceNames.get(key.toLocaleLowerCase('en-US')) !== key) result.valid = false;
    }
    for (const reference of restLiReferenceValues(value)) mergeReference(result, reference.key, reference.value);
  }
  return result;
}

export function probeMessagingRequestPolicy(phase: ProbeRequestPhase, method: string, rawUrl: string, expectedOrigin: string, targetIds: ReadonlySet<string>): ProbeMessagingDecision {
  const blocked = (messaging = true, referencedIds = new Set<string>()): ProbeMessagingDecision => ({ messaging, allow: false, kind: messaging ? 'blocked' : 'non-messaging', referencedIds });
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return blocked(false); }
  const canonical = canonicalUrlView(rawUrl);
  const pathname = canonical?.pathname ?? parsed.pathname;
  const messagingSurface = /^\/messaging(?:\/|$)/i.test(pathname)
    || /^\/voyager\/api\/(?:messaging|graphql|voyagerMessagingGraphQL)(?:\/|$)/i.test(pathname);
  if (!messagingSurface) return blocked(false);
  if (!canonical || parsed.origin !== expectedOrigin || canonical.url.username || canonical.url.password || canonical.url.hash
    || method.toUpperCase() !== 'GET') return blocked();
  // Every UI messaging route and every REST/legacy/lookalike API path is denied.
  // The two cached documents are handled separately by the navigation gate.
  if (canonical.pathname !== '/voyager/api/voyagerMessagingGraphQL/graphql') return blocked();
  if (canonical.query.some(({ name }) => !queryNames.has(name))) return blocked();
  const operations = canonical.query.filter(({ name }) => name === 'queryId').map(({ value }) => value);
  if (operations.length !== 1) return blocked();
  const operation = operations[0]!;
  if (/mutation|send|delete|archive|markRead|markUnread|reaction|typing/i.test(operation)) return blocked();
  const references = parseProbeConversationReferences(canonical.query);
  if (listOperation.test(operation)) {
    return references.sawKey || !references.valid
      ? blocked(true, references.ids)
      : { messaging: true, allow: true, kind: 'conversation-list', referencedIds: references.ids };
  }
  if (phase === 'target' && historyOperation.test(operation) && references.sawKey && references.valid
    && references.ids.size === 1 && [...references.ids].every((id) => targetIds.has(id))) {
    return { messaging: true, allow: true, kind: 'conversation-history', referencedIds: references.ids };
  }
  return blocked(true, references.ids);
}

export function isProbeThreadUrl(rawUrl: string, expectedOrigin: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== expectedOrigin) return false;
    const canonical = canonicalUrlView(rawUrl);
    return /^\/messaging\/thread(?:\/|$)/i.test(canonical?.pathname ?? parsed.pathname);
  } catch { return false; }
}
