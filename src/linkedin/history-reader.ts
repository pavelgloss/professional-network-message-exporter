import type { APIRequestContext } from 'playwright';
import type { RawConversation, RawMessage } from '../domain/schema.js';
import { conversationIdFromUrn, sha256Id } from '../domain/stable-id.js';
import { canonicalUrlView } from '../domain/url-safety.js';
import { AppError } from '../errors.js';
import { jsonStructuralSignature, type DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import type { ObservedHistoryGet } from './probe.js';
import { probeMessagingRequestPolicy, restLiFields } from './probe-request-policy.js';
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
  return { elements: collection.elements as unknown[] };
}

function recordMissElementContracts(payload: unknown, manifest: DiagnosticsManifest): void {
  const collection = currentHistoryCollection(payload);
  if (!collection) return;
  const shapes = new Set(collection.elements.map((element) => {
    const signature = jsonStructuralSignature(element, 5, 100, 40);
    const arrays = signature.arrays.map(({ path, count }) => `${path}(${count})`).join(',');
    return `history-event-contract:paths=${signature.keyPaths.join(',')};arrays=${arrays};truncated=${signature.truncated}`;
  }));
  for (const shape of shapes) {
    if (manifest.strategies.filter((value) => value.startsWith('history-event-contract:')).length >= 12) break;
    if (!manifest.strategies.includes(shape)) manifest.strategies.push(shape);
  }
}

type AnchoredHistoryContract = { deliveredAt: number; countBefore: number };

function anchoredHistoryContract(rawUrl: string, targetId: string): AnchoredHistoryContract | undefined {
  let url: string;
  try { url = exactHistoryPage(rawUrl, targetId); } catch { return undefined; }
  const canonical = canonicalUrlView(url);
  const operation = canonical?.query.filter(({ name }) => name === 'queryId').map(({ value }) => value);
  const variables = canonical?.query.filter(({ name }) => name === 'variables').map(({ value }) => value);
  if (!canonical || operation?.length !== 1 || !/^messengerMessages\.[A-Fa-f0-9]{32,128}$/.test(operation[0]!)
    || variables?.length !== 1) return undefined;
  const fields = restLiFields(variables[0]!);
  const one = (name: string) => {
    const matches = fields.filter(({ key }) => key === name);
    return matches.length === 1 ? matches[0]?.value : undefined;
  };
  const deliveredAt = one('deliveredAt');
  const conversationUrn = one('conversationUrn');
  const countBeforeValue = one('countBefore');
  const countAfter = one('countAfter');
  if (!deliveredAt || !/^\d{10,17}$/.test(deliveredAt) || !conversationUrn
    || conversationIdFromUrn(conversationUrn) !== targetId || countAfter !== '0'
    || !countBeforeValue || !/^\d{1,3}$/.test(countBeforeValue)) return undefined;
  const countBefore = Number(countBeforeValue);
  const numericDeliveredAt = Number(deliveredAt);
  return Number.isSafeInteger(numericDeliveredAt) && Number.isInteger(countBefore) && countBefore > 0 && countBefore <= 100
    ? { deliveredAt: numericDeliveredAt, countBefore } : undefined;
}

export function instantiateObservedAnchoredHistoryUrl(
  templateUrl: string,
  oldTargetIds: Iterable<string>,
  newTargetId: string,
  deliveredAt: number,
): string {
  if (!Number.isSafeInteger(deliveredAt) || deliveredAt <= 0) {
    throw new AppError('READ_POLICY_BLOCK', 'History delivery anchor was malformed', 4);
  }
  const rebound = instantiateObservedHistoryUrl(templateUrl, oldTargetIds, newTargetId);
  const contract = anchoredHistoryContract(rebound, newTargetId);
  if (!contract) throw new AppError('READ_POLICY_BLOCK', 'Observed anchored history contract was malformed', 4);
  const oldAnchor = String(contract.deliveredAt);
  const candidates: string[] = [];
  let offset = 0;
  while (offset <= rebound.length - oldAnchor.length) {
    const index = rebound.indexOf(oldAnchor, offset);
    if (index < 0) break;
    offset = index + oldAnchor.length;
    const candidate = replaceAt(rebound, index, oldAnchor.length, String(deliveredAt));
    const nextContract = anchoredHistoryContract(candidate, newTargetId);
    if (nextContract?.deliveredAt === deliveredAt) candidates.push(candidate);
  }
  if (candidates.length !== 1) throw new AppError('READ_POLICY_BLOCK', 'Observed anchored history contract was malformed', 4);
  return exactHistoryPage(candidates[0]!, newTargetId);
}

