import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifest } from '../../src/io/diagnostics.js';
import { createLogger } from '../../src/logger.js';
import { closeContext, launchContext } from '../../src/browser/context.js';
import { saveStorageState } from '../../src/auth/session.js';
import type { AppConfig } from '../../src/config.js';

describe('login storage state to export isolation', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

  it('does not carry a service worker and blocks POST and WebSocket before the first export page', async () => {
    let posts = 0;
    let upgrades = 0;
    const server = createServer((request, response) => {
      if (request.method === 'POST') posts += 1;
      if (request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' });
        response.end("self.addEventListener('fetch', event => { if (event.request.url.includes('/mutate')) event.respondWith(fetch(event.request)); });");
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>session isolation</title>');
    });
    server.on('upgrade', (_request, socket) => { upgrades += 1; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');

    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-state-isolation-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const statePath = path.join(directory, 'state.json');
    const config: AppConfig = {
      command: 'export',
      statePath,
      outputPath: path.join(directory, 'messages.json'),
      diagnosticsDir: path.join(directory, 'diagnostics'),
      limit: 1,
      timeoutMs: 5_000,
      headless: true,
      probeReadThread: false,
      withHistoryProbe: false,
      diagnosticsContent: false,
    };
    const logger = createLogger({ write: () => true });
    const origin = `http://127.0.0.1:${address.port}`;

    // This is the real login context construction, forced headless only for CI.
    const loginContext = await launchContext(config, 'login', createManifest(), logger, { headless: true });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(origin);
    await loginPage.evaluate(() => localStorage.setItem('login-canary', 'present'));
    await loginPage.evaluate(() => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
    expect(loginContext.serviceWorkers()).toHaveLength(0);
    await saveStorageState(loginContext, statePath);
    await closeContext(loginContext);
    expect(await readFile(statePath, 'utf8')).not.toContain('sw.js');

    const manifest = createManifest();
    const exportContext = await launchContext(config, 'export', manifest, logger);
    cleanup.push(() => closeContext(exportContext));
    expect(exportContext.pages()).toHaveLength(0);
    expect(exportContext.serviceWorkers()).toHaveLength(0);
    const exportPage = await exportContext.newPage();
    await exportPage.goto(origin);
    expect(await exportPage.evaluate(() => localStorage.getItem('login-canary'))).toBe('present');
    await exportPage.evaluate(() => fetch('/mutate', { method: 'POST', body: 'canary' }).catch(() => undefined));
    await exportPage.evaluate((port) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/mutate`);
      socket.addEventListener('open', () => socket.send('canary'));
    }, address.port);
    await exportPage.waitForTimeout(300);

    expect(posts).toBe(0);
    expect(upgrades).toBe(0);
    expect(exportContext.serviceWorkers()).toHaveLength(0);
    expect(manifest.counts.blockedRequests).toBe(1);
    expect(manifest.counts.blockedWebSockets).toBe(1);
  });
});
