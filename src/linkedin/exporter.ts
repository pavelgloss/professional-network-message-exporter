import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { createManifest, saveContentDiagnostics, saveContentDiagnosticsOnFailure, saveManifest } from '../io/diagnostics.js';
import { persistExportResult } from '../io/export-store.js';
import { closeContext, launchContext } from '../browser/context.js';
import { detectAuthState, assertAuthenticated } from './auth-check.js';
import { readAccountFromDom, type Account } from './account.js';
import { attachNetworkCapture } from './network/capture.js';
import { parseNetworkPayload } from './network/response-parser.js';
import { readJson } from './network/read-client.js';
import { createPaginationState, followObservedPagination } from './network/pagination.js';
import { collectConversationList } from './dom/conversation-list.js';
import { collectThread } from './dom/thread.js';
import { canonicalLinkedInUrl, normalizeConversation, normalizeTimestamp } from '../domain/normalize.js';
import { conversationIdFromUrn, messageIdFromUrn, normalizeUrn, personIdFromUrn, sha256Id } from '../domain/stable-id.js';
import { ExportSchema, type LinkedInExport, type RawConversation, type RawMessage, type RawParticipant } from '../domain/schema.js';

export async function exportMessages(config: AppConfig, logger: Logger): Promise<LinkedInExport> {
  const manifest = createManifest();
  const context = await launchContext(config, 'export', manifest, logger);
  let page = context.pages()[0] ?? await context.newPage();
  const capture = attachNetworkCapture(page, manifest, logger);
  let authenticated = false;
  try {
    logger.info('export-started', { limit: config.limit, threadOpen: config.allowThreadOpen });
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    assertAuthenticated(await detectAuthState(page));
    authenticated = true;
    await capture.drain();

    let account: Account;
    let reliableSelfId: string | undefined;
    const csrfToken = (await context.cookies('https://www.linkedin.com')).find((cookie) => cookie.name === 'JSESSIONID')?.value.replace(/^"|"$/g, '');
    try {
      const me = parseNetworkPayload(await readJson(context.request, 'https://www.linkedin.com/voyager/api/me', csrfToken), '/voyager/api/me').account;
      if (!me?.id || !me.name) throw new Error('No stable account ID in /me');
      account = { id: me.id, name: me.name, ...(me.entityUrn ? { entityUrn: me.entityUrn } : {}), ...(me.profileUrl ? { profileUrl: me.profileUrl } : {}) };
      reliableSelfId = me.id;
    } catch {
      const captured = capture.accountCandidates.find((candidate) => candidate.id && candidate.name && candidate.entityUrn && personIdFromUrn(candidate.entityUrn) === candidate.id);
      if (captured?.id && captured.name) {
        account = { id: captured.id, name: captured.name, ...(captured.entityUrn ? { entityUrn: captured.entityUrn } : {}), ...(captured.profileUrl ? { profileUrl: captured.profileUrl } : {}) };
        reliableSelfId = captured.id;
        manifest.strategies.push('account:captured-network');
      } else {
        account = await readAccountFromDom(page);
        manifest.warnings.push('ACCOUNT_STABLE_ID_UNAVAILABLE');
      }
    }

    const domList = await collectConversationList(page, config.limit);
    domList.strategies.forEach((strategy) => manifest.strategies.push(`dom-list:${strategy}`));
    manifest.warnings.push(`LIST_SCROLL_${domList.scrollReason.toUpperCase()}`);
    await capture.drain();
    const paginationState = createPaginationState();
    const paginated = await followObservedPagination(context.request, capture.paginationUrls, manifest, csrfToken, paginationState);
    const collected = [...capture.conversations, ...paginated, ...domList.conversations];
    let raw = coalesceRaw(collected);
    raw.sort((a, b) => (normalizeTimestamp(b.lastActivityAt) ?? '').localeCompare(normalizeTimestamp(a.lastActivityAt) ?? '') || rawKey(a).localeCompare(rawKey(b)));
    raw = raw.slice(0, config.limit);

    let threadCoverageComplete = true;
    if (config.allowThreadOpen) {
      logger.warn('thread-open-opt-in-active', { warning: 'Opening a thread can change LinkedIn read/unread state.' });
      for (const conversation of raw) {
        if (!conversation.url) { manifest.warnings.push(`THREAD_URL_MISSING:${conversation.id ?? 'unknown'}`); threadCoverageComplete = false; continue; }
        try {
          const thread = await collectThread(page, conversation.id ?? rawKey(conversation), conversation.url, account.profileUrl, account.id);
          conversation.messages = mergeRawMessages(conversation.messages ?? [], thread.messages);
          const participantMap = new Map((conversation.participants ?? []).map((participant) => [participant.id ?? participantKey(participant), participant]));
          for (const message of thread.messages) if (!participantMap.has(message.senderId ?? '')) {
            participantMap.set(message.senderId!, { id: message.senderId!, ...(message.senderName ? { name: message.senderName } : {}), ...(message.senderProfileUrl ? { profileUrl: message.senderProfileUrl } : {}), isSelf: message.direction === 'outbound' });
          }
          conversation.participants = [...participantMap.values()];
          collected.push(conversation);
          if (!thread.complete) {
            threadCoverageComplete = false;
            manifest.warnings.push(`THREAD_SCROLL_${thread.scrollReason.toUpperCase()}:${conversation.id ?? 'unknown'}`);
          }
          thread.strategies.forEach((strategy) => { if (!manifest.strategies.includes(`dom-thread:${strategy}`)) manifest.strategies.push(`dom-thread:${strategy}`); });
          manifest.warnings.push(...thread.warnings);
          await capture.drain();
          const threadPagination = await followObservedPagination(context.request, capture.paginationUrls, manifest, csrfToken, paginationState);
          collected.push(...capture.conversations, ...threadPagination);
          await page.waitForTimeout(350 + Math.floor(Math.random() * 300));
        } catch {
          manifest.warnings.push(`THREAD_READ_FAILED:${conversation.id ?? 'unknown'}`);
          threadCoverageComplete = false;
        }
      }
      raw = coalesceRaw(collected).sort((a, b) => (normalizeTimestamp(b.lastActivityAt) ?? '').localeCompare(normalizeTimestamp(a.lastActivityAt) ?? '') || rawKey(a).localeCompare(rawKey(b))).slice(0, config.limit);
    }

    if (!raw.length) throw new AppError('PARSER_NO_DATA', 'LinkedIn loaded, but no conversations could be read. Selectors or response formats may have changed.', 4);
    const messages = raw.flatMap((c) => c.messages ?? []);
    if (!reliableSelfId && messages.some((message) => !message.direction)) {
      throw new AppError('VALIDATION_FAILED', 'A stable account identity was unavailable, so message direction cannot be determined safely.', 4);
    }
    const incomplete = raw.some((conversation) => !(conversation.messages?.length));
    const listCoverageComplete = raw.length >= config.limit || domList.complete;
    const passiveHistoryComplete = raw.length > 0 && raw.every((conversation) => conversation.sourceMetadata?.historyComplete === true);
    const historyCoverageComplete = config.allowThreadOpen ? threadCoverageComplete : passiveHistoryComplete;
    const partial = coverageIsPartial({ incomplete, listCoverageComplete, historyCoverageComplete, parserMisses: Number(manifest.counts.parserMisses ?? 0), warnings: manifest.warnings });
    if (Number(manifest.counts.parserMisses ?? 0) > 0) manifest.warnings.push('RELEVANT_NETWORK_EVENTS_SKIPPED');
    if (!config.allowThreadOpen && !passiveHistoryComplete) manifest.warnings.push('THREAD_HISTORY_NOT_CONFIRMED');
    if (!listCoverageComplete) manifest.warnings.push(`CONVERSATION_LIST_${domList.scrollReason.toUpperCase()}`);
    if (incomplete) manifest.warnings.push('CONVERSATIONS_WITHOUT_MESSAGES');
    const conversations = raw.map((conversation) => normalizeConversation(markSelf(conversation, reliableSelfId, account.profileUrl), reliableSelfId));
    const next = ExportSchema.parse({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      account,
      stats: {
        requestedConversationLimit: config.limit,
        exportedConversationCount: conversations.length,
        exportedMessageCount: conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0),
        partial,
        warnings: [...new Set(manifest.warnings)].sort(),
      },
      conversations,
    });
    if (config.diagnosticsContent) {
      logger.warn('content-diagnostics-enabled', { warning: 'Local screenshot and sanitized HTML may contain personal message content.' });
      await saveContentDiagnostics(page, config.diagnosticsDir, manifest.runId);
    }
    const persisted = await persistExportResult(config.outputPath, next);
    const merged = persisted.data;
    manifest.status = partial ? 'partial' : 'success';
    manifest.counts.conversations = merged.stats.exportedConversationCount;
    manifest.counts.messages = merged.stats.exportedMessageCount;
    logger.info(partial ? 'partial-candidate-written' : 'export-written', { output: persisted.destination, conversations: merged.stats.exportedConversationCount, messages: merged.stats.exportedMessageCount, partial });
    return merged;
  } catch (error) {
    manifest.status = error instanceof AppError ? error.code : 'FAILED';
    try {
      const saved = await saveContentDiagnosticsOnFailure(page, config.diagnosticsDir, manifest.runId, { enabled: config.diagnosticsContent, authenticated, ...(error instanceof AppError ? { errorCode: error.code } : {}) });
      if (saved) {
        manifest.warnings.push('CONTENT_DIAGNOSTICS_SAVED_AFTER_PARSER_NO_DATA');
        logger.warn('content-diagnostics-saved', { reason: 'PARSER_NO_DATA' });
      }
    } catch {
      manifest.warnings.push('CONTENT_DIAGNOSTICS_SAVE_FAILED');
    }
    throw error;
  } finally {
    capture.detach();
    manifest.finishedAt = new Date().toISOString();
    await closeContext(context);
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
}

