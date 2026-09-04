import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { redact } from '../../src/logger.js';

describe('config', () => {
  it('uses safe defaults and CLI precedence', () => {
    const config = parseConfig(['export', '--limit', '17'], {}, 'C:\\workspace');
    expect(config.limit).toBe(17);
    expect(config.allowThreadOpen).toBe(false);
    expect(path.isAbsolute(config.profileDir)).toBe(true);
  });
  it('rejects dangerous roots', () => {
    expect(() => parseConfig(['export', '--output', 'C:\\'], {}, 'C:\\workspace')).toThrow(/root/);
  });
});

describe('redaction', () => {
  it('recursively removes secrets and URL queries', () => {
    const output = JSON.stringify(redact({ cookie: 'canary', nested: { authorization: 'Bearer secret', url: 'https://www.linkedin.com/voyager/api?q=secret' } }));
    expect(output).not.toContain('canary');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('?');
  });
});

