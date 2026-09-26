import { cleanText } from '../../domain/normalize.js';
import { conversationIdFromUrn, messageIdFromUrn, normalizeUrn, personIdFromUrn, sha256Id } from '../../domain/stable-id.js';
import type { Attachment, RawConversation, RawMessage, RawParticipant } from '../../domain/schema.js';
import { assertAllowedReadUrl } from './read-client.js';

type JsonRecord = Record<string, unknown>;
type IncludedIndex = { records: Map<string, JsonRecord>; ambiguous: Set<string> };
export type NetworkParseOptions = { observedMethod?: string };
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

function identityUrnAt(obj: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.includes('urn:li:')) return normalizeUrn(value) ?? value;
    if (record(value)) {
      const nested = stringAt(value, 'hostIdentityUrn', 'memberUrn', 'entityUrn', 'urn', '*entityUrn');
      if (nested) return normalizeUrn(nested) ?? nested;
    }
  }
  return undefined;
}

function lookupIncluded(index: IncludedIndex, value: string): JsonRecord | undefined {
  const key = normalizeUrn(value) ?? value;
  return index.ambiguous.has(key) ? undefined : index.records.get(key);
}

function profileFrom(value: JsonRecord, index: IncludedIndex): JsonRecord {
  for (const key of ['miniProfile', 'profile', 'participant', 'actor', '*miniProfile', '*profile']) {
    if (record(value[key])) return value[key] as JsonRecord;
    if (typeof value[key] === 'string') {
      const resolved = lookupIncluded(index, value[key] as string);
      if (resolved) return resolved;
    }
  }
  return value;
}

