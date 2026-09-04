import { AppError } from '../errors.js';
import { canonicalLinkedInUrl } from './normalize.js';
import { classifyRecruiter } from './recruiter.js';
import { conversationIdFromUrn, messageIdFromUrn, normalizeUrn, personIdFromUrn, sha256Id } from './stable-id.js';
import { ExportSchema, type Conversation, type LinkedInExport, type Message, type Participant } from './schema.js';

function present<T>(next: T | undefined, old: T | undefined): T | undefined { return next ?? old; }
function latest(...values: Array<string | undefined>): string | undefined { return values.filter((value): value is string => Boolean(value)).sort().at(-1); }
function chooseId(oldId: string | undefined, nextId: string, fallbackPrefix: string): string {
  if (!oldId) return nextId;
  return oldId.startsWith(`${fallbackPrefix}_`) && !nextId.startsWith(`${fallbackPrefix}_`) ? nextId : oldId;
}

function profileAlias(url?: string): string | undefined {
  const match = canonicalLinkedInUrl(url)?.match(/^https:\/\/www\.linkedin\.com\/in\/([^/]+)$/i);
  return match?.[1] ? `profile:${match[1].toLowerCase()}` : undefined;
}

function threadAlias(url?: string): string | undefined {
  const match = canonicalLinkedInUrl(url)?.match(/\/messaging\/thread\/([^/]+)/i);
  return match?.[1] ? `id:${decodeURIComponent(match[1])}` : undefined;
}

function conversationAliases(value: Pick<Conversation, 'id' | 'entityUrn' | 'url'>): Set<string> {
  const aliases = new Set([`id:${value.id}`]);
  const urn = normalizeUrn(value.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = conversationIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  const route = threadAlias(value.url);
  if (route) aliases.add(route);
  return aliases;
}

function participantAliases(value: Pick<Participant, 'id' | 'entityUrn' | 'profileUrl'>): Set<string> {
  const aliases = new Set([`id:${value.id}`]);
  const urn = normalizeUrn(value.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = personIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  const profile = profileAlias(value.profileUrl);
  if (profile) aliases.add(profile);
  return aliases;
}

function messageAliases(value: Pick<Message, 'id' | 'entityUrn'>): Set<string> {
  const aliases = new Set([`id:${value.id}`]);
  const urn = normalizeUrn(value.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = messageIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  return aliases;
}

function intersects(left: Set<string>, right: Set<string>): boolean { return [...left].some((alias) => right.has(alias)); }

function mergeParticipantFields(old: Participant, next: Participant): Participant {
  const id = chooseId(old.id, next.id, 'member');
  const isSelf = old.isSelf || next.isSelf;
  return {
    id,
    ...(present(next.entityUrn, old.entityUrn) ? { entityUrn: present(next.entityUrn, old.entityUrn)! } : {}),
    name: next.name || old.name,
    ...(present(next.profileUrl, old.profileUrl) ? { profileUrl: present(next.profileUrl, old.profileUrl)! } : {}),
    ...(present(next.headline, old.headline) ? { headline: present(next.headline, old.headline)! } : {}),
    ...(present(next.company, old.company) ? { company: present(next.company, old.company)! } : {}),
    isSelf,
    probablyRecruiter: false,
    recruiterSignals: [],
  };
}

function mergeParticipants(old: Participant[], next: Participant[]): { participants: Participant[]; senderAliases: Map<string, string> } {
  const entries = old.map((participant) => ({ value: { ...participant }, aliases: participantAliases(participant) }));
  for (const incoming of next) {
    const aliases = participantAliases(incoming);
    const matches = entries.map((entry, index) => intersects(entry.aliases, aliases) ? index : -1).filter((index) => index >= 0);
    if (matches.length > 1) throw new AppError('VALIDATION_FAILED', `Ambiguous participant identity aliases for ${incoming.id}`);
    if (!matches.length) entries.push({ value: { ...incoming }, aliases });
    else {
      const entry = entries[matches[0]!]!;
      entry.value = mergeParticipantFields(entry.value, incoming);
      aliases.forEach((alias) => entry.aliases.add(alias));
      participantAliases(entry.value).forEach((alias) => entry.aliases.add(alias));
    }
  }
  const senderAliases = new Map<string, string>();
  for (const entry of entries) for (const alias of entry.aliases) if (alias.startsWith('id:')) senderAliases.set(alias.slice(3), entry.value.id);
  return { participants: entries.map((entry) => entry.value), senderAliases };
}

function messageFingerprint(message: Message, senderId: string): string {
  return sha256Id('fingerprint', [senderId, message.sentAt, message.messageType, message.text, message.attachments]);
}

function mergeMessageFields(old: Message, next: Message, conversationId: string, senderId: string): Message {
  return { ...old, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== '')), id: chooseId(old.id, next.id, 'message'), conversationId, senderId } as Message;
}

function mergeMessages(old: Message[], next: Message[], conversationId: string, senderAliases: Map<string, string>): Message[] {
  const entries = old.map((message) => ({ value: { ...message, conversationId, senderId: senderAliases.get(message.senderId) ?? message.senderId }, aliases: messageAliases(message), matched: false }));
  for (const rawIncoming of next) {
    const incoming = { ...rawIncoming, conversationId, senderId: senderAliases.get(rawIncoming.senderId) ?? rawIncoming.senderId };
    const aliases = messageAliases(incoming);
    let index = entries.findIndex((entry) => !entry.matched && intersects(entry.aliases, aliases));
    if (index < 0) {
      const fingerprint = messageFingerprint(incoming, incoming.senderId);
      index = entries.findIndex((entry) => !entry.matched && messageFingerprint(entry.value, entry.value.senderId) === fingerprint && (entry.value.id.startsWith('message_') || incoming.id.startsWith('message_')));
    }
    if (index < 0) entries.push({ value: incoming, aliases, matched: true });
    else {
      const entry = entries[index]!;
      entry.value = mergeMessageFields(entry.value, incoming, conversationId, incoming.senderId);
      aliases.forEach((alias) => entry.aliases.add(alias));
      messageAliases(entry.value).forEach((alias) => entry.aliases.add(alias));
      entry.matched = true;
    }
  }
  const messages = entries.map((entry) => entry.value).sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.id.localeCompare(b.id));
  messages.forEach((message, sequence) => { message.sequence = sequence; message.conversationId = conversationId; });
  return messages;
}

