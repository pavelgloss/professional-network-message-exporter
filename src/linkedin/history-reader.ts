import type { APIRequestContext } from 'playwright';
import type { RawConversation } from '../domain/schema.js';
import { conversationIdFromUrn } from '../domain/stable-id.js';
import { repeatedlyDecodeAndNormalize } from '../domain/url-safety.js';
import { AppError } from '../errors.js';
import type { DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import type { ObservedHistoryGet } from './probe.js';
import { probeMessagingRequestPolicy } from './probe-request-policy.js';
import { parseNetworkPayload } from './network/response-parser.js';
import { assertAllowedReadUrl, readJson } from './network/read-client.js';

const SAFE_ID = /^(?:[\p{L}\p{N}_.-]+|[A-Za-z0-9._~=-]+)$/u;
const MAX_HISTORY_PAGES_PER_CONVERSATION = 250;

function exactConversationId(conversation: RawConversation): string | undefined {
  const values = new Set([
    conversation.id,
    conversationIdFromUrn(conversation.entityUrn),
  ].filter((value): value is string => Boolean(value && SAFE_ID.test(value))));
  return values.size === 1 ? [...values][0] : undefined;
}

function encodedForms(value: string): string[] {
  const forms = [value];
  for (let index = 0; index < 4; index += 1) forms.push(encodeURIComponent(forms.at(-1)!));
  return [...new Set(forms)];
}

type RawReplacement = { start: number; length: number; value: string };

function replaceAt(value: string, start: number, length: number, replacement: string): string {
  return `${value.slice(0, start)}${replacement}${value.slice(start + length)}`;
}

function identityReplacements(templateUrl: string, oldIds: string[], newTargetId: string): RawReplacement[] {
  const queryStart = templateUrl.indexOf('?');
  if (queryStart < 0) return [];
  const rawQuery = templateUrl.slice(queryStart + 1);
  // The padding keeps a distinct representation at every encoding depth, so a
  // candidate occurrence can be tested without changing its surrounding bytes.
  const sentinel = 'LINKEDIN_READER_REBIND_SENTINEL_7f4ca8d2==';
  if (oldIds.includes(sentinel) || newTargetId === sentinel) {
    throw new AppError('READ_POLICY_BLOCK', 'Observed history GET used a reserved identity', 4);
  }
  const replacements: RawReplacement[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  for (const oldId of oldIds) {
    const oldForms = encodedForms(oldId);
    const newForms = encodedForms(newTargetId);
    const sentinelForms = encodedForms(sentinel);
    const forms = oldForms.map((oldForm, depth) => ({ oldForm, newForm: newForms[depth]!, sentinelForm: sentinelForms[depth]! }))
      .sort((left, right) => right.oldForm.length - left.oldForm.length);
    for (const { oldForm, newForm, sentinelForm } of forms) {
      let offset = 0;
      while (offset <= rawQuery.length - oldForm.length) {
        const relative = rawQuery.indexOf(oldForm, offset);
        if (relative < 0) break;
        const absolute = queryStart + 1 + relative;
        offset = relative + Math.max(1, oldForm.length);
        if (occupied.some((range) => absolute < range.end && absolute + oldForm.length > range.start)) continue;
        // Replace just this occurrence with a recognizable safe sentinel. The
        // policy parser tells us whether that byte range is an actual semantic
        // conversation reference. Tracking values and persisted query hashes
        // never surface as referencedIds and therefore remain byte-identical.
        const candidate = replaceAt(templateUrl, absolute, oldForm.length, sentinelForm);
        const decision = probeMessagingRequestPolicy('target', 'GET', candidate, 'https://www.linkedin.com', new Set([...oldIds, sentinel]));
        if (!decision.referencedIds.has(sentinel)) continue;
        replacements.push({ start: absolute, length: oldForm.length, value: newForm });
        occupied.push({ start: absolute, end: absolute + oldForm.length });
      }
    }
  }
  return replacements;
}

/**
 * Rebinds only the conversation identity in an observed, already validated GET.
 * The resulting request must independently pass the same exact target policy.
 */
export function instantiateObservedHistoryUrl(templateUrl: string, oldTargetIds: Iterable<string>, newTargetId: string): string {
  if (!SAFE_ID.test(newTargetId)) throw new AppError('READ_POLICY_BLOCK', 'Conversation identity was not safe for history retrieval', 4);
  const oldIds = [...new Set(oldTargetIds)].filter((value) => SAFE_ID.test(value));
  if (!oldIds.length) throw new AppError('READ_POLICY_BLOCK', 'Observed history GET had no safe target identity', 4);
  const oldDecision = probeMessagingRequestPolicy('target', 'GET', templateUrl, 'https://www.linkedin.com', new Set(oldIds));
  if (!oldDecision.allow || oldDecision.kind !== 'conversation-history') {
    throw new AppError('READ_POLICY_BLOCK', 'Observed history GET no longer passed the exact read policy', 4);
  }

  assertAllowedReadUrl(templateUrl);
  const replacements = identityReplacements(templateUrl, oldIds, newTargetId);
  if (!replacements.length && !oldIds.includes(newTargetId)) {
    throw new AppError('READ_POLICY_BLOCK', 'Observed history GET identity could not be rebound', 4);
  }
  const result = [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce((value, replacement) => replaceAt(value, replacement.start, replacement.length, replacement.value), templateUrl);
  const decision = probeMessagingRequestPolicy('target', 'GET', result, 'https://www.linkedin.com', new Set([newTargetId]));
  if (!decision.allow || decision.kind !== 'conversation-history' || decision.referencedIds.size !== 1
    || !decision.referencedIds.has(newTargetId)) {
    throw new AppError('READ_POLICY_BLOCK', 'Rebound history GET did not reference exactly one target', 4);
  }
  return assertAllowedReadUrl(result).toString();
}

function exactHistoryPage(rawUrl: string, targetId: string): string {
  const url = assertAllowedReadUrl(rawUrl).toString();
  const decision = probeMessagingRequestPolicy('target', 'GET', url, 'https://www.linkedin.com', new Set([targetId]));
  if (!decision.allow || decision.kind !== 'conversation-history' || decision.referencedIds.size !== 1
    || !decision.referencedIds.has(targetId)) {
    throw new AppError('READ_POLICY_BLOCK', 'Observed history pagination escaped its exact conversation', 4);
  }
  return url;
}

type CurrentHistoryCollection = {
  elements: unknown[];
  newSyncToken?: string;
  shouldClearCache?: boolean;
};

function currentHistoryCollection(payload: unknown): CurrentHistoryCollection | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) return undefined;
  const collections = Object.values(root.data as Record<string, unknown>).filter((candidate): candidate is Record<string, unknown> =>
    Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray((candidate as Record<string, unknown>).elements)));
  if (collections.length !== 1) return undefined;
  const collection = collections[0]!;
  const metadata = collection.metadata && typeof collection.metadata === 'object' && !Array.isArray(collection.metadata)
    ? collection.metadata as Record<string, unknown> : undefined;
  const rawToken = metadata?.newSyncToken;
  const newSyncToken = typeof rawToken === 'string' && rawToken.length <= 64 * 1024
    ? repeatedlyDecodeAndNormalize(rawToken) : undefined;
  return {
    elements: collection.elements as unknown[],
    ...(newSyncToken ? { newSyncToken } : {}),
    ...(typeof metadata?.shouldClearCache === 'boolean' ? { shouldClearCache: metadata.shouldClearCache } : {}),
  };
}