function participantFrom(value: unknown, index: IncludedIndex): RawParticipant | undefined {
  let obj: JsonRecord | undefined;
  if (typeof value === 'string') obj = lookupIncluded(index, value);
  else if (record(value)) obj = value;
  if (!obj) return undefined;
  const profile = profileFrom(obj, index);
  const identityUrn = urnAt(profile, 'hostIdentityUrn', 'memberUrn') ?? urnAt(obj, 'hostIdentityUrn', 'memberUrn');
  const participantUrn = urnAt(profile, 'entityUrn', 'objectUrn') ?? urnAt(obj, 'entityUrn', 'participantUrn', '*profile');
  const entityUrn = identityUrn ?? participantUrn;
  const first = cleanText(stringAt(profile, 'firstName'));
  const last = cleanText(stringAt(profile, 'lastName'));
  const name = cleanText(stringAt(profile, 'name', 'fullName', 'title')) ?? cleanText([first, last].filter(Boolean).join(' '));
  const profileUrl = stringAt(profile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(profile, 'publicIdentifier')}` : stringAt(profile, 'profileUrl', 'navigationUrl');
  const headline = cleanText(stringAt(profile, 'headline', 'occupation'));
  const id = personIdFromUrn(entityUrn) ?? cleanText(stringAt(profile, 'id', 'plainId'));
  if (!id && !entityUrn && !name && !profileUrl) return undefined;
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(name ? { name } : {}), ...(profileUrl ? { profileUrl } : {}), ...(headline ? { headline } : {}) };
}

// Only these body edges may carry message text. Never recursively search arbitrary
// metadata (including subjects, titles, attributes, cards, or attachment names).
// Nested body fields take precedence over a wrapper's generic `text` field.
const bodyKeys = ['body', 'messageBody', 'attributedBody', 'eventContent', 'content', 'commentary'] as const;
function textFrom(obj: JsonRecord): string | undefined {
  const seen = new WeakSet<object>();
  let remaining = 100;
  const read = (value: unknown, depth: number): string | undefined => {
    if (depth > 8 || remaining-- <= 0) return undefined;
    if (typeof value === 'string') return cleanText(value);
    if (!record(value) || seen.has(value)) return undefined;
    seen.add(value);
    for (const key of bodyKeys) {
      const found = read(value[key], depth + 1);
      if (found) return found;
    }
    return cleanText(value.text);
  };
  return read(obj, 0);
}

function conversationIdForMessage(obj: JsonRecord, conversationUrn?: string): string | undefined {
  const reference = urnAt(obj, 'conversationUrn', 'backendConversationUrn', 'conversation', '*conversation') ?? conversationUrn;
  return conversationIdFromUrn(reference) ?? cleanText(stringAt(obj, 'conversationId'));
}

function looksLikeMessageCandidate(obj: JsonRecord, conversationUrn?: string): boolean {
  const entityUrn = urnAt(obj, 'entityUrn', 'eventUrn', 'messageUrn', 'backendUrn');
  const entityType = entityUrn?.match(/^urn:li:([^:]+):/i)?.[1];
  if (/(?:message|event)/i.test(entityType ?? '')) return true;
  const hasSender = Boolean(identityUrnAt(obj, 'from', '*from', 'sender', '*sender', 'actor', '*actor', 'senderUrn', 'participantUrn'));
  const hasConversation = Boolean(conversationIdForMessage(obj, conversationUrn));
  const hasTimestamp = numberOrStringAt(obj, 'createdAt', 'sentAt', 'deliveredAt', 'timestamp', 'created') !== undefined;
  const hasContentShape = ['text', ...bodyKeys, 'subject', 'attachments', 'renderContent'].some((key) => key in obj);
  return hasSender && hasConversation && hasTimestamp && hasContentShape;
}

function attachmentFrom(root: unknown): Attachment | undefined {
  if (!record(root)) return undefined;
  const id = cleanText(stringAt(root, 'id', 'entityUrn', 'urn', 'mediaUrn', 'assetUrn', 'digitalmediaAssetUrn'));
  const name = cleanText(stringAt(root, 'fileName', 'filename', 'name'));
  const type = cleanText(stringAt(root, 'mimeType', 'mediaType', 'contentType', 'type'));
  const rawUrl = stringAt(root, 'downloadUrl', 'mediaUrl', 'url');
  let url: string | undefined;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, 'https://www.linkedin.com');
      if (parsed.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(parsed.hostname)) url = parsed.toString();
    } catch { /* malformed attachment URLs are omitted without losing the message */ }
  }
  const meaningfulType = Boolean(type && (/^[\w.+-]+\/[\w.+-]+$/.test(type) || /^(?:file|image|video|audio|document|attachment)$/i.test(type)));
  if (!id && !name && !url && !meaningfulType) return undefined;
  return { ...(id ? { id } : {}), ...(name ? { name } : {}), ...(type ? { type } : {}), ...(url ? { url } : {}) };
}

function attachmentsFrom(obj: JsonRecord): Attachment[] {
  const roots: unknown[] = [];
  const explicit = obj.attachments;
  if (Array.isArray(explicit)) roots.push(...explicit.slice(0, 100));
  else if (record(explicit)) roots.push(explicit);
  const rendered = obj.renderContent;
  // Only known media discriminants establish an attachment boundary. A generic
  // renderer's type, card title, or tracking ID is not attachment evidence.
  for (const value of (Array.isArray(rendered) ? rendered.slice(0, 100) : [rendered])) {
    if (!record(value) || !record(value.content)) continue;
    for (const key of ['file', 'image', 'video', 'audio', 'document']) {
      if (record(value.content[key])) roots.push(value.content[key]);
    }
  }
  const unique = new Map<string, Attachment>();
  for (const root of roots.slice(0, 100)) {
    const attachment = attachmentFrom(root);
    if (!attachment) continue;
    const key = JSON.stringify([attachment.id, attachment.name, attachment.type, attachment.url]);
    unique.set(key, attachment);
  }
  return [...unique.values()];
}

function messageFrom(obj: JsonRecord, index: IncludedIndex, sourcePage: string, conversationUrn?: string): RawMessage | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'eventUrn', 'messageUrn', 'backendUrn');
  const senderUrn = identityUrnAt(obj, 'from', '*from', 'sender', '*sender', 'actor', '*actor', 'senderUrn', 'participantUrn');
  const text = textFrom(obj);
  const attachments = attachmentsFrom(obj);
  const sentAt = numberOrStringAt(obj, 'createdAt', 'sentAt', 'deliveredAt', 'timestamp', 'created');
  // Empty text is accepted only when the bounded adapter preserved meaningful
  // attachment/rich-content metadata. Unknown content still fails coverage closed.
  if (!looksLikeMessageCandidate(obj, conversationUrn) || (!text && !attachments.length)) return undefined;
  const senderValue = ['from', '*from', 'sender', '*sender', 'actor', '*actor'].map((key) => obj[key]).find((value) => record(value) || typeof value === 'string');
  const senderObj = record(senderValue) ? senderValue : typeof senderValue === 'string' ? lookupIncluded(index, senderValue) : undefined;
  const senderProfile = senderObj ? profileFrom(senderObj, index) : undefined;
  const senderName = senderProfile ? cleanText(stringAt(senderProfile, 'name', 'fullName')) ?? cleanText([stringAt(senderProfile, 'firstName'), stringAt(senderProfile, 'lastName')].filter(Boolean).join(' ')) : undefined;
  const senderProfileUrl = senderProfile && stringAt(senderProfile, 'publicIdentifier') ? `https://www.linkedin.com/in/${stringAt(senderProfile, 'publicIdentifier')}` : undefined;
  const id = messageIdFromUrn(entityUrn) ?? cleanText(stringAt(obj, 'id'));
  const conversationId = conversationIdForMessage(obj, conversationUrn);
  const senderId = personIdFromUrn(senderUrn);
  const messageType = cleanText(stringAt(obj, 'subtype', 'eventType', 'type'));
  return { ...(id ? { id } : {}), ...(entityUrn ? { entityUrn } : {}), ...(conversationId ? { conversationId } : {}), ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}), ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt !== undefined ? { sentAt } : {}), ...(text ? { text } : {}), ...(messageType ? { messageType } : {}), ...(attachments.length ? { attachments } : {}), sourceMetadata: { sourcePage } };
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