/**
 * Derives the already live-validated older-page contract from this run's exact
 * initial request without rebuilding or re-encoding any existing query bytes.
 */
export function deriveObservedAnchoredHistoryUrl(
  initialUrl: string,
  targetId: string,
  deliveredAt: number,
  countBefore = 20,
): string {
  if (!Number.isSafeInteger(deliveredAt) || deliveredAt <= 0
    || !Number.isInteger(countBefore) || countBefore <= 0 || countBefore > 100) {
    throw new AppError('READ_POLICY_BLOCK', 'Derived history anchor was malformed', 4);
  }
  const initial = exactHistoryPage(initialUrl, targetId);
  const canonical = canonicalUrlView(initial);
  const operation = canonical?.query.filter(({ name }) => name === 'queryId').map(({ value }) => value);
  const variables = canonical?.query.filter(({ name }) => name === 'variables').map(({ value }) => value);
  if (!canonical || operation?.length !== 1 || !/^messengerMessages\.[A-Fa-f0-9]{32,128}$/.test(operation[0]!)
    || variables?.length !== 1) {
    throw new AppError('READ_POLICY_BLOCK', 'Initial history GET could not derive the anchored contract', 4);
  }
  const fields = restLiFields(variables[0]!);
  const conversationFields = fields.filter(({ key }) => key === 'conversationUrn');
  if (conversationFields.length !== 1 || conversationIdFromUrn(conversationFields[0]?.value) !== targetId
    || fields.some(({ key }) => ['deliveredAt', 'countBefore', 'countAfter'].includes(key))) {
    throw new AppError('READ_POLICY_BLOCK', 'Initial history variables were not the exact derivation source', 4);
  }

  const queryStart = initial.indexOf('?');
  const fragmentStart = initial.indexOf('#', queryStart);
  const queryEnd = fragmentStart < 0 ? initial.length : fragmentStart;
  const segments = initial.slice(queryStart + 1, queryEnd).split('&');
  let changed = false;
  const nextSegments = segments.map((segment) => {
    const equals = segment.indexOf('=');
    if (equals < 0) return segment;
    let name: string;
    try { name = decodeURIComponent(segment.slice(0, equals)); } catch { return segment; }
    if (name !== 'variables') return segment;
    if (changed) throw new AppError('READ_POLICY_BLOCK', 'Initial history GET had duplicate variables', 4);
    const rawVariables = segment.slice(equals + 1);
    if (!rawVariables.startsWith('(') || !rawVariables.endsWith(')') || rawVariables.length < 3) {
      throw new AppError('READ_POLICY_BLOCK', 'Initial history variables could not be preserved byte-for-byte', 4);
    }
    changed = true;
    return `${segment.slice(0, equals + 1)}(deliveredAt:${deliveredAt},${rawVariables.slice(1, -1)},countBefore:${countBefore},countAfter:0)`;
  });
  if (!changed) throw new AppError('READ_POLICY_BLOCK', 'Initial history GET had no variables', 4);
  const candidate = `${initial.slice(0, queryStart + 1)}${nextSegments.join('&')}${initial.slice(queryEnd)}`;
  const contract = anchoredHistoryContract(candidate, targetId);
  if (contract?.deliveredAt !== deliveredAt || contract.countBefore !== countBefore) {
    throw new AppError('READ_POLICY_BLOCK', 'Derived anchored history contract failed validation', 4);
  }
  return exactHistoryPage(candidate, targetId);
}

function historyMessageKey(message: RawMessage): string {
  if (message.entityUrn) return `urn:${message.entityUrn}`;
  if (message.id) return `id:${message.id}`;
  return sha256Id('history-message', [message.conversationId, message.senderId, message.sentAt, message.messageType, message.text, message.attachments]);
}

