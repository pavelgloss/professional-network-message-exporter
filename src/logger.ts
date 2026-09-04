const secretKey = /(cookie|authorization|csrf|token|session|password|li_at|jsessionid)/i;
const tokenLike = /\b(?:AQED[A-Za-z0-9_-]{10,}|Bearer\s+\S+|[A-Fa-f0-9]{32,})\b/g;

export function redact(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    let cleaned = value.replace(tokenLike, '[REDACTED]');
    try {
      const url = new URL(cleaned);
      url.search = '';
      url.hash = '';
      cleaned = url.toString();
    } catch { /* ordinary string */ }
    return cleaned;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

export type Logger = ReturnType<typeof createLogger>;
export function createLogger(stream: Pick<NodeJS.WriteStream, 'write'> = process.stderr) {
  const emit = (level: string, event: string, details: Record<string, unknown> = {}) => stream.write(`${JSON.stringify(redact({ time: new Date().toISOString(), level, event, ...details }))}\n`);
  return {
    info: (event: string, details?: Record<string, unknown>) => emit('info', event, details),
    warn: (event: string, details?: Record<string, unknown>) => emit('warn', event, details),
    error: (event: string, details?: Record<string, unknown>) => emit('error', event, details),
  };
}