function starredFromTrustedCategories(obj: JsonRecord): boolean | undefined {
  if (!('categories' in obj)) return undefined;
  const categories = obj.categories;
  // The field is authoritative only on a trusted conversation-list object and
  // only when its complete observed shape is the expected string array. An
  // unknown/mixed future shape must not silently turn a starred conversation
  // into `false`.
  if (!Array.isArray(categories) || categories.some((category) => typeof category !== 'string')) return undefined;
  return categories.some((category) => category.toLocaleUpperCase('en-US') === 'STARRED');
}

function conversationFrom(obj: JsonRecord, index: IncludedIndex, sourcePage: string, wrappedMessageObjects?: WeakSet<object>, allowTrustedListEvidence = false): RawConversation | undefined {
  const entityUrn = urnAt(obj, 'entityUrn', 'conversationUrn', 'backendUrn');
  const participantValues = childrenFrom(obj, 'participants', '*participants', 'conversationParticipants', 'members');
  const messageValues = childrenFrom(obj, 'events', '*events', 'messages', '*messages', 'conversationEvents');
  const hasConversationShape = participantValues.length > 0 || messageValues.length > 0
    || ['conversationParticipants', 'events', 'messages', 'lastActivityAt', 'conversationUrl', 'unreadCount'].some((key) => key in obj);
  // Dash message events embed `{ conversation: { entityUrn } }`. The bare reference
  // identifies the parent but is not a second conversation result.
  const looksConversation = (/(?:messagingThread|messengerConversation|messagingConversation|msg_conversation|conversation)/i.test(entityUrn ?? '') && hasConversationShape)
    || (participantValues.length > 0 && ('events' in obj || 'messages' in obj));
  if (!looksConversation) return undefined;
  const rawId = cleanText(stringAt(obj, 'id'));
  const id = conversationIdFromUrn(entityUrn) ?? conversationIdFromUrn(rawId) ?? rawId;
  const participants = participantValues.map((p) => participantFrom(p, index)).filter((p): p is RawParticipant => Boolean(p));
  const resolvedMessageValues = messageValues.map((value) => resolveIncludedReference(value, index).object);
  resolvedMessageValues.filter(record).forEach((value) => wrappedMessageObjects?.add(value));
  const messages: RawMessage[] = resolvedMessageValues.filter(record).flatMap((m, sourceOrder) => {
    const message = messageFrom(m, index, sourcePage, entityUrn);
    return message ? [{ ...message, sourceOrder }] : [];
  });
  const parserMisses = messageValues.length - messages.length;
  const lastActivityAt = numberOrStringAt(obj, 'lastActivityAt', 'lastActivity', 'updatedAt', 'createdAt');
  // A typed conversation URN is the stable identity boundary. LinkedIn's
  // conversationUrl field is presentation data and currently varies between
  // relative, decorated and SPA forms, so derive the exact thread route from
  // the verified identity whenever it is available.
  const url = id
    ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(id)}/`
    : stringAt(obj, 'conversationUrl', 'navigationUrl');
  const paging = record(obj.paging) ? obj.paging : record(obj.pageInfo) ? obj.pageInfo : undefined;
  const total = paging && typeof paging.total === 'number' ? paging.total : undefined;
  const historyComplete = messageValues.length > 0 && parserMisses === 0 && (paging?.hasNextPage === false || (total !== undefined && messageValues.length >= total));
  const evidence = historyComplete || parserMisses > 0 ? JSON.stringify([{ resource: `conversation:${id ?? entityUrn ?? 'unknown'}`, page: sourcePage, start: 0, count: messageValues.length, total: messageValues.length, end: historyComplete, valid: parserMisses === 0 }]) : undefined;
  // Current Dash list responses expose unreadCount rather than a separate read
  // boolean. Zero is direct server evidence that opening this conversation
  // cannot newly transition it from unread to read.
  const explicitRead = allowTrustedListEvidence
    ? typeof obj.read === 'boolean' ? obj.read
      : typeof obj.unreadCount === 'number' && Number.isInteger(obj.unreadCount) && obj.unreadCount >= 0
        ? obj.unreadCount === 0
        : undefined
    : undefined;
  const isStarred = allowTrustedListEvidence ? starredFromTrustedCategories(obj) : undefined;
  const hasSourceMetadata = explicitRead !== undefined || historyComplete || parserMisses > 0;
  return {
    ...(id ? { id } : {}),
    ...(entityUrn ? { entityUrn } : {}),
    ...(url ? { url } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(isStarred !== undefined ? { isStarred } : {}),
    participants,
    messages,
    ...(hasSourceMetadata ? { sourceMetadata: { ...(explicitRead !== undefined ? { read: explicitRead, readEvidence: 'network-explicit' } : {}), ...((historyComplete || parserMisses > 0) ? { historyComplete } : {}), ...(parserMisses ? { parserMisses } : {}), ...(evidence ? { historyEvidence: evidence } : {}) } } : {}),
  };
}

function walk(value: unknown, visit: (obj: JsonRecord) => void, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit, seen)); return; }
  const obj = value as JsonRecord;
  visit(obj);
  Object.values(obj).forEach((item) => walk(item, visit, seen));
}

function trustedObservedConversationObjects(payload: unknown, sourceUrl: string, options: NetworkParseOptions): WeakSet<object> {
  const trusted = new WeakSet<object>();
  if (options.observedMethod?.toUpperCase() !== 'GET') return trusted;
  try {
    const url = assertAllowedReadUrl(sourceUrl);
    if (url.pathname !== '/voyager/api/voyagerMessagingGraphQL/graphql') return trusted;
    const operation = url.searchParams.get('queryId');
    if (!operation || !/^messengerConversations(?:[._-][A-Za-z0-9_-]+)?$/.test(operation)) return trusted;
    const root = record(payload) ? payload : undefined;
    const data = root && record(root.data) ? root.data : undefined;
    // The persisted operation keeps a stable messengerConversations name while
    // LinkedIn can rename its direct response field. Trust only direct GraphQL
    // result collections from this exact observed GET; never recursively trust
    // similarly shaped tracking or nested objects.
    const collections = [
      ...(data ? Object.values(data).filter(record) : []),
      ...(root && !data ? Object.values(root).filter(record) : []),
    ];
    for (const collection of collections) {
      for (const value of childrenFrom(collection, 'elements', 'nodes', 'edges')) {
        if (record(value)) trusted.add(value);
      }
    }
    return trusted;
  } catch { return trusted; }
}

export function parseNetworkPayload(payload: unknown, sourceUrl = '', options: NetworkParseOptions = {}): ParsedNetworkData {
  const sourcePage = sha256Id('network-page', [sourceUrl || 'inline']);
  const objects: JsonRecord[] = [];
  walk(payload, (obj) => objects.push(obj));
  const index = buildIncludedIndex(payload);
  const wrappedMessageObjects = new WeakSet<object>();
  const trustedConversationListObjects = trustedObservedConversationObjects(payload, sourceUrl, options);
  const conversations = objects.map((obj) => conversationFrom(obj, index, sourcePage, wrappedMessageObjects, trustedConversationListObjects.has(obj))).filter((c): c is RawConversation => Boolean(c));
  const wrappedMisses = conversations.reduce((sum, conversation) => sum + Number(conversation.sourceMetadata?.parserMisses ?? 0), 0);
  const standaloneCandidates = isHistoryResource(sourceUrl) ? uniqueEnvelopeElements(restEnvelopeElements(payload)).map((value, sourceOrder) => {
    const resolution = resolveIncludedReference(value, index);
    return { value, resolved: resolution.object, candidate: resolution.messageLike, sourceOrder };
  }).filter((entry) => entry.candidate && (!entry.resolved || !wrappedMessageObjects.has(entry.resolved))) : [];
  const standaloneResults = standaloneCandidates.map((entry) => {
    const parsed = entry.resolved ? messageFrom(entry.resolved, index, sourcePage) : undefined;
    return { ...entry, parsed: parsed ? { ...parsed, sourceOrder: entry.sourceOrder } : undefined };
  });
  const standaloneMisses = standaloneResults.filter((result) => !result.parsed?.conversationId);
  const standaloneObjects = new WeakSet(standaloneResults.map((entry) => entry.resolved).filter(record));
  const nestedMisses: Array<{ resolved: JsonRecord }> = [];
  const nestedMessages: RawMessage[] = objects.flatMap((obj, sourceOrder) => {
    if (wrappedMessageObjects.has(obj) || standaloneObjects.has(obj)) return [];
    const message = messageFrom(obj, index, sourcePage);
    if (looksLikeMessageCandidate(obj) && !message?.conversationId) nestedMisses.push({ resolved: obj });
    return message ? [{ ...message, sourceOrder }] : [];
  });
  const standaloneMessages: RawMessage[] = standaloneResults.flatMap((entry) => entry.parsed?.conversationId ? [entry.parsed] : []);
  for (const message of [...standaloneMessages, ...nestedMessages]) {
    if (!message.conversationId) continue;
    let conversation = conversations.find((c) => c.id === message.conversationId);
    if (!conversation) { conversation = { id: message.conversationId, participants: [], messages: [] }; conversations.push(conversation); }
    if (message.senderId && !(conversation.participants ?? []).some((participant) => participant.id === message.senderId)) {
      (conversation.participants ??= []).push({ id: message.senderId, ...(message.senderName ? { name: message.senderName } : {}), ...(message.senderProfileUrl ? { profileUrl: message.senderProfileUrl } : {}) });
    }
    const aliases = rawNetworkMessageAliases(message);
    const duplicate = aliases.size > 0 && (conversation.messages ?? []).some((prior) => intersectsAliases(rawNetworkMessageAliases(prior), aliases));
    if (!duplicate) (conversation.messages ??= []).push(message);
  }
  let unassignedStandaloneMisses = 0;
  for (const { resolved } of [...standaloneMisses, ...nestedMisses]) {
    const conversationId = resolved ? conversationIdForMessage(resolved) : undefined;
    if (!conversationId) { unassignedStandaloneMisses += 1; continue; }
    let conversation = conversations.find((value) => value.id === conversationId);
    if (!conversation) { conversation = { id: conversationId, participants: [], messages: [] }; conversations.push(conversation); }
    conversation.sourceMetadata = {
      ...conversation.sourceMetadata,
      parserMisses: Number(conversation.sourceMetadata?.parserMisses ?? 0) + 1,
      historyComplete: false,
    };
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
  applyRestEnvelopeHistoryEvidence(payload, sourceUrl, sourcePage, conversations, unassignedStandaloneMisses);
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
  const relevantMisses = wrappedMisses + standaloneMisses.length + nestedMisses.length;
  return { conversations, ...(account ? { account } : {}), paginationUrls: [...paginationUrls], strategies: conversations.length ? ['network:recursive-voyager'] : [], misses: relevantMisses };
}

function restEnvelopeElements(payload: unknown): unknown[] {
  if (!record(payload)) return [];
  if (Array.isArray(payload.elements)) return payload.elements;
  if (!record(payload.data)) return [];
  if (Array.isArray(payload.data.elements)) return payload.data.elements;
  // Current persisted messengerMessages GraphQL responses wrap the resource
  // collection under one operation-specific field below `data`.
  return Object.values(payload.data).filter(record)
    .flatMap((value) => Array.isArray(value.elements) ? value.elements : []);
}

function looksLikeMessageReference(value: string): boolean {
  const entityType = normalizeUrn(value)?.match(/^urn:li:([^:]+):/i)?.[1];
  return /(?:message|event)/i.test(entityType ?? '');
}

function uniqueEnvelopeElements(values: unknown[]): unknown[] {
  const seenAliases = new Set<string>();
  const unique: unknown[] = [];
  for (const value of values) {
    const aliases = envelopeElementAliases(value);
    const duplicate = aliases.size > 0 && [...aliases].some((alias) => seenAliases.has(alias));
    aliases.forEach((alias) => seenAliases.add(alias));
    if (!duplicate) unique.push(value);
  }
  return unique;
}

function envelopeElementAliases(value: unknown): Set<string> {
  const aliases = new Set<string>();
  const urn = typeof value === 'string' ? normalizeUrn(value) : record(value) ? urnAt(value, 'entityUrn', 'eventUrn', 'messageUrn', 'backendUrn') : undefined;
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = messageIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  if (record(value)) {
    const id = cleanText(stringAt(value, 'id'));
    if (id) aliases.add(`id:${id}`);
  }
  return aliases;
}

function rawNetworkMessageAliases(message: RawMessage): Set<string> {
  const aliases = new Set<string>();
  if (message.id) aliases.add(`id:${message.id}`);
  const urn = normalizeUrn(message.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = messageIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  return aliases;
}

function intersectsAliases(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((alias) => right.has(alias));
}

function buildIncludedIndex(payload: unknown): IncludedIndex {
  const index: IncludedIndex = { records: new Map(), ambiguous: new Set() };
  walk(payload, (container) => {
    const included = Array.isArray(container.included)
      ? container.included
      : record(container.included) && Array.isArray(container.included.elements)
        ? container.included.elements
        : undefined;
    if (!included) return;
    for (const value of included) {
      if (!record(value)) continue;
      for (const key of ['entityUrn', 'urn', 'objectUrn', 'eventUrn', 'messageUrn']) {
        const raw = stringAt(value, key);
        const urn = normalizeUrn(raw);
        if (!urn || index.ambiguous.has(urn)) continue;
        const prior = index.records.get(urn);
        if (prior && prior !== value) { index.records.delete(urn); index.ambiguous.add(urn); }
        else index.records.set(urn, value);
      }
    }
  });
  return index;
}

type ReferenceResolution = { object?: JsonRecord; messageLike: boolean };

function resolveIncludedReference(value: unknown, index: IncludedIndex, depth = 0, seen = new Set<string>()): ReferenceResolution {
  if (depth > 8) return { messageLike: typeof value === 'string' && looksLikeMessageReference(value) };
  if (record(value)) {
    if (looksLikeMessageCandidate(value)) return { object: value, messageLike: true };
    const nested = ['*event', 'event', '*message', 'message', '*entity', 'entity']
      .map((key) => ({ key, value: value[key] }))
      .find((candidate) => typeof candidate.value === 'string' || record(candidate.value));
    if (!nested) return { object: value, messageLike: false };
    const resolution = resolveIncludedReference(nested.value, index, depth + 1, seen);
    return { ...resolution, messageLike: /event|message/i.test(nested.key) || resolution.messageLike };
  }
  if (typeof value !== 'string') return { messageLike: false };
  const messageLike = looksLikeMessageReference(value);
  const reference = normalizeUrn(value);
  if (!reference || seen.has(reference)) return { messageLike };
  seen.add(reference);
  const resolved = lookupIncluded(index, reference);
  if (!resolved) return { messageLike };
  const nested = resolveIncludedReference(resolved, index, depth + 1, seen);
  return { ...nested, messageLike: messageLike || nested.messageLike };
}

function applyRestEnvelopeHistoryEvidence(payload: unknown, sourceUrl: string, sourcePage: string, conversations: RawConversation[], resourceMisses = 0): void {
  if (!isHistoryResource(sourceUrl) || !record(payload)) return;
  const data = record(payload.data) ? payload.data : undefined;
  const paging = record(payload.paging) ? payload.paging : data && record(data.paging) ? data.paging : undefined;
  if (!paging) return;
  const start = typeof paging.start === 'number' ? paging.start : undefined;
  const count = typeof paging.count === 'number' ? paging.count : undefined;
  const total = typeof paging.total === 'number' ? paging.total : undefined;
  if (start === undefined || count === undefined) return;
  const end = paging.hasNextPage === false || (total !== undefined && start + count >= total);
  const resource = historyResourceId(sourceUrl);
  for (const conversation of conversations) {
    const parserMisses = Number(conversation.sourceMetadata?.parserMisses ?? 0) + resourceMisses;
    const priorEvidence = readEvidence(conversation.sourceMetadata?.historyEvidence);
    const evidence = [...priorEvidence, { resource, page: sourcePage, start, count, ...(total !== undefined ? { total } : {}), end, valid: parserMisses === 0 }];
    conversation.sourceMetadata = {
      ...conversation.sourceMetadata,
      historyEvidence: JSON.stringify(evidence),
      // A single REST page is complete only when it covers the resource from zero.
      historyComplete: parserMisses === 0 && start === 0 && end,
    };
  }
}

type HistoryEvidence = { resource: string; page: string; start: number; count: number; total?: number; end: boolean; valid: boolean };

function readEvidence(value: unknown): HistoryEvidence[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is HistoryEvidence => record(item) && typeof item.resource === 'string' && typeof item.page === 'string') : [];
  } catch { return []; }
}

function isHistoryResource(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl, 'https://www.linkedin.com');
    if (/\/(?:events|messages|history)(?:[/?#]|$)/i.test(url.pathname)) return true;
    return url.pathname === '/voyager/api/voyagerMessagingGraphQL/graphql'
      && /^messengerMessages(?:\.[A-Fa-f0-9]{32,128})?$/.test(url.searchParams.get('queryId') ?? '');
  }
  catch { return false; }
}

function historyResourceId(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl, 'https://www.linkedin.com');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:start|count|cursor|paginationToken)$/i.test(key)) url.searchParams.delete(key);
      else {
        const value = url.searchParams.get(key);
        if (value && /(?:cursor|paginationToken):/i.test(value)) url.searchParams.set(key, value.replace(/((?:cursor|paginationToken):)[^,)]+/gi, '$1*'));
      }
    }
    return sha256Id('history-resource', [url.origin, url.pathname, [...url.searchParams.entries()].sort()]);
  } catch { return sha256Id('history-resource', [sourceUrl]); }
}

function normalizePaginationUrl(href: string, sourceUrl: string): string | undefined {
  try {
    const base = sourceUrl ? new URL(sourceUrl, 'https://www.linkedin.com') : new URL('https://www.linkedin.com');
    const url = new URL(href, base);
    return assertAllowedReadUrl(url.toString()).toString();
  } catch { return undefined; }
}

function deriveQueryUrl(sourceUrl: string, key: string, value: string): string | undefined {
  try {
    const url = assertAllowedReadUrl(sourceUrl);
    url.searchParams.set(key, value);
    return assertAllowedReadUrl(url.toString()).toString();
  } catch { return undefined; }
}

function deriveCursorUrl(sourceUrl: string, cursor: string): string | undefined {
  try {
    const url = new URL(sourceUrl, 'https://www.linkedin.com');
    const directKey = [...url.searchParams.keys()].find((key) => /^(?:cursor|paginationToken)$/i.test(key));
    if (directKey) return deriveQueryUrl(sourceUrl, directKey, cursor);
    const variables = url.searchParams.get('variables');
    if (!variables) return undefined;
    if (/^\s*\(/.test(variables)) {
      const replaced = variables.replace(/(^|[,(])((?:cursor|paginationToken)):[^,)]+/i, (_match, prefix: string, key: string) => `${prefix}${key}:${cursor}`);
      if (replaced === variables) return undefined;
      url.searchParams.set('variables', replaced);
      return url.toString();
    }
    const parsed = JSON.parse(variables) as Record<string, unknown>;
    const variableKey = Object.keys(parsed).find((key) => /^(?:cursor|paginationToken)$/i.test(key));
    if (!variableKey) return undefined;
    parsed[variableKey] = cursor;
    url.searchParams.set('variables', JSON.stringify(parsed));
    return url.toString();
  } catch { return undefined; }
}
