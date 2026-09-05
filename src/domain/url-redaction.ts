import { repeatedlyDecodeAndNormalize } from './url-safety.js';

const sensitiveName = /(?:auth|cookie|csrf|password|secret|session|token)/i;
const structuralNames = new Map([
  'actor', 'array', 'attributes', 'attributedbody', 'backendconversationurn', 'backendurn', 'body', 'count', 'createdat',
  'cursor', 'data', 'deliveredat', 'edges', 'elements', 'endcursor', 'entityurn', 'eventcontent', 'events', 'eventtype',
  'featureflags', 'first', 'hasnextpage', 'hostidentityurn', 'id', 'included', 'isread', 'lastactivity',
  'lastactivityat', 'links', 'members', 'messages', 'name', 'navigationurl', 'nextcursor', 'nodes', 'pageinfo',
  'paging', 'participants', 'profileurl', 'queryid', 'rendercontent', 'sender', 'start', 'subtype', 'text', 'timestamp',
  'total', 'type', 'unreadcount', 'updatedat', 'variables', 'conversationurl', 'conversationparticipants',
].map((name) => [name, name]));

const structuralPathSegments = new Map([
  'api', 'checkpoint', 'conversation', 'conversations', 'event', 'events', 'graphql', 'history', 'in', 'message',
  'messages', 'messaging', 'thread', 'threads', 'voyager', 'voyagermessaginggraphql',
].map((name) => [name, name]));

const knownOrigins = new Map([
  ['https://www.linkedin.com', 'https://www.linkedin.com'],
  ['https://linkedin.com', 'https://linkedin.com'],
]);

export function safeStructuralName(value: string): string {
  if (sensitiveName.test(value)) return '<redacted-key>';
  const prefix = value.startsWith('*') || value.startsWith('$') ? value[0]! : '';
  const canonical = structuralNames.get(value.slice(prefix.length).toLocaleLowerCase('en-US'));
  return canonical ? `${prefix}${canonical}` : '<opaque-key>';
}

export function queryParameterNames(url: URL): string[] {
  return [...new Set([...url.searchParams.keys()].map(safeStructuralName))].sort();
}

export function redactedPathShape(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const output: string[] = [];
  let redactNext = false;
  const idParent = /^(?:in|thread|threads|profile|profiles|member|members|company|companies|conversation|conversations|message|messages)$/i;
  for (const segment of segments) {
    const decoded = repeatedlyDecodeAndNormalize(segment) ?? '';
    const structural = structuralPathSegments.get(decoded.toLocaleLowerCase('en-US'));
    const shouldRedact = redactNext || !structural || sensitiveName.test(decoded);
    output.push(shouldRedact ? ':opaque' : structural);
    redactNext = idParent.test(decoded);
  }
  return `/${output.join('/')}` || '/';
}

export function safeDiagnosticOrigin(value: URL | string): string {
  let url: URL;
  try { url = typeof value === 'string' ? new URL(value) : value; } catch { return '<redacted-origin>'; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol;
  return knownOrigins.get(url.origin.toLocaleLowerCase('en-US')) ?? '<redacted-origin>';
}

export function redactedUrlShape(value: string): string {
  try {
    const url = new URL(value);
    return `${safeDiagnosticOrigin(url)}${redactedPathShape(url.pathname)}`;
  } catch { return '<redacted-url>'; }
}
