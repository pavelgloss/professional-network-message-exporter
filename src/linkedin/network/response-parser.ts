import { cleanText } from '../../domain/normalize.js';
import { conversationIdFromUrn, messageIdFromUrn, normalizeUrn, personIdFromUrn } from '../../domain/stable-id.js';
import type { RawConversation, RawMessage, RawParticipant } from '../../domain/schema.js';

type JsonRecord = Record<string, unknown>;
export type ParsedNetworkData = {
  conversations: RawConversation[];
  account?: { id?: string; entityUrn?: string; name?: string; profileUrl?: string };
  paginationUrls: string[];
  strategies: string[];
  misses: number;
};

const record = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringAt = (obj: JsonRecord, ...keys: string[]): string | undefined => {
  for (const key of keys) { const value = obj[key]; if (typeof value === 'string' && value.trim()) return value; }
  return undefined;
};
const numberOrStringAt = (obj: JsonRecord, ...keys: string[]): string | number | undefined => {
  for (const key of keys) { const value = obj[key]; if (typeof value === 'string' || typeof value === 'number') return value; }
  return undefined;
};

function urnAt(obj: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.includes('urn:li:')) return normalizeUrn(value) ?? value;
    if (record(value)) {
      const nested = stringAt(value, 'entityUrn', 'urn', '*entityUrn');
      if (nested) return normalizeUrn(nested) ?? nested;
    }
  }
  return undefined;
}

function profileFrom(value: JsonRecord, index: Map<string, JsonRecord>): JsonRecord {
  for (const key of ['miniProfile', 'profile', 'participant', 'actor', '*miniProfile', '*profile']) {
    if (record(value[key])) return value[key] as JsonRecord;
    if (typeof value[key] === 'string' && index.has(value[key] as string)) return index.get(value[key] as string)!;
  }
  return value;
}

function participantFrom(value: unknown, index: Map<string, JsonRecord>): RawParticipant | undefined {
  let obj: JsonRecord | undefined;
  if (typeof value === 'string') obj = index.get(value);
  else if (record(value)) obj = value;
  if (!obj) return undefined;
  const profile = profileFrom(obj, index);
  const entityUrn = urnAt(profile, 'entityUrn', 'objectUrn', 'memberUrn') ?? urnAt(obj, 'entityUrn', 'participantUrn', '*profile');
  const first = cleanText(stringAt(profile, 'firstName'));
  const last = cleanText(stringAt(profile, 'lastName'));
  const name = cleanText(stringAt(profile, 'name', 'fullName', 'title')) ?? cleanText([first, last].filter(Boolean).join(' '));
  const profileUrl = stringAt(profile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(profile, 'publicIdentifier')}` : stringAt(profile, 'profileUrl', 'navigationUrl');
  const headline = cleanText(stringAt(profile, 'headline', 'occupation'));
  const id = personIdFromUrn(entityUrn) ?? cleanText(stringAt(profile, 'id', 'plainId'));
  if (!id && !entityUrn && !name && !profileUrl) return undefined;
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(name ? { name } : {}), ...(profileUrl ? { profileUrl } : {}), ...(headline ? { headline } : {}) };
}

function textFrom(obj: JsonRecord): string | undefined {
  const direct = stringAt(obj, 'text', 'body', 'messageBody', 'subject');
  if (direct) return cleanText(direct);
  for (const key of ['eventContent', 'attributedBody', 'commentary', 'content']) {
    if (record(obj[key])) { const found = textFrom(obj[key] as JsonRecord); if (found) return found; }
  }
  return undefined;
}

function messageFrom(obj: JsonRecord, index: Map<string, JsonRecord>, conversationUrn?: string): RawMessage | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'eventUrn', 'messageUrn', 'backendUrn');
  const senderUrn = urnAt(obj, 'from', '*from', 'sender', '*sender', 'actor', '*actor', 'senderUrn', 'participantUrn');
  const text = textFrom(obj);
  const sentAt = numberOrStringAt(obj, 'createdAt', 'sentAt', 'deliveredAt', 'timestamp', 'created');
  const looksMessage = /(?:message|event)/i.test(entityUrn ?? '') || Boolean(text && senderUrn && sentAt !== undefined);
  if (!looksMessage || (!text && !record(obj.eventContent))) return undefined;
  const senderValue = ['from', '*from', 'sender', '*sender', 'actor', '*actor'].map((key) => obj[key]).find((value) => record(value) || typeof value === 'string');
  const senderObj = record(senderValue) ? senderValue : typeof senderValue === 'string' ? index.get(senderValue) : undefined;
  const senderProfile = senderObj ? profileFrom(senderObj, index) : undefined;
  const senderName = senderProfile ? cleanText(stringAt(senderProfile, 'name', 'fullName')) ?? cleanText([stringAt(senderProfile, 'firstName'), stringAt(senderProfile, 'lastName')].filter(Boolean).join(' ')) : undefined;
  const senderProfileUrl = senderProfile && stringAt(senderProfile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(senderProfile, 'publicIdentifier')}` : undefined;
  const id = messageIdFromUrn(entityUrn) ?? cleanText(stringAt(obj, 'id'));
  const conversationId = conversationIdFromUrn(urnAt(obj, 'conversationUrn', '*conversation') ?? conversationUrn);
  const senderId = personIdFromUrn(senderUrn);
  const messageType = cleanText(stringAt(obj, 'subtype', 'eventType', 'type'));
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(conversationId ? { conversationId } : {}), ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}), ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt !== undefined ? { sentAt } : {}), ...(text ? { text } : {}), ...(messageType ? { messageType } : {}) };
}

