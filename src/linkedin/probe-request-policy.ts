import { conversationIdFromUrn, isConversationEntityType, parseLinkedInUrn } from '../domain/stable-id.js';
import { canonicalUrlView, repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { isMutationLikeRequestText } from '../browser/request-guard.js';

export type ProbeRequestPhase = 'selection' | 'target';
export type ProbeMessagingDecision = {
  messaging: boolean;
  allow: boolean;
  kind: 'non-messaging' | 'conversation-list' | 'conversation-history' | 'blocked';
  referencedIds: Set<string>;
};

type ReferenceResult = { sawKey: boolean; valid: boolean; unsafeConversationShape: boolean; ids: Set<string> };
const fixedQueryNames = new Set(['queryId', 'variables', 'includeWebMetadata']);
const canonicalReferenceNames = new Map([
  ['conversationurn', 'conversationUrn'],
  ['conversationid', 'conversationId'],
  ['id', 'id'],
  ['ids', 'ids'],
  ['urn', 'urn'],
  ['urns', 'urns'],
  ['threadurn', 'threadUrn'],
  ['threadid', 'threadId'],
  ['messagingthreadurn', 'messagingThreadUrn'],
  ['messagingthreadid', 'messagingThreadId'],
]);
const semanticStem = /messag|conversation|thread|inbox|mailbox/i;
const persistedHashSuffix = String.raw`(?:\.[A-Fa-f0-9]{32,128})?`;
const listOperation = new RegExp(`^messengerConversations${persistedHashSuffix}$`);
const historyOperation = new RegExp(`^(?:messengerMessages|messengerMessagesByConversation|messengerConversationMessages)${persistedHashSuffix}$`);
const targetReadDependencyOperation = /^(?:messengerSeenReceipts|messengerQuickReplies)\.[A-Fa-f0-9]{32,128}$/;

function isIdentityLikeKey(key: string): boolean {
  return /(?:id|ids|urn|urns)$/i.test(key);
}

function hasCanonicalIdentityKeySpelling(key: string): boolean {
  const known = canonicalReferenceNames.get(key.toLocaleLowerCase('en-US'));
  if (known) return known === key;
  return /^[A-Za-z][A-Za-z0-9]*(?:Id|Ids|Urn|Urns)$/.test(key);
}

function normalizedId(value: string): string | undefined {
  const normalized = repeatedlyDecodeAndNormalize(value.trim().replace(/^['"]|['"]$/g, ''));
  return normalized && (/^[\p{L}\p{N}_.-]+$/u.test(normalized) || /^[A-Za-z0-9._~=-]+$/.test(normalized)) ? normalized : undefined;
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

function isSafeMailboxReference(key: string, value: unknown): boolean {
  if (!/^(?:mailbox|inbox)Urn$/.test(key) || typeof value !== 'string') return false;
  const normalized = repeatedlyDecodeAndNormalize(value.trim().replace(/^['"]|['"]$/g, ''));
  const parsed = parseLinkedInUrn(normalized);
  if (!parsed) return false;
  const entityClass = classifyProbeUrnEntity(parsed.entityType);
  return entityClass === 'known-nonconversation';
}

type ProbeUrnEntityClass = 'supported-conversation' | 'suspicious-conversation-family' | 'known-nonconversation' | 'unknown-ambiguous';

function classifyProbeUrnEntity(entityType: string): ProbeUrnEntityClass {
  if (isConversationEntityType(entityType)) return 'supported-conversation';
  // A thread/conversation marker dominates mixed or future-looking names. This
  // keeps e.g. conversationParticipantV2 fail-closed without misclassifying the
  // ordinary messagingParticipant/message families below.
  if (/conversation|thread/i.test(entityType)) return 'suspicious-conversation-family';
  if (/profile|person|participant|message|event|mailbox|inbox|member/i.test(entityType)) return 'known-nonconversation';
  if (/messag/i.test(entityType)) return 'suspicious-conversation-family';
  return 'unknown-ambiguous';
}

function collectConversationUrns(value: string, result: ReferenceResult): void {
  const normalized = repeatedlyDecodeAndNormalize(value);
  if (normalized === undefined) { result.valid = false; return; }
  // Start at the LinkedIn namespace and classify the entity before requiring
  // the canonical value separator. A private endpoint could normalize
  // `urn:li:messagingThread/OTHER` (or `=OTHER`) even though our ordinary URN
  // parser correctly rejects it. Such a conversation-shaped token must make
  // the probe fail closed rather than disappear from its target evidence.
  const starts = [...normalized.matchAll(/urn:li:([\w-]+)/giu)];
  for (const match of starts) {
    const entityType = match[1];
    if (match.index === undefined || !entityType) continue;
    const entityClass = classifyProbeUrnEntity(entityType);
    if (entityClass !== 'supported-conversation' && entityClass !== 'suspicious-conversation-family') continue;
    result.sawKey = true;
    let end = match.index + match[0].length;
    if (normalized[end] !== ':') {
      result.valid = false;
      result.unsafeConversationShape = true;
      continue;
    }
    end += 1;
    if (normalized[end] === '(') {
      let depth = 0;
      let closed = false;
      for (; end < normalized.length; end += 1) {
        if (normalized[end] === '(') depth += 1;
        else if (normalized[end] === ')') {
          depth -= 1;
          if (depth === 0) { end += 1; closed = true; break; }
        }
      }
      if (!closed || (end < normalized.length && !/[\s"'`,;)\]}]/u.test(normalized[end]!))) {
        result.valid = false;
        result.unsafeConversationShape = true;
        continue;
      }
    } else {
      while (end < normalized.length && !/[\s"'`,;)\]}]/u.test(normalized[end]!)) end += 1;
    }
    const urn = normalized.slice(match.index, end);
    if (entityClass === 'supported-conversation') {
      const id = conversationIdFromUrn(urn);
      if (id) result.ids.add(id);
      else { result.valid = false; result.unsafeConversationShape = true; }
    } else {
      result.valid = false;
      result.unsafeConversationShape = true;
    }
  }
}

function mergeReference(result: ReferenceResult, key: string, value: unknown): void {
  result.sawKey = true;
  if (!hasCanonicalIdentityKeySpelling(key)) {
    result.valid = false;
    result.unsafeConversationShape = true;
  }
  const id = parseReferenceValue(value);
  if (id) result.ids.add(id);
  else {
    result.valid = false;
    result.unsafeConversationShape = true;
  }
}

function walkJsonReferences(value: unknown, result: ReferenceResult, depth = 0, budget = { remaining: 2_000 }): void {
  budget.remaining -= 1;
  if (depth > 12 || budget.remaining < 0) { result.valid = false; return; }
  if (typeof value === 'string') { collectConversationUrns(value, result); return; }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry) => walkJsonReferences(entry, result, depth + 1, budget));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSafeMailboxReference(key, child)) collectConversationUrns(child as string, result);
    else if (isIdentityLikeKey(key)) mergeReference(result, key, child);
    else {
      if (semanticStem.test(key)) result.valid = false;
      walkJsonReferences(child, result, depth + 1, budget);
    }
  }
}

export function restLiFields(value: string): Array<{ key: string; value: string }> {
  const output: Array<{ key: string; value: string }> = [];
  const keyPattern = /(?:^|[({,])\s*"?([A-Za-z][A-Za-z0-9_-]*)"?\s*[:=]\s*/gu;
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

function hasBalancedRestLiStructure(value: string): boolean {
  const stack: string[] = [];
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (stack.pop() !== expected) return false;
    }
  }
  return !quote && stack.length === 0;
}

export function parseProbeConversationReferences(query: Array<{ name: string; value: string }>): ReferenceResult {
  const result: ReferenceResult = { sawKey: false, valid: true, unsafeConversationShape: false, ids: new Set() };
  for (const { name, value } of query) {
    // Values are evidence-bearing regardless of their field name. Typed
    // conversation URNs hidden in JSON, arrays or Rest.li tokens cannot bypass
    // the exact target-alias comparison below.
    collectConversationUrns(value, result);
    // queryId identifies the persisted operation, not a conversation. It is the
    // only explicitly allowlisted non-conversation identity-like query key.
    if (name !== 'queryId' && isSafeMailboxReference(name, value)) collectConversationUrns(value, result);
    else if (name !== 'queryId' && isIdentityLikeKey(name)) mergeReference(result, name, value);
    else if (name !== 'queryId' && semanticStem.test(name)) result.valid = false;
    if (name !== 'variables') continue;
    if (value.length > 64 * 1024) { result.valid = false; continue; }
    try {
      walkJsonReferences(JSON.parse(value), result);
      continue;
    } catch { /* Rest.li variables are inspected field by field below. */ }
    const fields = restLiFields(value);
    if (!hasBalancedRestLiStructure(value) || !/^\s*\([\s\S]*\)\s*$/.test(value) || !fields.length) result.valid = false;
    for (const field of fields) {
      collectConversationUrns(field.value, result);
      if (isSafeMailboxReference(field.key, field.value)) continue;
      if (isIdentityLikeKey(field.key)) mergeReference(result, field.key, field.value);
      else if (semanticStem.test(field.key)) result.valid = false;
    }
  }
  return result;
}

function isSensitiveProbeSurface(rawUrl: string, canonical: ReturnType<typeof canonicalUrlView>, references: ReferenceResult): boolean {
  if (!canonical) {
    try { return /^\/voyager\/api(?:\/|$)/i.test(new URL(rawUrl).pathname) || semanticStem.test(rawUrl); }
    catch { return semanticStem.test(rawUrl); }
  }
  if (semanticStem.test(canonical.pathname) || references.sawKey || !references.valid) return true;
  return canonical.query.some(({ name, value }) => semanticStem.test(name) || semanticStem.test(value));
}

export function probeMessagingRequestPolicy(phase: ProbeRequestPhase, method: string, rawUrl: string, expectedOrigin: string, targetIds: ReadonlySet<string>): ProbeMessagingDecision {
  const blocked = (messaging = true, referencedIds = new Set<string>()): ProbeMessagingDecision => ({ messaging, allow: false, kind: messaging ? 'blocked' : 'non-messaging', referencedIds });
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return blocked(false); }
  const canonical = canonicalUrlView(rawUrl);
  const references = parseProbeConversationReferences(canonical?.query ?? []);
  const messagingSurface = isSensitiveProbeSurface(rawUrl, canonical, references);
  if (!messagingSurface) return blocked(false);
  if (!canonical || parsed.origin !== expectedOrigin || canonical.url.username || canonical.url.password || canonical.url.hash
    || method.toUpperCase() !== 'GET') return blocked();
  // Every UI messaging route and every REST/legacy/lookalike API path is denied.
  // The two cached documents are handled separately by the navigation gate.
  if (canonical.pathname !== '/voyager/api/voyagerMessagingGraphQL/graphql') return blocked();
  if (canonical.query.some(({ name }) => !fixedQueryNames.has(name) && !isIdentityLikeKey(name))) return blocked(true, references.ids);
  const operations = canonical.query.filter(({ name }) => name === 'queryId').map(({ value }) => value);
  if (operations.length !== 1) return blocked();
  const operation = operations[0]!;
  if (isMutationLikeRequestText(operation) || /send/i.test(operation)) return blocked();
  if (listOperation.test(operation)) {
    // Once one already-read target has been selected, the persisted list
    // operation remains a read-only collection query regardless of its UI
    // anchor/category variables. It cannot become a message-history or mutation
    // operation because queryId fixes the server-side document.
    if (phase === 'target') return { messaging: true, allow: true, kind: 'conversation-list', referencedIds: references.ids };
    const ordinaryList = !references.sawKey && references.valid;
    return ordinaryList
      ? { messaging: true, allow: true, kind: 'conversation-list', referencedIds: references.ids }
      : blocked(true, references.ids);
  }
  if (phase === 'target' && targetReadDependencyOperation.test(operation) && references.valid
    && !references.unsafeConversationShape && references.sawKey && references.ids.size === 1
    && [...references.ids].every((id) => targetIds.has(id))) {
    // GET-only dependencies needed to render the already-read target scroller;
    // never expose them as history templates to the caller.
    return { messaging: true, allow: true, kind: 'non-messaging', referencedIds: references.ids };
  }
  const exactCurrentHistory = /^messengerMessages\.[A-Fa-f0-9]{32,128}$/.test(operation);
  if (phase === 'target' && historyOperation.test(operation) && references.sawKey
    && (exactCurrentHistory || !references.unsafeConversationShape)
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
