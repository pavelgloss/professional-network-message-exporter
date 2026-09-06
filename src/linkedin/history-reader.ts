import type { APIRequestContext } from 'playwright';
import type { RawConversation } from '../domain/schema.js';
import { conversationIdFromUrn, sha256Id } from '../domain/stable-id.js';
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
  let output = templateUrl;
  let replacements = 0;
  // Preserve LinkedIn's exact nested Rest.li/percent encoding. Rebuilding the
  // query with URLSearchParams changes that encoding even when its decoded
  // meaning is the same, and the persisted endpoint rejects the rewritten URL.
  for (const oldId of oldIds) {
    const oldForms = encodedForms(oldId);
    const newForms = encodedForms(newTargetId);
    const replacementsByDepth = oldForms.map((oldForm, index) => ({ oldForm, newForm: newForms[index]! }))
      .sort((left, right) => right.oldForm.length - left.oldForm.length);
    for (const { oldForm, newForm } of replacementsByDepth) {
      const before = output;
      output = output.split(oldForm).join(newForm);
      if (output !== before) replacements += 1;
    }
  }
  if (!replacements && !oldIds.includes(newTargetId)) {
    throw new AppError('READ_POLICY_BLOCK', 'Observed history GET identity could not be rebound', 4);
  }
  const result = output;
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

function isUnpaginatedFullCollection(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!/^messengerMessages\.[A-Fa-f0-9]{32,128}$/.test(url.searchParams.get('queryId') ?? '')) return false;
    const variables = repeatedlyDecodeAndNormalize(url.searchParams.get('variables') ?? '') ?? '';
    return !/(?:^|[({,])\s*(?:cursor|start|count|anchor|before|after|first|last|paginationToken)\s*:/i.test(variables);
  } catch { return false; }
}

function markCompleteUnpaginatedCollection(conversation: RawConversation, sourceUrl: string): RawConversation {
  const count = conversation.messages?.length ?? 0;
  const page = sha256Id('network-page', [sourceUrl]);
  const evidence = [{
    resource: sha256Id('history-resource', [sourceUrl]),
    page,
    start: 0,
    count,
    total: count,
    end: true,
    valid: true,
  }];
  return {
    ...conversation,
    sourceMetadata: {
      ...conversation.sourceMetadata,
      historyEvidence: JSON.stringify(evidence),
      historyComplete: true,
    },
  };
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
        const parsed = parseNetworkPayload(payload, url, { observedMethod: 'GET' });
        manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
        let matching = parsed.conversations.filter((value) => exactConversationId(value) === targetId);
        const foreignMessages = parsed.conversations.some((value) => exactConversationId(value) !== targetId
          && (value.messages?.length ?? 0) > 0);
        if (foreignMessages || !matching.length) throw new Error('history response identity mismatch');
        if (parsed.misses === 0 && parsed.paginationUrls.length === 0 && isUnpaginatedFullCollection(url)) {
          matching = matching.map((value) => markCompleteUnpaginatedCollection(value, url));
        }
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
