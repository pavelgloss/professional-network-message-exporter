import type { APIRequestContext } from 'playwright';
import type { RawConversation } from '../domain/schema.js';
import { conversationIdFromUrn } from '../domain/stable-id.js';
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
