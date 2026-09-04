import { classifyRecruiter } from './recruiter.js';
import { ExportSchema, type Conversation, type LinkedInExport, type Message, type Participant } from './schema.js';

function present<T>(next: T | undefined, old: T | undefined): T | undefined { return next ?? old; }
function latest(...values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function mergeParticipant(old: Participant | undefined, next: Participant, messages: Message[]): Participant {
  const merged = {
    id: next.id,
    ...(present(next.entityUrn, old?.entityUrn) ? { entityUrn: present(next.entityUrn, old?.entityUrn)! } : {}),
    name: next.name || old?.name || 'Unknown participant',
    ...(present(next.profileUrl, old?.profileUrl) ? { profileUrl: present(next.profileUrl, old?.profileUrl)! } : {}),
    ...(present(next.headline, old?.headline) ? { headline: present(next.headline, old?.headline)! } : {}),
    ...(present(next.company, old?.company) ? { company: present(next.company, old?.company)! } : {}),
    isSelf: next.isSelf || old?.isSelf === true,
  };
  return { ...merged, ...classifyRecruiter({ isSelf: merged.isSelf, ...(merged.headline ? { headline: merged.headline } : {}), ...(merged.company ? { company: merged.company } : {}), messages: messages.filter((m) => m.senderId === merged.id).map((m) => m.text) }) };
}

function mergeConversation(old: Conversation | undefined, next: Conversation): Conversation {
  const messagesById = new Map((old?.messages ?? []).map((m) => [m.entityUrn ?? m.id, m]));
  for (const message of next.messages) {
    const key = message.entityUrn ?? message.id;
    const prior = messagesById.get(key);
    messagesById.set(key, prior ? { ...prior, ...Object.fromEntries(Object.entries(message).filter(([, v]) => v !== undefined && v !== '')) } as Message : message);
  }
  const messages = [...messagesById.values()].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.id.localeCompare(b.id));
  messages.forEach((m, i) => { m.sequence = i; m.conversationId = next.id; });
  const participantsById = new Map((old?.participants ?? []).map((p) => [p.entityUrn ?? p.profileUrl ?? p.id, p]));
  for (const p of next.participants) {
    const key = p.entityUrn ?? p.profileUrl ?? p.id;
    participantsById.set(key, mergeParticipant(participantsById.get(key), p, messages));
  }
  const participants = [...participantsById.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const latestMessage = [...messages].reverse().find((m) => m.sentAt)?.sentAt;
  return {
    id: next.id,
    ...(present(next.entityUrn, old?.entityUrn) ? { entityUrn: present(next.entityUrn, old?.entityUrn)! } : {}),
    ...(present(next.url, old?.url) ? { url: present(next.url, old?.url)! } : {}),
    ...(latest(next.lastActivityAt, latestMessage, old?.lastActivityAt) ? { lastActivityAt: latest(next.lastActivityAt, latestMessage, old?.lastActivityAt)! } : {}),
    participants,
    messages,
    ...(present(next.sourceMetadata, old?.sourceMetadata) ? { sourceMetadata: present(next.sourceMetadata, old?.sourceMetadata)! } : {}),
  };
}

export function mergeExports(old: LinkedInExport | undefined, next: LinkedInExport): LinkedInExport {
  const conversations = new Map((old?.conversations ?? []).map((c) => [c.entityUrn ?? c.id, c]));
  for (const incoming of next.conversations) {
    const key = incoming.entityUrn ?? incoming.id;
    conversations.set(key, mergeConversation(conversations.get(key), incoming));
  }
  const sorted = [...conversations.values()].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id));
  return ExportSchema.parse({
    ...next,
    conversations: sorted,
    stats: {
      ...next.stats,
      exportedConversationCount: sorted.length,
      exportedMessageCount: sorted.reduce((sum, c) => sum + c.messages.length, 0),
      warnings: [...new Set(next.stats.warnings)].sort(),
      partial: next.stats.partial,
    },
  });
}