function mergeConversation(old: Conversation | undefined, next: Conversation): Conversation {
  const id = chooseId(old?.id, next.id, 'conversation');
  const mergedParticipants = mergeParticipants(old?.participants ?? [], next.participants);
  const messages = mergeMessages(old?.messages ?? [], next.messages, id, mergedParticipants.senderAliases);
  const participants = mergedParticipants.participants.map((participant) => ({
    ...participant,
    ...classifyRecruiter({ isSelf: participant.isSelf, ...(participant.headline ? { headline: participant.headline } : {}), ...(participant.company ? { company: participant.company } : {}), messages: messages.filter((message) => message.senderId === participant.id).map((message) => message.text) }),
  })).sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const latestMessage = [...messages].reverse().find((message) => message.sentAt)?.sentAt;
  return {
    id,
    ...(present(next.entityUrn, old?.entityUrn) ? { entityUrn: present(next.entityUrn, old?.entityUrn)! } : {}),
    ...(present(next.url, old?.url) ? { url: present(next.url, old?.url)! } : {}),
    ...(latest(next.lastActivityAt, latestMessage, old?.lastActivityAt) ? { lastActivityAt: latest(next.lastActivityAt, latestMessage, old?.lastActivityAt)! } : {}),
    participants,
    messages,
    ...(present(next.sourceMetadata, old?.sourceMetadata) ? { sourceMetadata: present(next.sourceMetadata, old?.sourceMetadata)! } : {}),
  };
}

function accountStrength(account: LinkedInExport['account']): number {
  if (personIdFromUrn(account.entityUrn) === account.id) return 4;
  if (!account.id.startsWith('self_')) return 3;
  return profileAlias(account.profileUrl) ? 2 : 1;
}

function mergeAccount(old: LinkedInExport['account'] | undefined, next: LinkedInExport['account']): LinkedInExport['account'] {
  if (!old) return next;
  const oldStrength = accountStrength(old);
  const nextStrength = accountStrength(next);
  if (oldStrength >= 3 && nextStrength >= 3 && old.id !== next.id) throw new AppError('VALIDATION_FAILED', 'The export belongs to a different LinkedIn account');
  const identity = nextStrength > oldStrength ? next : old;
  const entityUrn = identity.entityUrn ?? old.entityUrn ?? next.entityUrn;
  const profileUrl = next.profileUrl ?? old.profileUrl;
  return { id: identity.id, ...(entityUrn ? { entityUrn } : {}), name: next.name || old.name, ...(profileUrl ? { profileUrl } : {}) };
}

export function mergeExports(old: LinkedInExport | undefined, next: LinkedInExport): LinkedInExport {
  const entries = (old?.conversations ?? []).map((conversation) => ({ value: conversation, aliases: conversationAliases(conversation) }));
  for (const incoming of next.conversations) {
    const aliases = conversationAliases(incoming);
    const matches = entries.map((entry, index) => intersects(entry.aliases, aliases) ? index : -1).filter((index) => index >= 0);
    if (matches.length > 1) throw new AppError('VALIDATION_FAILED', `Ambiguous conversation identity aliases for ${incoming.id}`);
    if (!matches.length) entries.push({ value: mergeConversation(undefined, incoming), aliases });
    else {
      const entry = entries[matches[0]!]!;
      entry.value = mergeConversation(entry.value, incoming);
      aliases.forEach((alias) => entry.aliases.add(alias));
      conversationAliases(entry.value).forEach((alias) => entry.aliases.add(alias));
    }
  }
  const sorted = entries.map((entry) => entry.value).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id));
  return ExportSchema.parse({
    ...next,
    account: mergeAccount(old?.account, next.account),
    conversations: sorted,
    stats: {
      ...next.stats,
      exportedConversationCount: sorted.length,
      exportedMessageCount: sorted.reduce((sum, conversation) => sum + conversation.messages.length, 0),
      warnings: [...new Set(next.stats.warnings)].sort(),
      partial: next.stats.partial,
    },
  });
}

