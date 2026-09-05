import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installProbeNavigationGate, type ProbeNavigationGate } from '../../src/linkedin/probe-navigation.js';

describe('probe navigation gate against local redirects', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let gate: ProbeNavigationGate | undefined;
  let server: Server;
  let origin: string;
  let unreadRequests = 0;
  let targetRequests = new Map<string, number>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith('/messaging/thread/')) targetRequests.set(request.url, (targetRequests.get(request.url) ?? 0) + 1);
      if (request.url === '/selection-redirect') {
        response.writeHead(302, { location: '/messaging/thread/UNREAD/' });
        response.end();
        return;
      }
      if (request.url === '/messaging/thread/READ-REDIRECT/') {
        response.writeHead(302, { location: '/messaging/thread/UNREAD/' });
        response.end();
        return;
      }
      if (request.url === '/messaging/thread/READ-HISTORY/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end("<!doctype html><script>try { history.pushState({}, '', '/messaging/thread/UNREAD/') } catch {}</script>");
        return;
      }
      if (request.url === '/messaging/thread/READ-LOCATION/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end("<!doctype html><script>location.href='/messaging/thread/UNREAD/'</script>");
        return;
      }
      if (request.url === '/messaging/thread/READ-POPUP/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end("<!doctype html><body><script>const link=document.createElement('a');link.href='/messaging/thread/UNREAD/';link.target='_blank';document.body.append(link);link.click()</script></body>");
        return;
      }
      if (request.url === '/messaging/thread/UNREAD/') unreadRequests += 1;
      response.writeHead(200, {
        'content-type': 'text/html',
        ...(request.url === '/messaging/thread/READ/' ? { 'set-cookie': 'privateCanary=value', 'x-private-canary': 'pavelPrivateConversation' } : {}),
      });
      response.end('<!doctype html><title>probe fixture</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local server address');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    unreadRequests = 0;
    targetRequests = new Map();
    context = await browser.newContext({ serviceWorkers: 'block' });
    page = await context.newPage();
    gate = undefined;
  });

  afterEach(async () => {
    await gate?.dispose().catch(() => undefined);
    await context.close().catch(() => undefined);
  });

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function reset(selectionPath = '/selection'): Promise<void> {
    gate = await installProbeNavigationGate(context, page, `${origin}${selectionPath}`);
  }

  async function loadSafeSelection(): Promise<void> {
    await page.goto(`${origin}/selection`, { waitUntil: 'domcontentloaded' });
    await gate!.assertSelectionSafe();
  }

  it('blocks a selection redirect before an unread thread receives a request', async () => {
    await reset('/selection-redirect');
    await page.goto(`${origin}/selection-redirect`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot()).toMatchObject({ selectionNavigationsAllowed: 1, targetNavigationsAllowed: 0, navigationAttemptsBlocked: 1 });
  });

  it('allows one exact target request but blocks its server redirect to unread', async () => {
    await reset();
    await loadSafeSelection();
    await expect(gate!.armTarget(`${origin}/messaging/thread/READ-REDIRECT/`, ['READ-REDIRECT'])).rejects.toThrow(/preflight/);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/READ-REDIRECT/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetPreflightGets: 1, targetNavigationsAllowed: 0, navigationAttemptsBlocked: 1 });
  });

  it.each(['READ-HISTORY', 'READ-LOCATION', 'READ-POPUP'])('fails closed for client-side navigation from %s', async (target) => {
    await reset();
    await loadSafeSelection();
    await gate!.armTarget(`${origin}/messaging/thread/${target}/`, [target]);
    await page.goto(`${origin}/messaging/thread/${target}/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(100);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot().targetNavigationsAllowed).toBe(1);
  });

  it('allows exactly one target navigation and blocks a cross-thread GraphQL GET', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
    const browserResponse = await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(browserResponse?.headers()['set-cookie']).toBeUndefined();
    expect(browserResponse?.headers()['x-private-canary']).toBeUndefined();
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetPreflightGets: 1, targetNavigationsAllowed: 1, navigationAttemptsBlocked: 0 });

    await page.evaluate(() => fetch('https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationUrn=urn%3Ali%3AmessagingThread%3AUNREAD').catch(() => undefined));
    await page.waitForTimeout(50);
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });
});
