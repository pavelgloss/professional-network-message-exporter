import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { redact } from '../../src/logger.js';

describe('config', () => {
  it('uses safe defaults and CLI precedence', () => {
    const config = parseConfig(['export', '--limit', '17'], {}, 'C:\\workspace');
    expect(config.limit).toBe(17);
    expect(config.probeReadThread).toBe(false);
    expect(path.isAbsolute(config.statePath)).toBe(true);
  });
  it('rejects dangerous roots', () => {
    expect(() => parseConfig(['export', '--output', 'C:\\'], {}, 'C:\\workspace')).toThrow(/root/);
  });
  it('rejects unknown, orphaned, duplicate, and missing arguments', () => {
    expect(() => parseConfig(['export', '--unknown'], {}, 'C:\\workspace')).toThrow(/Unknown option/);
    expect(() => parseConfig(['export', '17'], {}, 'C:\\workspace')).toThrow(/Unexpected argument/);
    expect(() => parseConfig(['export', '--limit'], {}, 'C:\\workspace')).toThrow(/Missing value/);
    expect(() => parseConfig(['export', '--limit', '1', '--limit=2'], {}, 'C:\\workspace')).toThrow(/Duplicate option/);
    expect(() => parseConfig(['export', '--allow-thread-open'], {}, 'C:\\workspace')).toThrow(/Unknown option/);
  });
  it('keeps the one-thread probe default-off and metadata-only', () => {
    expect(parseConfig(['export', '--probe-read-thread'], {}, 'C:\\workspace').probeReadThread).toBe(true);
    expect(() => parseConfig(['export', '--probe-read-thread', '--diagnostics-content'], {}, 'C:\\workspace')).toThrow(/metadata only/);
  });
});

describe('redaction', () => {
  it('recursively removes secrets and URL queries', () => {
    const output = JSON.stringify(redact({ cookie: 'canary', nested: { authorization: 'Bearer secret', url: 'https://www.linkedin.com/voyager/api?q=secret', message: 'failed at https://www.linkedin.com/path?q=secret' } }));
    expect(output).not.toContain('canary');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('?');
  });
  it('redacts opaque URL origins and alphabetic path IDs in arbitrary error messages', () => {
    const canary = 'pavelPrivateConversation';
    const output = JSON.stringify(redact({
      message: `page.goto failed at https://www.linkedin.com/messaging/thread/${canary}/`,
      external: `https://${canary.toLowerCase()}.example/random/${canary}`,
    }));
    expect(output).not.toContain(canary);
    expect(output.toLowerCase()).not.toContain(canary.toLowerCase());
    expect(output).toContain('/messaging/thread/:opaque');
    expect(output).toContain('<redacted-origin>');
  });
});
