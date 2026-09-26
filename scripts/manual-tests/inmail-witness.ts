import { conversationIdFromUrn, messageIdFromUrn } from '../../src/domain/stable-id.js';
import type { LinkedInExport } from '../../src/domain/schema.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const at = (value: unknown, keys: string[]): unknown => keys.reduce<unknown>((current, key) => object(current) ? current[key] : undefined, value);
const text = (value: unknown) => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() || undefined : undefined;

// Independent reference paths, intentionally not importing/reusing textFrom or
// recursively following arbitrary body keys. New shapes require explicit review.
const referencePaths = [
  ['body', 'text'], ['body'], ['messageBody', 'text'], ['messageBody'],
  ['attributedBody', 'text'], ['eventContent', 'attributedBody', 'text'],
  ['eventContent', 'body', 'text'], ['eventContent', 'body'], ['eventContent', 'text'],
  ['content', 'body', 'text'], ['content', 'body'], ['content', 'text'],
  ['commentary', 'text'], ['text'],
];

function hasReferenceAttachment(value: ObjectValue): boolean {
  const explicit = Array.isArray(value.attachments) ? value.attachments : [value.attachments];
  const rendered = Array.isArray(value.renderContent) ? value.renderContent : [value.renderContent];
  const files = rendered.flatMap((entry) => ['file', 'image', 'video', 'audio', 'document'].map((kind) => at(entry, ['content', kind])));
  return [...explicit, ...files].some((entry) => object(entry) && (
    ['id', 'entityUrn', 'urn', 'mediaUrn', 'assetUrn', 'digitalmediaAssetUrn', 'name', 'fileName', 'filename'].some((key) => text(entry[key]))
    || ['mimeType', 'mediaType', 'contentType', 'type'].some((key) => /^(?:[\w.+-]+\/[\w.+-]+|file|image|video|audio|document|attachment)$/i.test(text(entry[key]) ?? ''))
    || ['downloadUrl', 'mediaUrl', 'url'].some((key) => /^https:\/\/(?:[\w.-]+\.)?linkedin\.com\//i.test(text(entry[key]) ?? ''))
  ));
}

export function createInmailWitness() {
  const expected = new Map<string, string>();
  const unsupported = new Set<string>();
  const conflicts = new Set<string>();
  const distinctBodies = new Set<string>();
  let unkeyed = 0;
  let parserMisses = 0;
  return {
    observe(payload: unknown, misses: number) {
      parserMisses += misses;
      const seen = new WeakSet<object>();
      const visit = (value: unknown, parentConversation?: string): void => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { value.forEach((item) => visit(item, parentConversation)); return; }
        if (!object(value)) return;
        const ownUrn = text(value.entityUrn) ?? text(value.eventUrn) ?? text(value.messageUrn);
        const conversation = conversationIdFromUrn(text(value.backendConversationUrn) ?? text(value.conversationUrn)
          ?? text(at(value, ['conversation', 'entityUrn'])))
          ?? (ownUrn && /(?:conversation|thread):/i.test(ownUrn) ? conversationIdFromUrn(ownUrn) : undefined)
          ?? parentConversation;
        const isEvent = ownUrn && /(?:message|event)/i.test(ownUrn.match(/^urn:li:([^:]+):/)?.[1] ?? '');
        if (isEvent && typeof value.subject === 'string') {
          const id = messageIdFromUrn(ownUrn);
          if (!id || !conversation) unkeyed += 1;
          else {
            const key = `${conversation}\n${id}`;
            const body = referencePaths.map((keys) => text(at(value, keys))).find((candidate) => candidate !== undefined)
              ?? (hasReferenceAttachment(value) ? '' : undefined);
            if (body === undefined) unsupported.add(key);
            else {
              if (expected.has(key) && expected.get(key) !== body) conflicts.add(key);
              expected.set(key, body);
              if (body && body !== text(value.subject)) distinctBodies.add(key);
            }
          }
        }
        Object.values(value).forEach((item) => visit(item, conversation));
      };
      visit(payload);
    },
    compare(data: LinkedInExport) {
      let checked = 0;
      let mismatches = 0;
      let inbound = 0;
      let outbound = 0;
      let missing = 0;
      let distinctSubjectBody = 0;
      let attachmentOnly = 0;
      const exportedConversations = new Set(data.conversations.map((conversation) => conversation.id));
      const exportedKeys = new Set(data.conversations.flatMap((conversation) => conversation.messages.map((message) => `${conversation.id}\n${message.id}`)));
      for (const key of expected.keys()) {
        if (exportedConversations.has(key.split('\n')[0]!) && !exportedKeys.has(key)) missing += 1;
      }
      for (const conversation of data.conversations) {
        for (const message of conversation.messages) {
          const key = `${conversation.id}\n${message.id}`;
          if (!expected.has(key)) continue;
          checked += 1;
          if (distinctBodies.has(key)) distinctSubjectBody += 1;
          if (expected.get(key) === '') attachmentOnly += 1;
          if (expected.get(key) && message.direction === 'inbound') inbound += 1;
          if (expected.get(key) && message.direction === 'outbound') outbound += 1;
          if (message.text !== expected.get(key)) mismatches += 1;
        }
      }
      return {
        observedInmailBodies: expected.size, checked, inbound, outbound, mismatches, missing, distinctSubjectBody, attachmentOnly,
        unsupported: unsupported.size, conflicts: conflicts.size, unkeyed, parserMisses,
        partial: data.stats.partial, conversations: data.conversations.length,
        messages: data.stats.exportedMessageCount,
        passed: checked > 0 && inbound > 0 && outbound > 0 && distinctSubjectBody > 0 && mismatches === 0 && missing === 0
          && unsupported.size === 0 && conflicts.size === 0 && unkeyed === 0 && parserMisses === 0,
      };
    },
  };
}
