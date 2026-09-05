import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifest } from '../../src/io/diagnostics.js';
import { createLogger } from '../../src/logger.js';
import { installRequestGuard } from '../../src/browser/request-guard.js';

describe('WebSocket request guard', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

  it('blocks before the server receives an upgrade or frame', async () => {
    let upgrades = 0;
    let frames = 0;
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
      upgrades += 1;
      socket.on('data', () => { frames += 1; });
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');

    const browser = await chromium.launch({ headless: true });
    cleanup.push(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const manifest = createManifest();
    const logger = createLogger({ write: () => true });
    await installRequestGuard(context, manifest, logger);
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>ws guard</title>');
    await page.evaluate((port) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/mutating-channel?token=canary`);
      socket.addEventListener('open', () => socket.send('state-change'));
    }, address.port);
    await page.waitForTimeout(500);

    expect(upgrades).toBe(0);
    expect(frames).toBe(0);
    expect(manifest.counts.blockedWebSockets).toBe(1);
  });

  it('stores only a redacted WebSocket path shape', async () => {
    const browser = await chromium.launch({ headless: true });
    cleanup.push(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const manifest = createManifest();
    const output: string[] = [];
    const logger = createLogger({ write: (value) => { output.push(String(value)); return true; } });
    await installRequestGuard(context, manifest, logger);
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>ws guard redaction</title>');
    await page.evaluate(() => new WebSocket('ws://127.0.0.1:9/thread/PRIVATE-CONVERSATION-12345?token=CANARY'));
    await page.waitForTimeout(200);

    expect(output.join('')).not.toContain('PRIVATE-CONVERSATION-12345');
    expect(output.join('')).not.toContain('CANARY');
    expect(output.join('')).toContain('/thread/:opaque');
  });
});