function oldestDeliveryAnchor(conversations: RawConversation[]): number | undefined {
  const values = conversations.flatMap((conversation) => conversation.messages ?? []).flatMap((message) => {
    if (typeof message.sentAt === 'number' && Number.isSafeInteger(message.sentAt) && message.sentAt > 0) return [message.sentAt];
    if (typeof message.sentAt !== 'string') return [];
    const numeric = /^\d{10,17}$/.test(message.sentAt) ? Number(message.sentAt) : Number.NaN;
    const parsed = Number.isSafeInteger(numeric) ? numeric : Date.parse(message.sentAt);
    return Number.isSafeInteger(parsed) && parsed > 0 ? [parsed] : [];
  });
  return values.length ? Math.min(...values) : undefined;
}

function addHistoryPageEvidence(
  conversations: RawConversation[],
  fallback: RawConversation,
  targetId: string,
  resource: string,
  pageIndex: number,
  start: number,
  count: number,
  end: boolean,
  valid: boolean,
): RawConversation[] {
  const evidence = JSON.stringify([{
    resource,
    page: sha256Id('history-page', [resource, pageIndex]),
    start,
    count,
    end,
    valid,
  }]);
  const values = conversations.length ? conversations : [{
    id: targetId,
    ...(fallback.entityUrn ? { entityUrn: fallback.entityUrn } : {}),
    ...(fallback.url ? { url: fallback.url } : {}),
  }];
  return values.map((conversation) => ({
    ...conversation,
    sourceMetadata: {
      ...conversation.sourceMetadata,
      historyEvidence: evidence,
      historyComplete: false,
      ...(!valid ? { parserMisses: Math.max(1, Number(conversation.sourceMetadata?.parserMisses ?? 0)) } : {}),
    },
  }));
}