function childrenFrom(obj: JsonRecord, ...keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
    if (record(obj[key])) {
      const wrapper = obj[key] as JsonRecord;
      for (const nested of ['elements', 'nodes', 'edges']) if (Array.isArray(wrapper[nested])) return (wrapper[nested] as unknown[]).map((value) => record(value) && 'node' in value ? value.node : value);
    }
  }
  return [];
}

function conversationFrom(obj: JsonRecord, index: Map<string, JsonRecord>): RawConversation | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'conversationUrn', 'backendUrn');
  const participantValues = childrenFrom(obj, 'participants', '*participants', 'conversationParticipants', 'members');
  const messageValues = childrenFrom(obj, 'events', '*events', 'messages', '*messages', 'conversationEvents');
  const looksConversation = /(?:messagingThread|conversation)/i.test(entityUrn ?? '') || (participantValues.length > 0 && ('events' in obj || 'messages' in obj));
  if (!looksConversation) return undefined;
  const id = conversationIdFromUrn(entityUrn) ?? cleanText(stringAt(obj, 'id'));
  const participants = participantValues.map((p) => participantFrom(p, index)).filter((p): p is RawParticipant => Boolean(p));
  const messages = messageValues.map((m) => typeof m === 'string' ? index.get(m) : m).filter(record).map((m) => messageFrom(m, index, entityUrn)).filter((m): m is RawMessage => Boolean(m));
  const lastActivityAt = numberOrStringAt(obj, 'lastActivityAt', 'lastActivity', 'updatedAt', 'createdAt');
  const url = id ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(id)}/` : undefined;
  const paging = record(obj.paging) ? obj.paging : record(obj.pageInfo) ? obj.pageInfo : undefined;
  const total = paging && typeof paging.total === 'number' ? paging.total : undefined;
  const historyComplete = messageValues.length > 0 && (paging?.hasNextPage === false || (total !== undefined && messages.length >= total));
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(url ? { url } : {}), ...(lastActivityAt !== undefined ? { lastActivityAt } : {}), participants, messages, ...(historyComplete ? { sourceMetadata: { historyComplete: true } } : {}) };
}

function walk(value: unknown, visit: (obj: JsonRecord) => void, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit, seen)); return; }
  const obj = value as JsonRecord;
  visit(obj);
  Object.values(obj).forEach((item) => walk(item, visit, seen));
}

export function parseNetworkPayload(payload: unknown, sourceUrl = ''): ParsedNetworkData {
  const objects: JsonRecord[] = [];
  walk(payload, (obj) => objects.push(obj));
  const index = new Map<string, JsonRecord>();
  for (const obj of objects) {
    for (const key of ['entityUrn', 'urn', 'objectUrn']) {
      const urn = stringAt(obj, key);
      if (urn?.includes('urn:li:')) index.set(urn, obj);
    }
  }
  const conversations = objects.map((obj) => conversationFrom(obj, index)).filter((c): c is RawConversation => Boolean(c));
  const nestedMessages = objects.map((obj) => messageFrom(obj, index)).filter((m): m is RawMessage => Boolean(m));
  for (const message of nestedMessages) {
    if (!message.conversationId) continue;
    let conversation = conversations.find((c) => c.id === message.conversationId);
    if (!conversation) { conversation = { id: message.conversationId, messages: [] }; conversations.push(conversation); }
    if (!(conversation.messages ?? []).some((m) => (m.entityUrn ?? m.id) === (message.entityUrn ?? message.id))) (conversation.messages ??= []).push(message);
  }
  const paginationUrls = new Set<string>();
  for (const obj of objects) {
    const href = stringAt(obj, 'href', 'nextUrl');
    const normalized = href ? normalizePaginationUrl(href, sourceUrl) : undefined;
    if (normalized) paginationUrls.add(normalized);
    const start = typeof obj.start === 'number' ? obj.start : undefined;
    const count = typeof obj.count === 'number' ? obj.count : undefined;
    const total = typeof obj.total === 'number' ? obj.total : undefined;
    if (start !== undefined && count && total !== undefined && start + count < total) {
      const next = deriveQueryUrl(sourceUrl, 'start', String(start + count));
      if (next) paginationUrls.add(next);
    }
    const cursor = stringAt(obj, 'nextCursor', 'paginationToken', 'endCursor');
    if (cursor && obj.hasNextPage !== false) {
      const next = deriveCursorUrl(sourceUrl, cursor);
      if (next) paginationUrls.add(next);
    }
  }
  let account: ParsedNetworkData['account'];
  if (/\/voyager\/api\/me(?:[/?#]|$)/i.test(sourceUrl)) {
    const profile = objects.find((obj) => stringAt(obj, 'plainId', 'publicIdentifier') && (stringAt(obj, 'firstName') || stringAt(obj, 'name')));
    if (profile) {
      const entityUrn = urnAt(profile, 'entityUrn', 'objectUrn');
      const name = cleanText(stringAt(profile, 'name')) ?? cleanText([stringAt(profile, 'firstName'), stringAt(profile, 'lastName')].filter(Boolean).join(' '));
      const publicIdentifier = stringAt(profile, 'publicIdentifier');
      const id = personIdFromUrn(entityUrn) ?? stringAt(profile, 'plainId');
      account = { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(name ? { name } : {}), ...(publicIdentifier ? { profileUrl: `https://www.linkedin.com/in/${publicIdentifier}` } : {}) };
    }
  }
  return { conversations, ...(account ? { account } : {}), paginationUrls: [...paginationUrls], strategies: conversations.length ? ['network:recursive-voyager'] : [], misses: conversations.length ? 0 : 1 };
}

