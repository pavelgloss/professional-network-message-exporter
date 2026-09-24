import { classifyRecruiter } from './recruiter.js';
import { conversationIdFromUrn, messageIdFromUrn, normalizeUrn, personIdFromUrn, sha256Id } from './stable-id.js';
import type { Conversation, RawConversation, RawMessage, RawParticipant } from './schema.js';
import { AppError } from '../errors.js';

export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\r\n/g, '\n').trim();
  return clean || undefined;
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let date: Date;
  if (typeof value === 'number' || /^\d{10,16}$/.test(String(value))) {
    let epoch = Number(value);
    if (epoch > 1e14) epoch /= 1_000;
    else if (epoch < 1e11) epoch *= 1_000;
    date = new Date(epoch);
  } else date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function canonicalLinkedInUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value, 'https://www.linkedin.com');
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return undefined;
    url.protocol = 'https:';
    url.hostname = 'www.linkedin.com';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return undefined; }
}

function participant(raw: RawParticipant, messages: RawMessage[]) {
  const entityUrn = normalizeUrn(raw.entityUrn);
  const profileUrl = canonicalLinkedInUrl(raw.profileUrl);
  const name = cleanText(raw.name) ?? 'Unknown participant';
  const id = cleanText(raw.id) ?? personIdFromUrn(entityUrn) ?? sha256Id('member', [profileUrl, name]);
  const headline = cleanText(raw.headline);
  const company = cleanText(raw.company);
  const isSelf = raw.isSelf === true;
  const authored = messages.filter((m) => m.senderId === id).map((m) => cleanText(m.text)).filter((x): x is string => Boolean(x));
  return { id, ...(entityUrn ? { entityUrn } : {}), name, ...(profileUrl ? { profileUrl } : {}), ...(headline ? { headline } : {}), ...(company ? { company } : {}), isSelf, ...classifyRecruiter({ isSelf, ...(headline ? { headline } : {}), ...(company ? { company } : {}), messages: authored }) };
}

export function normalizeConversation(raw: RawConversation, selfId?: string): Conversation {
  const entityUrn = normalizeUrn(raw.entityUrn);
  const url = canonicalLinkedInUrl(raw.url);
  const rawParticipants = raw.participants ?? [];
  const provisionalIds = rawParticipants.map((p) => p.isSelf && selfId ? selfId : cleanText(p.id) ?? personIdFromUrn(normalizeUrn(p.entityUrn)) ?? sha256Id('member', [canonicalLinkedInUrl(p.profileUrl), cleanText(p.name) ?? 'Unknown participant']));
  const id = cleanText(raw.id) ?? conversationIdFromUrn(entityUrn) ?? url?.match(/\/messaging\/thread\/([^/]+)/)?.[1] ?? sha256Id('conversation', [[...provisionalIds].sort(), url]);
  const rawMessages = raw.messages ?? [];
  const participants = rawParticipants.map((p, i) => participant({ ...p, id: provisionalIds[i]!, isSelf: p.isSelf ?? provisionalIds[i] === selfId }, rawMessages));
  const byId = new Map(participants.map((p) => [p.id, p]));
  const selfIds = new Set(participants.filter((p) => p.isSelf).map((p) => p.id));
  if (selfId) selfIds.add(selfId);
  const fallbackCounts = new Map<string, number>();
  const messages = rawMessages.map((message, sourceOrder) => normalizeMessage(message, id, byId, selfIds, sourceOrder, fallbackCounts));
  messages.sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || Number(a.sourceMetadata?.sourceOrder ?? 0) - Number(b.sourceMetadata?.sourceOrder ?? 0) || a.id.localeCompare(b.id));
  messages.forEach((message, sequence) => { message.sequence = sequence; });
  const lastActivityAt = normalizeTimestamp(raw.lastActivityAt) ?? [...messages].reverse().find((m) => m.sentAt)?.sentAt;
  return {
    id,
    ...(entityUrn ? { entityUrn } : {}),
    ...(url ? { url } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(raw.isStarred !== undefined ? { isStarred: raw.isStarred } : {}),
    participants,
    messages,
    ...(raw.sourceMetadata ? { sourceMetadata: raw.sourceMetadata } : {}),
  };
}

function normalizeMessage(raw: RawMessage, conversationId: string, participants: Map<string, ReturnType<typeof participant>>, selfIds: Set<string>, sourceOrder: number, fallbackCounts: Map<string, number>) {
  const entityUrn = normalizeUrn(raw.entityUrn);
  const senderId = cleanText(raw.senderId);
  if (!senderId) throw new AppError('VALIDATION_FAILED', `Message sender identity is missing in conversation ${conversationId}`);
  const sender = participants.get(senderId);
  const senderName = cleanText(raw.senderName) ?? sender?.name;
  if (!senderName) throw new AppError('VALIDATION_FAILED', `Message sender metadata is missing in conversation ${conversationId}`);
  const senderProfileUrl = canonicalLinkedInUrl(raw.senderProfileUrl) ?? sender?.profileUrl;
  const sentAt = normalizeTimestamp(raw.sentAt);
  const text = cleanText(raw.text) ?? '';
  const messageType = cleanText(raw.messageType);
  const attachments = raw.attachments?.map((a) => ({ ...(cleanText(a.id) ? { id: cleanText(a.id)! } : {}), ...(cleanText(a.name) ? { name: cleanText(a.name)! } : {}), ...(cleanText(a.type) ? { type: cleanText(a.type)! } : {}), ...(canonicalLinkedInUrl(a.url) ? { url: canonicalLinkedInUrl(a.url)! } : {}) })).filter((a) => Object.keys(a).length);
  const stableId = cleanText(raw.id) ?? messageIdFromUrn(entityUrn);
  const fallbackId = sha256Id('message', [conversationId, senderId, sentAt, messageType, text, attachments]);
  const ordinal = (fallbackCounts.get(fallbackId) ?? 0) + 1;
  if (!stableId) fallbackCounts.set(fallbackId, ordinal);
  const id = stableId ?? (ordinal === 1 ? fallbackId : `${fallbackId}_${ordinal}`);
  let direction = raw.direction;
  if (!direction && raw.sourceMetadata?.directionEvidence === 'unknown-dom') throw new AppError('VALIDATION_FAILED', `DOM message direction is ambiguous in conversation ${conversationId}`);
  if (direction === 'outbound' && !selfIds.has(senderId)) throw new AppError('VALIDATION_FAILED', `Outbound sender does not match the account in conversation ${conversationId}`);
  if (direction === 'inbound' && selfIds.has(senderId)) throw new AppError('VALIDATION_FAILED', `Inbound sender matches the account in conversation ${conversationId}`);
  if (!direction) {
    if (selfIds.has(senderId)) direction = 'outbound';
    else if (sender && !sender.isSelf) direction = 'inbound';
    else throw new AppError('VALIDATION_FAILED', `Message direction cannot be proven in conversation ${conversationId}`);
  }
  return { id, ...(entityUrn ? { entityUrn } : {}), conversationId, senderId, senderName, ...(senderProfileUrl ? { senderProfileUrl } : {}), ...(sentAt ? { sentAt } : {}), direction, sequence: sourceOrder, text, ...(messageType ? { messageType } : {}), ...(attachments?.length ? { attachments } : {}), sourceMetadata: { sourceOrder: raw.sourceOrder ?? sourceOrder } };
}