export function coverageIsPartial(input: { incomplete: boolean; listCoverageComplete: boolean; historyCoverageComplete: boolean; parserMisses: number; warnings: string[] }): boolean {
  return input.incomplete || !input.listCoverageComplete || !input.historyCoverageComplete || input.parserMisses > 0 || input.warnings.some((warning) => warning.startsWith('DIRECTION_UNKNOWN') || warning.startsWith('THREAD_READ_FAILED') || warning === 'PAGINATION_READ_FAILED' || warning === 'PAGINATION_BUDGET_EXHAUSTED');
}

function rawKey(conversation: RawConversation): string {
  return conversation.id ?? conversation.entityUrn ?? conversation.url ?? sha256Id('conversation', [(conversation.participants ?? []).map((p) => p.id ?? p.profileUrl ?? p.name).sort()]);
}

function participantKey(participant: RawParticipant): string {
  return participant.id ?? participant.entityUrn ?? participant.profileUrl ?? sha256Id('member', [participant.name]);
}

function rawMessageAliases(message: RawMessage): Set<string> {
  const aliases = new Set<string>();
  if (message.id) aliases.add(`id:${message.id}`);
  const urn = normalizeUrn(message.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = messageIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  return aliases;
}

function messageFingerprintRaw(message: RawMessage): string { return sha256Id('message', [message.conversationId, message.senderId, normalizeTimestamp(message.sentAt), message.messageType, message.text, message.attachments]); }

function hasStableRawId(message: RawMessage): boolean { return Boolean(message.id || message.entityUrn); }

function sourcePage(message: RawMessage): string {
  const value = message.sourceMetadata?.sourcePage;
  return typeof value === 'string' && value ? value : 'unscoped';
}

export function mergeRawMessages(left: RawMessage[], right: RawMessage[]): RawMessage[] {
  const stable: Array<{ value: RawMessage; aliases: Set<string> }> = [];
  const addStable = (message: RawMessage) => {
    const aliases = rawMessageAliases(message);
    const matches = stable.map((entry, index) => intersectsAliases(entry.aliases, aliases) ? index : -1).filter((index) => index >= 0);
    if (!matches.length) { stable.push({ value: message, aliases }); return; }
    const target = stable[matches[0]!]!;
    target.value = definedMerge(target.value, message);
    aliases.forEach((alias) => target.aliases.add(alias));
    for (const index of matches.slice(1).sort((a, b) => b - a)) {
      const duplicate = stable[index]!;
      target.value = definedMerge(target.value, duplicate.value);
      duplicate.aliases.forEach((alias) => target.aliases.add(alias));
      stable.splice(index, 1);
    }
  };
  left.filter(hasStableRawId).forEach(addStable);
  right.filter(hasStableRawId).forEach(addStable);
  const groupFallback = (messages: RawMessage[]) => {
    const buckets = new Map<string, Map<string, RawMessage[]>>();
    for (const message of messages.filter((value) => !hasStableRawId(value))) {
      const key = messageFingerprintRaw(message);
      const pages = buckets.get(key) ?? new Map<string, RawMessage[]>();
      const bucket = pages.get(sourcePage(message)) ?? [];
      bucket.push(message);
      pages.set(sourcePage(message), bucket);
      buckets.set(key, pages);
    }
    return buckets;
  };
  const leftBuckets = groupFallback(left);
  const rightBuckets = groupFallback(right);
  const stableCounts = (messages: RawMessage[]) => {
    const counts = new Map<string, number>();
    for (const message of messages.filter(hasStableRawId)) {
      const key = `${messageFingerprintRaw(message)}:${sourcePage(message)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const leftStableCounts = stableCounts(left);
  const rightStableCounts = stableCounts(right);
  const fingerprints = new Set([...leftBuckets.keys(), ...rightBuckets.keys()]);
  const fallbackValues: RawMessage[] = [];
  for (const fingerprint of fingerprints) {
    const leftPages = leftBuckets.get(fingerprint) ?? new Map<string, RawMessage[]>();
    const rightPages = rightBuckets.get(fingerprint) ?? new Map<string, RawMessage[]>();
    for (const page of new Set([...leftPages.keys(), ...rightPages.keys()])) {
      const stableKey = `${fingerprint}:${page}`;
      const leftRemaining = (leftPages.get(page) ?? []).slice(rightStableCounts.get(stableKey) ?? 0);
      const rightRemaining = (rightPages.get(page) ?? []).slice(leftStableCounts.get(stableKey) ?? 0);
      const wanted = Math.max(leftRemaining.length, rightRemaining.length);
      for (let index = 0; index < wanted; index += 1) {
        const old = leftRemaining[index];
        const next = rightRemaining[index];
        fallbackValues.push(old && next ? definedMerge(old, next) : (next ?? old)!);
      }
    }
  }
  return [...stable.map((entry) => entry.value), ...fallbackValues];
}

export function coalesceRaw(input: RawConversation[]): RawConversation[] {
  const entries: Array<{ value: RawConversation; aliases: Set<string> }> = [];
  for (const conversation of input) {
    const aliases = rawConversationAliases(conversation);
    const index = entries.findIndex((entry) => intersectsAliases(entry.aliases, aliases));
    if (index < 0) { entries.push({ value: conversation, aliases }); continue; }
    const entry = entries[index]!;
    entry.value = mergeRawConversation(entry.value, conversation);
    aliases.forEach((alias) => entry.aliases.add(alias));
    rawConversationAliases(entry.value).forEach((alias) => entry.aliases.add(alias));
  }
  return entries.map((entry) => entry.value);
}

function intersectsAliases(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((alias) => right.has(alias));
}

function rawConversationAliases(conversation: RawConversation): Set<string> {
  const aliases = new Set<string>();
  if (conversation.id) aliases.add(`id:${conversation.id}`);
  const urn = normalizeUrn(conversation.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = conversationIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  const routeId = canonicalLinkedInUrl(conversation.url)?.match(/\/messaging\/thread\/([^/]+)/i)?.[1];
  if (routeId) aliases.add(`id:${decodeURIComponent(routeId)}`);
  if (!aliases.size) aliases.add(`fallback:${rawKey(conversation)}`);
  return aliases;
}

function strongParticipant(participant: RawParticipant): boolean {
  return Boolean(participant.id || participant.entityUrn || canonicalLinkedInUrl(participant.profileUrl)?.match(/\/in\/[^/]+$/i));
}

function rawParticipantAliases(participant: RawParticipant): Set<string> {
  const aliases = new Set<string>();
  if (participant.id) aliases.add(`id:${participant.id}`);
  const urn = normalizeUrn(participant.entityUrn);
  if (urn) aliases.add(`urn:${urn}`);
  const urnId = personIdFromUrn(urn);
  if (urnId) aliases.add(`id:${urnId}`);
  const profile = canonicalLinkedInUrl(participant.profileUrl)?.match(/^https:\/\/www\.linkedin\.com\/in\/([^/]+)$/i)?.[1];
  if (profile) aliases.add(`profile:${profile.toLowerCase()}`);
  if (!aliases.size) aliases.add(`fallback:${participantKey(participant)}`);
  return aliases;
}

function mergeRawParticipants(left: RawParticipant[], right: RawParticipant[]): RawParticipant[] {
  const authoritative = [...left, ...right].some(strongParticipant);
  const candidates = authoritative ? [...left, ...right].filter(strongParticipant) : [...left, ...right];
  const participants: Array<{ value: RawParticipant; aliases: Set<string> }> = [];
  for (const participant of candidates) {
    const aliases = rawParticipantAliases(participant);
    const matches = participants.map((entry, index) => intersectsAliases(entry.aliases, aliases) ? index : -1).filter((index) => index >= 0);
    if (!matches.length) { participants.push({ value: participant, aliases }); continue; }
    const target = participants[matches[0]!]!;
    target.value = definedMerge(target.value, participant);
    aliases.forEach((alias) => target.aliases.add(alias));
    for (const index of matches.slice(1).sort((a, b) => b - a)) {
      const duplicate = participants[index]!;
      target.value = definedMerge(target.value, duplicate.value);
      duplicate.aliases.forEach((alias) => target.aliases.add(alias));
      participants.splice(index, 1);
    }
  }
  return participants.map((entry) => entry.value);
}

function mergeRawConversation(old: RawConversation, next: RawConversation): RawConversation {
  return {
    ...definedMerge(old, next),
    participants: mergeRawParticipants(old.participants ?? [], next.participants ?? []),
    messages: mergeRawMessages(old.messages ?? [], next.messages ?? []),
    ...mergeHistoryMetadata(old.sourceMetadata, next.sourceMetadata),
  };
}

type HistoryEvidence = { resource: string; page: string; start: number; count: number; total?: number; end: boolean; valid: boolean };

function parseHistoryEvidence(value: unknown): HistoryEvidence[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as HistoryEvidence[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.resource === 'string' && typeof item.page === 'string' && Number.isFinite(item.start) && Number.isFinite(item.count)) : [];
  } catch { return []; }
}

function completeEvidence(evidence: HistoryEvidence[]): boolean {
  if (!evidence.length || evidence.some((item) => !item.valid)) return false;
  const resources = new Map<string, HistoryEvidence[]>();
  for (const item of evidence) {
    const pages = resources.get(item.resource) ?? [];
    pages.push(item);
    resources.set(item.resource, pages);
  }
  return [...resources.values()].some((pages) => {
    const sorted = [...pages].sort((a, b) => a.start - b.start || a.count - b.count);
    if (sorted[0]?.start !== 0) return false;
    const totals = new Set(sorted.map((item) => item.total).filter((value): value is number => value !== undefined));
    if (totals.size > 1) return false;
    let coveredUntil = 0;
    let observedEnd = false;
    for (const page of sorted) {
      if (page.start > coveredUntil) return false;
      coveredUntil = Math.max(coveredUntil, page.start + page.count);
      if (page.end) observedEnd = true;
    }
    const total = [...totals][0];
    return observedEnd && (total === undefined || coveredUntil >= total);
  });
}

function mergeHistoryMetadata(old: RawConversation['sourceMetadata'], next: RawConversation['sourceMetadata']): Pick<RawConversation, 'sourceMetadata'> | Record<string, never> {
  if (!old && !next) return {};
  const evidenceByPage = new Map<string, HistoryEvidence>();
  for (const item of [...parseHistoryEvidence(old?.historyEvidence), ...parseHistoryEvidence(next?.historyEvidence)]) {
    const key = `${item.resource}:${item.page}`;
    const prior = evidenceByPage.get(key);
    evidenceByPage.set(key, prior ? { ...prior, ...item, valid: prior.valid && item.valid, end: prior.end || item.end } : item);
  }
  const evidence = [...evidenceByPage.values()];
  const misses = evidence.filter((item) => !item.valid).length || Math.max(Number(old?.parserMisses ?? 0), Number(next?.parserMisses ?? 0));
  const historyComplete = evidence.length ? completeEvidence(evidence) : old?.historyComplete === true || next?.historyComplete === true;
  return {
    sourceMetadata: {
      ...old,
      ...next,
      ...(evidence.length ? { historyEvidence: JSON.stringify(evidence) } : {}),
      ...(misses ? { parserMisses: misses } : {}),
      historyComplete: historyComplete && misses === 0,
    },
  };
}

function definedMerge<T extends object>(old: T, next: Partial<T>): T {
  return { ...old, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== '')) } as T;
}

function markSelf(conversation: RawConversation, selfId: string | undefined, selfProfileUrl: string | undefined): RawConversation {
  return {
    ...conversation,
    participants: (conversation.participants ?? []).map((participant) => ({
      ...participant,
      isSelf: Boolean((selfId && (participant.id === selfId || participant.entityUrn?.endsWith(`:${selfId}`))) || (selfProfileUrl && participant.profileUrl === selfProfileUrl)),
    })),
  };
}