function normalizePaginationUrl(href: string, sourceUrl: string): string | undefined {
  try {
    const base = sourceUrl ? new URL(sourceUrl, 'https://www.linkedin.com') : new URL('https://www.linkedin.com');
    const url = new URL(href, base);
    return url.origin === 'https://www.linkedin.com' && /^\/voyager\/api\/(?:messaging|graphql)/i.test(url.pathname) ? url.toString() : undefined;
  } catch { return undefined; }
}

function deriveQueryUrl(sourceUrl: string, key: string, value: string): string | undefined {
  try {
    const url = new URL(sourceUrl, 'https://www.linkedin.com');
    if (url.origin !== 'https://www.linkedin.com' || !/^\/voyager\/api\/(?:messaging|graphql)/i.test(url.pathname)) return undefined;
    url.searchParams.set(key, value);
    return url.toString();
  } catch { return undefined; }
}

function deriveCursorUrl(sourceUrl: string, cursor: string): string | undefined {
  try {
    const url = new URL(sourceUrl, 'https://www.linkedin.com');
    const directKey = [...url.searchParams.keys()].find((key) => /^(?:cursor|paginationToken)$/i.test(key));
    if (directKey) return deriveQueryUrl(sourceUrl, directKey, cursor);
    const variables = url.searchParams.get('variables');
    if (!variables) return undefined;
    const parsed = JSON.parse(variables) as Record<string, unknown>;
    const variableKey = Object.keys(parsed).find((key) => /^(?:cursor|paginationToken)$/i.test(key));
    if (!variableKey) return undefined;
    parsed[variableKey] = cursor;
    url.searchParams.set('variables', JSON.stringify(parsed));
    return url.toString();
  } catch { return undefined; }
}
