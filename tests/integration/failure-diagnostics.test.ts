import { chromium } from 'playwright';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { saveContentDiagnosticsOnFailure } from '../../src/io/diagnostics.js';

describe('failure content diagnostics', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => browser.close());

  it('saves sanitized content after authenticated PARSER_NO_DATA only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-failure-diagnostics-'));
    const canary = 'CANARY_CREDENTIAL_SECRET_24680';
    await page.setContent(`<script>window.secret='${canary}'</script><meta name="csrf-token" content="${canary}"><input value="${canary}"><a href="https://www.linkedin.com/messaging/?token=${canary}">safe link</a>`);

    expect(await saveContentDiagnosticsOnFailure(page, directory, 'authenticated-parser-failure', { enabled: true, authenticated: true, errorCode: 'PARSER_NO_DATA' })).toBe(true);
    const html = await readFile(path.join(directory, 'authenticated-parser-failure', 'page.sanitized.html'), 'utf8');
    expect(html).not.toContain(canary);
    await expect(stat(path.join(directory, 'authenticated-parser-failure', 'page.png'))).resolves.toBeDefined();

    expect(await saveContentDiagnosticsOnFailure(page, directory, 'login-failure', { enabled: true, authenticated: false, errorCode: 'PARSER_NO_DATA' })).toBe(false);
    expect(await saveContentDiagnosticsOnFailure(page, directory, 'auth-challenge', { enabled: true, authenticated: true, errorCode: 'AUTH_CHALLENGE' })).toBe(false);
    await expect(stat(path.join(directory, 'login-failure'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(directory, 'auth-challenge'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
