import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { createManifest, saveContentDiagnostics, saveManifest } from '../io/diagnostics.js';
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
import { normalizeConversation, normalizeTimestamp } from '../domain/normalize.js';
import { personIdFromUrn, sha256Id } from '../domain/stable-id.js';
import { ExportSchema, type LinkedInExport, type RawConversation, type RawMessage, type RawParticipant } from '../domain/schema.js';

export async function exportMessages(config: AppConfig, logger: Logger): Promise<LinkedInExport> {
  const manifest = createManifest();
  const context = await launchContext(config, 'export', manifest, logger);
  let page = context.pages()[0] ?? await context.newPage();
  const capture = attachNetworkCapture(page, manifest, logger);
  try {
    logger.info('export-started', { limit: config.limit, threadOpen: config.allowThreadOpen });
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    assertAuthenticated(await detectAuthState(page));
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
    const partial = incomplete || !listCoverageComplete || !historyCoverageComplete || manifest.warnings.some((warning) => warning.startsWith('DIRECTION_UNKNOWN') || warning.startsWith('THREAD_READ_FAILED') || warning === 'PAGINATION_READ_FAILED' || warning === 'PAGINATION_BUDGET_EXHAUSTED');
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
    throw error;
  } finally {
    capture.detach();
    manifest.finishedAt = new Date().toISOString();
    await closeContext(context);
    await saveManifest(config.diagnosticsDir, manifest).catch(() => undefined);
  }
}

function rawKey(conversation: RawConversation): string {
  return conversation.id ?? conversation.entityUrn ?? conversation.url ?? sha256Id('conversation', [(conversation.participants ?? []).map((p) => p.id ?? p.profileUrl ?? p.name).sort()]);
}

function participantKey(participant: RawParticipant): string {
  return participant.id ?? participant.entityUrn ?? participant.profileUrl ?? sha256Id('member', [participant.name]);
}

function messageKey(message: RawMessage): string {
  return message.id ?? message.entityUrn ?? messageFingerprintRaw(message);
}

function messageFingerprintRaw(message: RawMessage): string { return sha256Id('message', [message.conversationId, message.senderId, normalizeTimestamp(message.sentAt), message.messageType, message.text, message.attachments]); }

function hasStableRawId(message: RawMessage): boolean { return Boolean(message.id || message.entityUrn); }

export function mergeRawMessages(left: RawMessage[], right: RawMessage[]): RawMessage[] {
  const stable = new Map<string, RawMessage>();
  const addStable = (message: RawMessage) => {
    const aliases = [message.id, message.entityUrn].filter((value): value is string => Boolean(value));
    const priorKey = [...stable.keys()].find((key) => aliases.includes(key));
    const key = priorKey ?? aliases[0]!;
    stable.set(key, stable.has(key) ? definedMerge(stable.get(key)!, message) : message);
  };
  left.filter(hasStableRawId).forEach(addStable);
  right.filter(hasStableRawId).forEach(addStable);
  const stableValues = [...stable.values()];
  const group = (messages: RawMessage[]) => {
    const buckets = new Map<string, RawMessage[]>();
    for (const message of messages.filter((value) => !hasStableRawId(value))) {
      const key = messageKey(message);
      const bucket = buckets.get(key) ?? [];
      bucket.push(message);
      buckets.set(key, bucket);
    }
    return buckets;
  };
  const leftBuckets = group(left);
  const rightBuckets = group(right);
  const stableCounts = (messages: RawMessage[]) => {
    const counts = new Map<string, number>();
    for (const message of messages.filter(hasStableRawId)) counts.set(messageFingerprintRaw(message), (counts.get(messageFingerprintRaw(message)) ?? 0) + 1);
    return counts;
  };
  const leftStableCounts = stableCounts(left);
  const rightStableCounts = stableCounts(right);
  const fingerprints = new Set([...leftBuckets.keys(), ...rightBuckets.keys()]);
  const fallbackValues: RawMessage[] = [];
  for (const fingerprint of fingerprints) {
    const leftBucket = leftBuckets.get(fingerprint) ?? [];
    const rightBucket = rightBuckets.get(fingerprint) ?? [];
    const leftRemaining = leftBucket.slice(rightStableCounts.get(fingerprint) ?? 0);
    const rightRemaining = rightBucket.slice(leftStableCounts.get(fingerprint) ?? 0);
    const wanted = Math.max(leftRemaining.length, rightRemaining.length);
    for (let index = 0; index < wanted; index += 1) {
      const old = leftRemaining[index];
      const next = rightRemaining[index];
      if (old && next) fallbackValues.push(definedMerge(old, next));
      else fallbackValues.push((next ?? old)!);
    }
  }
  return [...stableValues, ...fallbackValues];
}

export function coalesceRaw(input: RawConversation[]): RawConversation[] {
  const map = new Map<string, RawConversation>();
  for (const conversation of input) {
    const key = rawKey(conversation);
    const prior = map.get(key);
    if (!prior) { map.set(key, conversation); continue; }
    const participants = new Map((prior.participants ?? []).map((participant) => [participantKey(participant), participant]));
    for (const participant of conversation.participants ?? []) {
      const pKey = participantKey(participant);
      participants.set(pKey, definedMerge(participants.get(pKey) ?? {}, participant));
    }
    map.set(key, {
      ...definedMerge(prior, conversation),
      participants: [...participants.values()],
      messages: mergeRawMessages(prior.messages ?? [], conversation.messages ?? []),
    });
  }
  return [...map.values()];
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
