import { cleanText } from '../../domain/normalize.js';
import { extractUrnId, normalizeUrn } from '../../domain/stable-id.js';
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

function profileFrom(value: JsonRecord): JsonRecord {
  for (const key of ['miniProfile', 'profile', 'participant', 'actor']) if (record(value[key])) return value[key] as JsonRecord;
  return value;
}

function participantFrom(value: unknown, index: Map<string, JsonRecord>): RawParticipant | undefined {
  let obj: JsonRecord | undefined;
  if (typeof value === 'string') obj = index.get(value);
  else if (record(value)) obj = value;
  if (!obj) return undefined;
  const profile = profileFrom(obj);
  const entityUrn = urnAt(profile, 'entityUrn', 'objectUrn', 'memberUrn') ?? urnAt(obj, 'entityUrn', 'participantUrn', '*profile');
  const first = cleanText(stringAt(profile, 'firstName'));
  const last = cleanText(stringAt(profile, 'lastName'));
  const name = cleanText(stringAt(profile, 'name', 'fullName', 'title')) ?? cleanText([first, last].filter(Boolean).join(' '));
  const profileUrl = stringAt(profile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(profile, 'publicIdentifier')}` : stringAt(profile, 'profileUrl', 'navigationUrl');
  const headline = cleanText(stringAt(profile, 'headline', 'occupation'));
  const id = extractUrnId(entityUrn) ?? cleanText(stringAt(profile, 'id', 'plainId'));
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

function messageFrom(obj: JsonRecord, conversationUrn?: string): RawMessage | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'eventUrn', 'messageUrn', 'backendUrn');
  const senderUrn = urnAt(obj, 'from', 'sender', 'actor', 'senderUrn', 'participantUrn');
  const text = textFrom(obj);
  const sentAt = numberOrStringAt(obj, 'createdAt', 'sentAt', 'deliveredAt', 'timestamp', 'created');
  const looksMessage = /(?:message|event)/i.test(entityUrn ?? '') || Boolean(text && senderUrn && sentAt !== undefined);
  if (!looksMessage || (!text && !record(obj.eventContent))) return undefined;
  const senderObj = ['from', 'sender', 'actor'].map((key) => obj[key]).find(record);
  const senderProfile = senderObj ? profileFrom(senderObj) : undefined;
  const senderName = senderProfile ? cleanText(stringAt(senderProfile, 'name', 'fullName')) ?? cleanText([stringAt(senderProfile, 'firstName'), stringAt(senderProfile, 'lastName')].filter(Boolean).join(' ')) : undefined;
  const senderProfileUrl = senderProfile && stringAt(senderProfile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(senderProfile, 'publicIdentifier')}` : undefined;
  const id = extractUrnId(entityUrn) ?? cleanText(stringAt(obj, 'id'));
  const conversationId = extractUrnId(urnAt(obj, 'conversationUrn', '*conversation') ?? conversationUrn);
  const senderId = extractUrnId(senderUrn);
  const messageType = cleanText(stringAt(obj, 'subtype', 'eventType', 'type'));
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(conversationId ? { conversationId } : {}), ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}), ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt !== undefined ? { sentAt } : {}), ...(text ? { text } : {}), ...(messageType ? { messageType } : {}) };
}

function childrenFrom(obj: JsonRecord, ...keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(obj[key])) return obj[key] as unknown[];
  return [];
}

function conversationFrom(obj: JsonRecord, index: Map<string, JsonRecord>): RawConversation | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'conversationUrn', 'backendUrn');
  const participantValues = childrenFrom(obj, 'participants', 'conversationParticipants', 'members');
  const messageValues = childrenFrom(obj, 'events', 'messages', 'conversationEvents');
  const looksConversation = /(?:messagingThread|conversation)/i.test(entityUrn ?? '') || (participantValues.length > 0 && ('events' in obj || 'messages' in obj));
  if (!looksConversation) return undefined;
  const id = extractUrnId(entityUrn) ?? cleanText(stringAt(obj, 'id'));
  const participants = participantValues.map((p) => participantFrom(p, index)).filter((p): p is RawParticipant => Boolean(p));
  const messages = messageValues.map((m) => typeof m === 'string' ? index.get(m) : m).filter(record).map((m) => messageFrom(m, entityUrn)).filter((m): m is RawMessage => Boolean(m));
  const lastActivityAt = numberOrStringAt(obj, 'lastActivityAt', 'lastActivity', 'updatedAt', 'createdAt');
  const url = id ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(id)}/` : undefined;
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(url ? { url } : {}), ...(lastActivityAt !== undefined ? { lastActivityAt } : {}), participants, messages };
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
  const nestedMessages = objects.map((obj) => messageFrom(obj)).filter((m): m is RawMessage => Boolean(m));
  for (const message of nestedMessages) {
    if (!message.conversationId) continue;
    let conversation = conversations.find((c) => c.id === message.conversationId);
    if (!conversation) { conversation = { id: message.conversationId, messages: [] }; conversations.push(conversation); }
    if (!(conversation.messages ?? []).some((m) => (m.entityUrn ?? m.id) === (message.entityUrn ?? message.id))) (conversation.messages ??= []).push(message);
  }
  const paginationUrls = new Set<string>();
  for (const obj of objects) {
    const href = stringAt(obj, 'href', 'nextUrl');
    if (href && /^https:\/\/www\.linkedin\.com\/voyager\/api\//i.test(href)) paginationUrls.add(href);
  }
  let account: ParsedNetworkData['account'];
  if (/\/voyager\/api\/(?:me|identity\/profiles)/i.test(sourceUrl)) {
    const profile = objects.find((obj) => stringAt(obj, 'plainId', 'publicIdentifier') && (stringAt(obj, 'firstName') || stringAt(obj, 'name')));
    if (profile) {
      const entityUrn = urnAt(profile, 'entityUrn', 'objectUrn');
      const name = cleanText(stringAt(profile, 'name')) ?? cleanText([stringAt(profile, 'firstName'), stringAt(profile, 'lastName')].filter(Boolean).join(' '));
      const publicIdentifier = stringAt(profile, 'publicIdentifier');
      const id = extractUrnId(entityUrn) ?? stringAt(profile, 'plainId');
      account = { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(name ? { name } : {}), ...(publicIdentifier ? { profileUrl: `https://www.linkedin.com/in/${publicIdentifier}` } : {}) };
    }
  }
  return { conversations, ...(account ? { account } : {}), paginationUrls: [...paginationUrls], strategies: conversations.length ? ['network:recursive-voyager'] : [], misses: conversations.length ? 0 : 1 };
}