function exactObservedOlderTemplate(observed: ObservedHistoryGet): string | undefined {
  const knownTargets = new Set(observed.targetIds);
  const matches = observed.continuationUrls.flatMap((url) => [...knownTargets]
    .flatMap((targetId) => anchoredHistoryContract(url, targetId) ? [{ url, targetId }] : []));
  const targetIds = new Set(matches.map(({ targetId }) => targetId));
  return matches.length === 1 && targetIds.size === 1 ? matches[0]?.url : undefined;
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
  const olderTemplate = exactObservedOlderTemplate(observed);
  manifest.counts.historyOlderTemplates = olderTemplate ? 1 : 0;
  const olderContract = olderTemplate ? [...new Set(observed.targetIds)].flatMap((targetId) => {
    const contract = anchoredHistoryContract(olderTemplate, targetId);
    return contract ? [contract] : [];
  })[0] : undefined;
  const olderPageSize = olderContract?.countBefore ?? 20;
  manifest.counts.historyOlderPageSize = olderPageSize;
  if (!olderTemplate) manifest.counts.historyDerivedTemplates = 1;

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
    const resource = sha256Id('history-resource', [targetId, 'messengerMessages-anchored']);
    const seenMessages = new Set<string>();
    const visitedAnchors = new Set<number>();
    let threadFailed = false;
    let covered = 0;
    let pageIndex = 0;
    let anchor: number | undefined;
    let reachedBeginning = false;
    let historyStage = 'initial-read';
    const appendParsedPage = (matching: RawConversation[], rawElementCount: number, end: boolean, misses: number) => {
      const keys = matching.flatMap((value) => value.messages ?? []).map(historyMessageKey);
      const newKeys = keys.filter((key) => !seenMessages.has(key));
      keys.forEach((key) => seenMessages.add(key));
      output.push(...addHistoryPageEvidence(matching, conversation, targetId, resource, pageIndex, covered, new Set(newKeys).size, end, misses === 0));
      covered += new Set(newKeys).size;
      pageIndex += 1;
      pages += 1;
      if (rawElementCount > 0 && !matching.length) throw new Error('history response identity mismatch');
      if (misses > 0) throw new Error('history parser misses');
    };
    try {
      const payload = await readJson(request, initial);
      historyStage = 'initial-parse';
      for (const shape of historyCollectionContractShapes(payload)) {
        const strategy = `history-contract:${shape}`;
        if (!manifest.strategies.includes(strategy) && manifest.strategies.filter((value) => value.startsWith('history-contract:')).length < 12) {
          manifest.strategies.push(strategy);
        }
      }
      const parsed = parseNetworkPayload(payload, initial, { observedMethod: 'GET' });
      manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + parsed.misses;
      if (parsed.misses > 0) recordMissElementContracts(payload, manifest);
      const collection = currentHistoryCollection(payload);
      const matching = parsed.conversations.filter((value) => exactConversationId(value) === targetId);
      const foreignMessages = parsed.conversations.some((value) => exactConversationId(value) !== targetId
        && (value.messages?.length ?? 0) > 0);
      if (!collection || foreignMessages || !matching.length) throw new Error('history response identity mismatch');
      appendParsedPage(matching, collection.elements.length, false, parsed.misses);
      anchor = oldestDeliveryAnchor(matching);
      if (!anchor) throw new Error('history delivery anchor unavailable');

      while (!reachedBeginning && pageIndex < MAX_HISTORY_PAGES_PER_CONVERSATION) {
        if (visitedAnchors.has(anchor)) throw new Error('history anchor cycle');
        visitedAnchors.add(anchor);
        historyStage = 'anchor-url';
        const url = olderTemplate && olderContract
          ? instantiateObservedAnchoredHistoryUrl(olderTemplate, observed.targetIds, targetId, anchor)
          : deriveObservedAnchoredHistoryUrl(initial, targetId, anchor, olderPageSize);
        historyStage = 'older-read';
        const olderPayload = await readJson(request, url);
        historyStage = 'older-parse';
        for (const shape of historyCollectionContractShapes(olderPayload)) {
          const strategy = `history-contract:${shape}`;
          if (!manifest.strategies.includes(strategy) && manifest.strategies.filter((value) => value.startsWith('history-contract:')).length < 12) {
            manifest.strategies.push(strategy);
          }
        }
        const olderParsed = parseNetworkPayload(olderPayload, url, { observedMethod: 'GET' });
        manifest.counts.parserMisses = (manifest.counts.parserMisses ?? 0) + olderParsed.misses;
        if (olderParsed.misses > 0) recordMissElementContracts(olderPayload, manifest);
        const olderCollection = currentHistoryCollection(olderPayload);
        if (!olderCollection) throw new Error('history collection missing');
        const olderMatching = olderParsed.conversations.filter((value) => exactConversationId(value) === targetId);
        const foreignOlderMessages = olderParsed.conversations.some((value) => exactConversationId(value) !== targetId
          && (value.messages?.length ?? 0) > 0);
        if (foreignOlderMessages) throw new Error('history response identity mismatch');
        reachedBeginning = olderCollection.elements.length < olderPageSize;
        appendParsedPage(olderMatching, olderCollection.elements.length, reachedBeginning, olderParsed.misses);
        if (reachedBeginning) break;
        const nextAnchor = oldestDeliveryAnchor(olderMatching);
        if (!nextAnchor || nextAnchor >= anchor) throw new Error('history anchor did not move backwards');
        anchor = nextAnchor;
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
      }
      if (!reachedBeginning) {
        manifest.warnings.push('THREAD_HISTORY_PAGE_BUDGET_EXHAUSTED');
        throw new Error('history page budget exhausted');
      }
    } catch (error) {
      threadFailed = true;
      const safeReason = error instanceof AppError ? error.code
        : error instanceof SyntaxError ? 'INVALID_JSON'
          : error instanceof Error && /^LinkedIn read endpoint returned HTTP [0-9]{3}$/.test(error.message)
            ? error.message.replace('LinkedIn read endpoint returned ', '').replace(/\s+/g, '_')
            : 'FAILED';
      const strategy = `history-page-failure:${historyStage}:${safeReason}`;
      if (!manifest.strategies.includes(strategy)) manifest.strategies.push(strategy);
      manifest.warnings.push('THREAD_READ_FAILED');
      output.push(...addHistoryPageEvidence([], conversation, targetId, resource, pageIndex, covered, 0, false, false));
    }
    if (!threadFailed && reachedBeginning) completed += 1;
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