/** Adds the observed response token without rebuilding any existing query bytes. */
export function instantiateObservedSyncUrl(sourceUrl: string, targetId: string, syncToken: string): string {
  const initial = exactHistoryPage(sourceUrl, targetId);
  const normalizedToken = repeatedlyDecodeAndNormalize(syncToken);
  if (!normalizedToken || normalizedToken.length > 64 * 1024) {
    throw new AppError('READ_POLICY_BLOCK', 'History sync token was malformed', 4);
  }
  const queryStart = initial.indexOf('?');
  if (queryStart < 0) throw new AppError('READ_POLICY_BLOCK', 'History GET had no variables query', 4);
  const hashStart = initial.indexOf('#', queryStart);
  const queryEnd = hashStart < 0 ? initial.length : hashStart;
  const query = initial.slice(queryStart + 1, queryEnd);
  const segments = query.split('&');
  let changed = false;
  const nextSegments = segments.map((segment) => {
    const equals = segment.indexOf('=');
    if (equals < 0) return segment;
    let name: string;
    try { name = decodeURIComponent(segment.slice(0, equals)); } catch { return segment; }
    if (name !== 'variables') return segment;
    if (changed) throw new AppError('READ_POLICY_BLOCK', 'History GET had duplicate variables', 4);
    const rawVariables = segment.slice(equals + 1);
    if (!rawVariables.startsWith('(') || !rawVariables.endsWith(')') || /(?:^|[,(])syncToken:/i.test(rawVariables)) {
      throw new AppError('READ_POLICY_BLOCK', 'History GET did not use the observed Rest.li variable shape', 4);
    }
    changed = true;
    return `${segment.slice(0, equals + 1)}${rawVariables.slice(0, -1)},syncToken:${encodeURIComponent(normalizedToken)})`;
  });
  if (!changed) throw new AppError('READ_POLICY_BLOCK', 'History GET had no variables query', 4);
  return exactHistoryPage(`${initial.slice(0, queryStart + 1)}${nextSegments.join('&')}${initial.slice(queryEnd)}`, targetId);
}

function messageAliases(conversations: RawConversation[]): Set<string> {
  const aliases = new Set<string>();
  for (const message of conversations.flatMap((conversation) => conversation.messages ?? [])) {
    if (message.entityUrn) aliases.add(`urn:${message.entityUrn}`);
    if (message.id) aliases.add(`id:${message.id}`);
  }
  return aliases;
}

function safeSchemaKey(value: string): string | undefined {
  return /^[A-Za-z_$*][A-Za-z0-9_$*-]{0,80}$/.test(value) ? value : undefined;
}

/** Structural diagnostics only: schema field names, primitive types and array lengths. */
export function historyCollectionContractShapes(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown> : undefined;
  if (!data) return [];
  const shapes = new Set<string>();
  for (const candidate of Object.values(data)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const collection = candidate as Record<string, unknown>;
    if (!Array.isArray(collection.elements)) continue;
    const describe = (key: string, value: unknown): string | undefined => {
      const safeKey = safeSchemaKey(key);
      if (!safeKey) return undefined;
      if (Array.isArray(value)) return `${safeKey}:array(${value.length})`;
      if (value === null) return `${safeKey}:null`;
      if (typeof value === 'boolean' || typeof value === 'number') return `${safeKey}:${typeof value}(${String(value)})`;
      if (typeof value === 'string') return `${safeKey}:string`;
      return value && typeof value === 'object' ? `${safeKey}:object` : `${safeKey}:${typeof value}`;
    };
    const top = Object.entries(collection).map(([key, value]) => describe(key, value)).filter((value): value is string => Boolean(value)).sort();
    shapes.add(`collection[${top.join(',')}]`);
    for (const [parentKey, child] of Object.entries(collection)) {
      const safeParent = safeSchemaKey(parentKey);
      if (!safeParent || !child || typeof child !== 'object' || Array.isArray(child)) continue;
      const nested = Object.entries(child as Record<string, unknown>)
        .map(([key, value]) => describe(key, value)).filter((value): value is string => Boolean(value)).sort();
      shapes.add(`${safeParent}[${nested.join(',')}]`);
    }
  }
  return [...shapes].sort();
}

export async function readObservedConversationHistories(
  request: APIRequestContext,
  observed: ObservedHistoryGet,
  conversations: RawConversation[],
  manifest: DiagnosticsManifest,
  logger: Logger,
): Promise<RawConversation[]> {
  const output: RawConversation[] = [];
  let completed = 0;
  let failed = 0;
  let pages = 0;
  let syncContractProbed = false;

  for (const conversation of conversations) {
    const targetId = exactConversationId(conversation);
    if (!targetId) {
      failed += 1;
      manifest.warnings.push('THREAD_READ_FAILED_IDENTITY');
      continue;
    }
    let initial: string;
    try {
      initial = instantiateObservedHistoryUrl(observed.url, observed.targetIds, targetId);
    } catch {
      failed += 1;
      manifest.warnings.push('THREAD_READ_FAILED_POLICY');
      continue;
    }
    const queue = [initial];
    const visited = new Set<string>();
    let threadFailed = false;
    let sawConversation = false;
    while (queue.length && visited.size < MAX_HISTORY_PAGES_PER_CONVERSATION) {
      let url: string;
      try { url = exactHistoryPage(queue.shift()!, targetId); }
      catch {
        threadFailed = true;
        manifest.warnings.push('THREAD_READ_FAILED_PAGINATION_POLICY');
        break;
      }
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        const payload = await readJson(request, url);
        for (const shape of historyCollectionContractShapes(payload)) {
          const strategy = `history-contract:${shape}`;
          if (!manifest.strategies.includes(strategy) && manifest.strategies.filter((value) => value.startsWith('history-contract:')).length < 12) {
            manifest.strategies.push(strategy);
          }
        }
        const parsed = parseNetworkPayload(payload, url, { observedMethod: 'GET' });
        manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
        const matching = parsed.conversations.filter((value) => exactConversationId(value) === targetId);
        const foreignMessages = parsed.conversations.some((value) => exactConversationId(value) !== targetId
          && (value.messages?.length ?? 0) > 0);
        if (foreignMessages || !matching.length) throw new Error('history response identity mismatch');
        sawConversation = true;
        output.push(...matching);
        const collection = currentHistoryCollection(payload);
        if (!syncContractProbed && collection?.elements.length === 20 && collection.newSyncToken) {
          syncContractProbed = true;
          manifest.counts.historySyncContractProbes = 1;
          try {
            const syncUrl = instantiateObservedSyncUrl(url, targetId, collection.newSyncToken);
            const syncPayload = await readJson(request, syncUrl);
            const syncCollection = currentHistoryCollection(syncPayload);
            const syncParsed = parseNetworkPayload(syncPayload, syncUrl, { observedMethod: 'GET' });
            const syncMatching = syncParsed.conversations.filter((value) => exactConversationId(value) === targetId);
            const foreignSyncMessages = syncParsed.conversations.some((value) => exactConversationId(value) !== targetId
              && (value.messages?.length ?? 0) > 0);
            if (foreignSyncMessages) throw new Error('sync response identity mismatch');
            const initialAliases = messageAliases(matching);
            const distinctAliases = [...messageAliases(syncMatching)].filter((alias) => !initialAliases.has(alias));
            manifest.counts.historySyncContractElements = syncCollection?.elements.length ?? 0;
            manifest.counts.historySyncContractParsedMessages = syncMatching.reduce((sum, value) => sum + (value.messages?.length ?? 0), 0);
            manifest.counts.historySyncContractDistinctAliases = distinctAliases.length;
            manifest.counts.historySyncContractShouldClearCache = syncCollection?.shouldClearCache === true ? 1 : 0;
            manifest.counts.historySyncContractTokenChanged = syncCollection?.newSyncToken && syncCollection.newSyncToken !== collection.newSyncToken ? 1 : 0;
          } catch {
            manifest.warnings.push('HISTORY_SYNC_CONTRACT_PROBE_FAILED');
          }
        }
        for (const next of parsed.paginationUrls) {
          const safeNext = exactHistoryPage(next, targetId);
          if (!visited.has(safeNext)) queue.push(safeNext);
        }
        pages += 1;
      } catch {
        threadFailed = true;
        manifest.warnings.push('THREAD_READ_FAILED');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
    }
    if (queue.length) {
      threadFailed = true;
      manifest.warnings.push('THREAD_HISTORY_PAGE_BUDGET_EXHAUSTED');
    }
    if (!threadFailed && sawConversation) completed += 1;
    else failed += 1;
    if ((completed + failed) % 10 === 0 || completed + failed === conversations.length) {
      logger.info('history-read-progress', { processed: completed + failed, total: conversations.length, failed, pages });
    }
  }

  manifest.counts.historyConversationsRequested = conversations.length;
  manifest.counts.historyConversationsRead = completed;
  manifest.counts.historyConversationsFailed = failed;
  manifest.counts.historyPages = pages;
  return output;
}
