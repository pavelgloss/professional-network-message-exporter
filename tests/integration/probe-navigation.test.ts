import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProbeNavigationGate, type ProbeNavigationGate } from '../../src/linkedin/probe-navigation.js';
import { createProbeContext, probeTransport } from '../../src/browser/probe-transport.js';

describe('probe navigation gate against local redirects', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let gate: ProbeNavigationGate | undefined;
  let server: Server;
  let origin: string;
  let unreadRequests = 0;
  let targetRequests = new Map<string, number>();
  let allRequests = new Map<string, number>();
  let requestCookies = new Map<string, string>();
  let redirectConversationList = false;
  let slowConversationList = false;
  let listFinished = false;
  let oversizedApi = false;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url) {
        allRequests.set(request.url, (allRequests.get(request.url) ?? 0) + 1);
        requestCookies.set(request.url, request.headers.cookie ?? '');
      }
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
      if (request.url === '/messaging/thread/READ-HEADER-LOCATION/') {
        response.writeHead(200, { 'content-type': 'text/html', location: '/messaging/thread/UNREAD/' });
        response.end('<!doctype html>');
        return;
      }
      if (request.url === '/messaging/thread/READ-OVERSIZE/') {
        const body = Buffer.alloc(8 * 1024 * 1024 + 1, 32);
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.byteLength) });
        response.end(body);
        return;
      }
      if (request.url === '/messaging/thread/READ-DELAY/') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><title>delayed safe target</title>');
        }, 350);
        return;
      }
      if (request.url === '/assets/worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end("fetch('/messaging/thread/UNREAD/').catch(()=>{})");
        return;
      }
      if (request.url === '/assets/app.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', 'set-cookie': 'assetPrivate=secret' });
        response.end('globalThis.assetLoaded=true;');
        return;
      }
      if (request.url?.startsWith('/assets/size-')) {
        const sizeMiB = request.url.includes('-17') ? 17 : 33;
        const body = Buffer.alloc(sizeMiB * 1024 * 1024, 32);
        body.write('globalThis.largeScriptExecuted=true;/*body-private-canary');
        body.write('*/', body.length - 2);
        const compressed = request.url.includes('-gzip-');
        const wireBody = compressed ? gzipSync(body) : body;
        response.writeHead(200, {
          'content-type': request.url.includes('-css-') ? 'text/css' : 'text/javascript',
          'content-length': String(wireBody.byteLength),
          ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          'x-private-canary': 'header-canary',
        });
        response.end(wireBody);
        return;
      }
      if (request.url === '/assets/redirect.js') {
        response.writeHead(302, { location: '/voyager/api/messagingV2/conversations/UNREAD/events' });
        response.end();
        return;
      }
      if (request.url?.startsWith('/assets/private-asset-canary-')) {
        if (request.url.includes('-timeout.js')) return; // Broker's real 5 s deadline aborts this request.
        const status = request.url.includes('-status.js') ? 403 : 200;
        response.writeHead(status, {
          'content-type': request.url.includes('-mime.js') ? 'text/html; private=mime-canary' : 'text/javascript',
          'x-private-canary': 'header-canary',
          ...(request.url.includes('-redirect.js') ? { location: '/messaging/thread/UNREAD/?secret=redirect-canary' } : {}),
        });
        response.end('body-private-canary');
        return;
      }
      if (redirectConversationList && request.url === '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations') {
        response.writeHead(302, { location: '/voyager/api/messagingV2/conversations/UNREAD/events' });
        response.end();
        return;
      }
      if (request.url?.startsWith('/voyager/api/')) {
        if (oversizedApi) {
          const body = Buffer.alloc(17 * 1024 * 1024, 32);
          body.write('{}');
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.byteLength) });
          response.end(body);
          return;
        }
        if (slowConversationList && request.url.includes('queryId=messengerConversations')) {
          setTimeout(() => {
            listFinished = true;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"ok":true}');
          }, 300);
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      if (request.url === '/messaging/thread/UNREAD/') unreadRequests += 1;
      const resourceFixture: Record<string, string> = {
        '/selection-img': '<img src="/messaging/thread/UNREAD/">',
        '/selection-iframe': '<iframe src="/messaging/thread/UNREAD/"></iframe>',
        '/selection-prefetch': '<link rel="prefetch" href="/messaging/thread/UNREAD/">',
        '/selection-subframe': '<object data="/messaging/thread/UNREAD/"></object>',
        '/selection-worker': '<script>new Worker("/assets/worker.js")</script>',
        '/selection-script': '<script src="/assets/app.js"></script>',
        '/selection-asset-redirect': '<script src="/assets/redirect.js"></script>',
        '/selection-list': '<script>fetch("/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations").catch(()=>{})</script>',
        '/selection-eager-messaging': '<script>Promise.all([fetch("/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD"),fetch("/voyager/api/messagingV2/conversations/UNREAD/events")]).catch(()=>{})</script>',
        '/selection-history': '<script>try { history.pushState({}, "", "/messaging/thread/UNREAD/") } catch {}</script>',
        '/selection-location': '<script>location.href="/messaging/thread/UNREAD/"</script>',
        '/selection-popup': '<body><script>const link=document.createElement("a");link.href="/messaging/thread/UNREAD/";link.target="_blank";document.body.append(link);link.click()</script></body>',
        '/selection-delayed-history': '<script>setTimeout(()=>{try{history.pushState({},"","/messaging/thread/UNREAD/")}catch{}},100)</script>',
        '/selection-delayed-foreign': '<script>setTimeout(()=>fetch("/voyager/api/messagingV2/conversations/UNREAD/events").catch(()=>{}),100)</script>',
        '/selection-delayed-location': '<script>setTimeout(()=>{location.href="/messaging/thread/UNREAD/"},100)</script>',
        '/selection-delayed-popup': '<body><script>setTimeout(()=>{const link=document.createElement("a");link.href="/messaging/thread/UNREAD/";link.target="_blank";document.body.append(link);link.click()},100)</script></body>',
        '/selection-delayed-subframe': '<body><script>setTimeout(()=>{const frame=document.createElement("iframe");frame.src="/messaging/thread/UNREAD/";document.body.append(frame)},100)</script></body>',
        '/selection-delayed-hash': '<script>setTimeout(()=>{location.hash="unsafe"},100)</script>',
        '/selection-delayed-prototype': '<script>const back=location.href;setTimeout(()=>{try{History.prototype.pushState.call(history,{},"",location.origin+"/messaging/thread/UNREAD/")}catch{};try{Reflect.apply(History.prototype.replaceState,history,[{},"",back])}catch{}},100)</script>',
      };
      response.writeHead(200, {
        'content-type': 'text/html',
        ...(request.url === '/messaging/thread/READ/' ? { 'set-cookie': 'targetPrivate=value', 'x-private-canary': 'pavelPrivateConversation' } : {}),
        ...(request.url === '/selection-cookie' ? { 'set-cookie': 'selectionPrivate=value', 'x-private-canary': 'pavelPrivateConversation' } : {}),
      });
      response.end(`<!doctype html><title>probe fixture</title>${resourceFixture[request.url ?? ''] ?? ''}`);
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
    allRequests = new Map();
    requestCookies = new Map();
    redirectConversationList = false;
    slowConversationList = false;
    listFinished = false;
    oversizedApi = false;
    context = await createProbeContext(browser);
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

  it('requires transport isolation before accepting a probe context', async () => {
    const unprotected = await browser.newContext();
    try {
      await expect(installProbeNavigationGate(unprotected, await unprotected.newPage(), `${origin}/selection`))
        .rejects.toThrow(/transport isolation/);
      expect(allRequests.size).toBe(0);
    } finally { await unprotected.close(); }
  });

  it('denies intentional Playwright route bypass including loopback and CONNECT with a hard state', async () => {
    await reset();
    await loadSafeSelection();
    // This reproduces the lower-level continueRequest outcome deterministically,
    // regardless of whether a detached-frame/closing-page race occurs this run.
    await context.route('**/*', route => route.continue());
    await page.evaluate(async ({ http, https }) => {
      await Promise.all([fetch(http).catch(() => undefined), fetch(https).catch(() => undefined)]);
    }, { http: `${origin}/voyager/api/unknownMessaging/conversations/UNREAD/events`,
      https: origin.replace('http:', 'https:') + '/voyager/api/unknownMessaging/conversations/UNREAD/events' });
    expect(allRequests.get('/voyager/api/unknownMessaging/conversations/UNREAD/events')).toBeUndefined();
    expect(probeTransport(context).hits).toBeGreaterThanOrEqual(2);
    expect(gate!.snapshot().hardViolationReasons).toContain('transport-denied');
    await expect(gate!.armTarget(`${origin}/messaging/thread/READ/`, ['READ'])).rejects.toThrow();
    expect(targetRequests.size).toBe(0);
  });

  it('executes an isolated asset and exact history GET without browser egress or cookie propagation', async () => {
    await context.addCookies([{ name: 'private', value: 'canary', url: origin }]);
    await reset('/selection-script');
    await page.goto(`${origin}/selection-script`);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { assetLoaded?: boolean }).assetLoaded)).toBe(true);
    expect(allRequests.get('/assets/app.js')).toBe(1);
    expect(requestCookies.get('/assets/app.js')).toBe('');
    expect((await context.cookies()).some(cookie => cookie.name === 'assetPrivate')).toBe(false);
    page = await gate!.armTarget(`${origin}/messaging/thread/READ/`, ['READ']);
    await page.goto(`${origin}/messaging/thread/READ/`);
    const history = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=READ';
    expect(await page.evaluate(async url => (await fetch(url)).json(), history)).toEqual({ ok: true });
    expect(allRequests.get(history)).toBe(1);
    expect(probeTransport(context).hits).toBe(0);
    await gate!.assertTargetSafe();
  });

  it('retains transport hard-state auditing after gate disposal until context closes', async () => {
    await reset();
    await loadSafeSelection();
    await gate!.dispose();
    const foreign = '/voyager/api/unknownMessaging/conversations/UNREAD/events';
    await page.evaluate(url => fetch(url).catch(() => undefined), foreign);
    await context.close();
    expect(allRequests.get(foreign)).toBeUndefined();
    expect(gate!.snapshot().transportRequestsDenied).toBeGreaterThan(0);
    expect(gate!.snapshot().hardViolationReasons).toContain('transport-denied');
  });

  it('revokes a queued selection broker before its first network send', async () => {
    await reset();
    await loadSafeSelection();
    const originalStorageState = context.storageState.bind(context);
    let release!: () => void;
    let entered = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(context, 'storageState').mockImplementationOnce(async () => {
      entered = true;
      await barrier;
      return originalStorageState();
    });
    const list = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations';
    try {
      await page.evaluate(url => { void fetch(url).catch(() => undefined); }, list);
      await expect.poll(() => entered).toBe(true);
      const arming = gate!.armTarget(`${origin}/messaging/thread/READ/`, ['READ']);
      release();
      page = await arming;
      expect(allRequests.get(list)).toBeUndefined();
      expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    } finally { release(); spy.mockRestore(); }
  });

  it('never follows an asset redirect to an unknown messaging endpoint', async () => {
    await reset('/selection-asset-redirect');
    await page.goto(`${origin}/selection-asset-redirect`);
    expect(allRequests.get('/voyager/api/messagingV2/conversations/UNREAD/events')).toBeUndefined();
    await expect(gate!.assertSelectionSafe()).rejects.toThrow();
  });

  it.each([
    ['status', 'status-403'],
    ['redirect', 'redirect'],
    ['mime', 'content-type'],
    ['timeout', 'timeout'],
  ])('reports only closed asset failure diagnostics for %s', async (kind, reason) => {
    await reset();
    await loadSafeSelection();
    await page.evaluate((url) => {
      const script = document.createElement('script');
      script.src = url;
      document.body.append(script);
    }, `/assets/private-asset-canary-${kind}.js?secret=query-canary`);
    await expect.poll(() => gate!.snapshot().assetProxyFailures, { timeout: 7_000 })
      .toEqual([{ resourceType: 'script', reason }]);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(gate!.snapshot().hardViolationReasons).toContain('blocked-subrequest:asset-broker');
    await gate!.dispose().catch(() => undefined);
    await context.close();
    const snapshot = gate!.snapshot();
    expect(snapshot.targetPreflightGets).toBe(0);
    expect(snapshot.targetNavigationsAllowed).toBe(0);
    expect(snapshot.transportRequestsDenied).toBe(0);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.size).toBe(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/canary|secret|127\.0\.0\.1|https?:|\/assets\//);
  }, 10_000);

  it('executes an allowlisted 17 MiB script while retaining the 16 MiB API limit', async () => {
    await reset();
    await loadSafeSelection();
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/assets/size-script-17.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Synthetic script failed'));
      document.body.append(script);
    }));
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { largeScriptExecuted?: boolean }).largeScriptExecuted)).toBe(true);
    await gate!.assertSelectionSafe();
    expect(gate!.snapshot().assetProxyFailures).toEqual([]);
    oversizedApi = true;
    await page.evaluate(() => fetch('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations').catch(() => undefined));
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(gate!.snapshot().apiProxyFailures).toContain('declared-size');
    await gate!.dispose().catch(() => undefined);
    await context.close();
    expect(unreadRequests).toBe(0);
    expect(targetRequests.size).toBe(0);
    expect(gate!.snapshot().transportRequestsDenied).toBe(0);
  });

  it.each([
    ['script', '33', 'declared-size', 33, 32],
    ['script', 'gzip-33', 'body-size', 33, 32],
    ['stylesheet', 'css-17', 'declared-size', 17, 16],
  ] as const)('rejects oversized %s %s with numeric-only diagnostics', async (resourceType, suffix, reason, sizeMiB, limitMiB) => {
    await reset();
    await loadSafeSelection();
    await page.evaluate(({ resourceType, suffix }) => {
      const element = resourceType === 'script' ? document.createElement('script') : document.createElement('link');
      const url = `/assets/size-${suffix}.js?secret=query-canary`;
      if (element instanceof HTMLScriptElement) element.src = url;
      else { element.rel = 'stylesheet'; element.href = url; }
      document.body.append(element);
    }, { resourceType, suffix });
    await expect.poll(() => gate!.snapshot().assetProxyFailures, { timeout: 7_000 }).toEqual([{
      resourceType, reason, limitBytes: limitMiB * 1024 * 1024,
      ...(reason === 'body-size' ? { actualBytes: sizeMiB * 1024 * 1024 } : { declaredBytes: sizeMiB * 1024 * 1024 }),
    }]);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    await gate!.dispose().catch(() => undefined);
    await context.close();
    const snapshot = gate!.snapshot();
    expect(snapshot.targetNavigationsAllowed).toBe(0);
    expect(snapshot.transportRequestsDenied).toBe(0);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.size).toBe(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/canary|secret|127\.0\.0\.1|https?:|\/assets\//);
  }, 10_000);

  it('drains an in-flight selection broker GET before target preflight', async () => {
    slowConversationList = true;
    await reset();
    await loadSafeSelection();
    const list = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations';
    await page.evaluate(url => { void fetch(url).catch(() => undefined); }, list);
    await expect.poll(() => allRequests.get(list)).toBe(1);
    expect(listFinished).toBe(false);
    page = await gate!.armTarget(`${origin}/messaging/thread/READ/`, ['READ']);
    expect(listFinished).toBe(true);
    expect(allRequests.get(list)).toBe(1);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
  });

  it('keeps fetch keepalive asset iframe and worker zero-to-ten-millisecond races off foreign servers', async () => {
    await context.close();
    for (const kind of ['fetch', 'keepalive', 'asset', 'iframe', 'worker']) {
      for (let delay = 0; delay <= 10; delay += 1) {
        const raceContext = await createProbeContext(browser);
        const selection = await raceContext.newPage();
        const raceGate = await installProbeNavigationGate(raceContext, selection, `${origin}/selection`);
        try {
          await selection.goto(`${origin}/selection`);
          await selection.evaluate(async ({ delay, kind, url }) => {
            const code = `setTimeout(()=>fetch(${JSON.stringify(url)}).catch(()=>{}),${delay})`;
            if (kind === 'worker') {
              const worker = new Worker(URL.createObjectURL(new Blob([`postMessage('ready');onmessage=()=>{${code}}`], { type: 'text/javascript' })));
              await new Promise<void>(resolve => { worker.onmessage = () => resolve(); });
              worker.postMessage('start');
              return;
            }
            if (kind === 'iframe') {
              const frame = document.createElement('iframe');
              const loaded = new Promise<void>(resolve => { frame.onload = () => resolve(); });
              frame.srcdoc = `<script>onmessage=()=>{${code}}</script>`;
              document.body.append(frame);
              await loaded;
              frame.contentWindow!.postMessage('start', '*');
              return;
            }
            setTimeout(() => {
              if (kind === 'asset') { const image = new Image(); image.src = url; }
              else void fetch(url, { keepalive: kind === 'keepalive' }).catch(() => undefined);
            }, delay);
          }, { delay, kind, url: `${origin}/voyager/api/unknownMessaging/conversations/UNREAD/events` });
          let target: Page | undefined;
          try { target = await raceGate.armTarget(`${origin}/messaging/thread/READ/`, ['READ']); } catch { /* hard fail is permitted */ }
          if (target) {
            await target.goto(`${origin}/messaging/thread/READ/`).catch(() => undefined);
            await raceGate.assertTargetSafe().catch(() => undefined);
          }
          expect(allRequests.get('/voyager/api/unknownMessaging/conversations/UNREAD/events'), `${kind} ${delay}ms`).toBeUndefined();
          if (!target) expect(raceGate.snapshot().hardSafetyViolations).toBeGreaterThan(0);
        } finally {
          await raceGate.dispose();
          await raceContext.close();
        }
        // Closing is part of the race: keep cumulative counters and inspect
        // them after every cleanup, including the final iteration.
        const cleanupCase = `after cleanup: ${kind} ${delay}ms`;
        expect(allRequests.get('/voyager/api/unknownMessaging/conversations/UNREAD/events'), cleanupCase).toBeUndefined();
        expect(allRequests.get('/voyager/api/messagingV2/conversations/UNREAD/events'), cleanupCase).toBeUndefined();
        expect(unreadRequests, cleanupCase).toBe(0);
        expect(targetRequests.get('/messaging/thread/UNREAD/'), cleanupCase).toBeUndefined();
      }
    }
  }, 60_000);

  it('blocks a selection redirect before an unread thread receives a request', async () => {
    await reset('/selection-redirect');
    await page.goto(`${origin}/selection-redirect`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot()).toMatchObject({
      selectionPreflightGets: 1,
      selectionPreflightFailures: 1,
      selectionNavigationsAllowed: 0,
      targetNavigationsAllowed: 0,
      navigationAttemptsBlocked: 1,
    });
  });

  it.each(['img', 'prefetch', 'worker'])('safely tolerates a blocked selection thread URL used by a %s', async (resource) => {
    await reset(`/selection-${resource}`);
    await page.goto(`${origin}/selection-${resource}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    await gate!.assertSelectionSafe();
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
  });

  it.each(['iframe', 'subframe'])('keeps a blocked selection %s navigation fatal', async (resource) => {
    await reset(`/selection-${resource}`);
    await page.goto(`${origin}/selection-${resource}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();
    expect(gate!.snapshot()).toMatchObject({ crossThreadRequestsBlocked: 1, selectionSubrequestsBlocked: 0, navigationAttemptsBlocked: 1 });
    expect(gate!.snapshot().hardSafetyViolations).toBeGreaterThan(0);
  });

  it('tolerates a blocked selection History API route change while keeping the exact URL', async () => {
    await reset('/selection-history');
    await page.goto(`${origin}/selection-history`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    await gate!.assertSelectionSafe();
    expect(page.url()).toBe(`${origin}/selection-history`);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot()).toMatchObject({ selectionHistoryAttemptsBlocked: 1, hardSafetyViolations: 0 });
  });

  it.each(['location', 'popup'])('keeps selection %s escape attempts fatal', async (resource) => {
    await reset(`/selection-${resource}`);
    await page.goto(`${origin}/selection-${resource}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await expect.poll(() => gate!.snapshot().hardSafetyViolations, { timeout: 2_000 }).toBeGreaterThan(0);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot().hardSafetyViolations).toBeGreaterThan(0);
    await gate!.dispose().catch(() => undefined);
    await context.close();
    expect(unreadRequests, 'after cleanup').toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/'), 'after cleanup').toBeUndefined();
  });

  it('allows only the exact Dash conversation-list GET while selecting', async () => {
    await reset('/selection-list');
    await page.goto(`${origin}/selection-list`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    await gate!.assertSelectionSafe();
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations')).toBe(1);
  });

  it('tolerates eager denied selection messaging subrequests and can still arm one target', async () => {
    await reset('/selection-eager-messaging');
    await page.goto(`${origin}/selection-eager-messaging`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    const foreignHistory = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD';
    const unknownMessaging = '/voyager/api/messagingV2/conversations/UNREAD/events';
    expect(allRequests.get(foreignHistory)).toBeUndefined();
    expect(allRequests.get(unknownMessaging)).toBeUndefined();
    expect(gate!.snapshot()).toMatchObject({
      crossThreadRequestsBlocked: 1,
      selectionSubrequestsBlocked: 1,
      hardSafetyViolations: 0,
    });
    await gate!.assertSelectionSafe();

    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
  });

  it('blocks an allowed list GET redirect before an unknown messaging namespace reaches the server', async () => {
    redirectConversationList = true;
    const browserListResponses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('queryId=messengerConversations')) browserListResponses.push(response.url());
    });
    await reset('/selection-list');
    await page.goto(`${origin}/selection-list`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations')).toBe(1);
    expect(allRequests.get('/voyager/api/messagingV2/conversations/UNREAD/events')).toBeUndefined();
    // The unsafe isolated response is never fulfilled into the page, so the
    // selection capture cannot derive a candidate from it.
    expect(browserListResponses).toEqual([]);
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ selectionSubrequestsBlocked: 0, hardSafetyViolations: 1 });
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
  });

  it('allows one exact target request but blocks its server redirect to unread', async () => {
    await reset();
    await loadSafeSelection();
    await expect(gate!.armTarget(`${origin}/messaging/thread/READ-REDIRECT/`, ['READ-REDIRECT'])).rejects.toThrow(/preflight/);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/READ-REDIRECT/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({
      targetPreflightGets: 1,
      targetPreflightFailures: 1,
      targetNavigationsAllowed: 0,
      navigationAttemptsBlocked: 0,
    });
  });

  it.each(['READ-HEADER-LOCATION', 'READ-OVERSIZE'])('rejects an unsafe target preflight response for %s', async (targetId) => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/${targetId}/`;
    await expect(gate!.armTarget(target, [targetId])).rejects.toThrow(/preflight/);
    expect(targetRequests.get(`/messaging/thread/${targetId}/`)).toBe(1);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot()).toMatchObject({
      targetPreflightGets: 1,
      targetPreflightFailures: 1,
      targetNavigationsAllowed: 0,
      navigationAttemptsBlocked: 0,
    });
  });

  it('guards History.prototype against call and Reflect.apply bypasses', async () => {
    await reset();
    await page.goto(`${origin}/selection`, { waitUntil: 'domcontentloaded' });
    await gate!.assertSelectionSafe();
    const descriptors = await page.evaluate((foreignUrl) => {
      const push = Object.getOwnPropertyDescriptor(History.prototype, 'pushState');
      const replace = Object.getOwnPropertyDescriptor(History.prototype, 'replaceState');
      try { History.prototype.pushState.call(history, {}, '', foreignUrl); } catch { /* expected */ }
      try { Reflect.apply(History.prototype.replaceState, history, [{}, '', foreignUrl]); } catch { /* expected */ }
      return {
        pushConfigurable: push?.configurable,
        pushWritable: push?.writable,
        replaceConfigurable: replace?.configurable,
        replaceWritable: replace?.writable,
        instanceMatchesPrototype: history.pushState === History.prototype.pushState && history.replaceState === History.prototype.replaceState,
      };
    }, `${origin}/messaging/thread/UNREAD/`);
    expect(descriptors).toEqual({
      pushConfigurable: false,
      pushWritable: false,
      replaceConfigurable: false,
      replaceWritable: false,
      instanceMatchesPrototype: true,
    });
    await gate!.assertSelectionSafe();
    expect(unreadRequests).toBe(0);
    expect(page.url()).toBe(`${origin}/selection`);
    expect(gate!.snapshot()).toMatchObject({
      targetNavigationsAllowed: 0,
      navigationAttemptsBlocked: 0,
      selectionHistoryAttemptsBlocked: 2,
      hardSafetyViolations: 0,
    });
  });

  it.each(['history', 'foreign', 'location', 'popup', 'subframe', 'hash', 'prototype'])('retires selection before delayed %s code can overlap target preflight', async (fixture) => {
    await reset(`/selection-delayed-${fixture}`);
    await page.goto(`${origin}/selection-delayed-${fixture}`, { waitUntil: 'domcontentloaded' });
    await gate!.assertSelectionSafe();
    const selectionPage = page;
    const target = `${origin}/messaging/thread/READ-DELAY/`;
    page = await gate!.armTarget(target, ['READ-DELAY']);
    expect(selectionPage.isClosed()).toBe(true);
    expect(page).not.toBe(selectionPage);
    expect(page.url()).toBe('about:blank');
    expect(context.pages()).toEqual([page]);
    expect(gate!.snapshot()).toMatchObject({
      targetPreflightGets: 1,
      targetPreflightFailures: 0,
      targetNavigationsAllowed: 0,
      hardSafetyViolations: 0,
      navigationAttemptsBlocked: 0,
      popupPagesBlocked: 0,
    });
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();
    expect(targetRequests.get('/messaging/thread/READ-DELAY/')).toBe(1);
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    expect(targetRequests.get('/messaging/thread/READ-DELAY/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetNavigationsAllowed: 1, hardSafetyViolations: 0 });
    await gate!.assertTargetSafe();
  });

  it('keeps 30 zero-to-ten-millisecond selection races disjoint from the fresh target page', async () => {
    await context.close();
    gate = undefined;
    const foreignPath = '/voyager/api/messagingV2/conversations/UNREAD/events';
    const targetPath = '/messaging/thread/READ/';

    for (let index = 0; index < 30; index += 1) {
      const raceContext = await createProbeContext(browser);
      const selectionPage = await raceContext.newPage();
      const selectionUrl = `${origin}/selection`;
      const raceGate = await installProbeNavigationGate(raceContext, selectionPage, selectionUrl);
      try {
        await selectionPage.goto(selectionUrl, { waitUntil: 'domcontentloaded' });
        await raceGate.assertSelectionSafe();
        await selectionPage.evaluate(({ delay, kind, foreignUrl, unreadUrl, backUrl }) => {
          setTimeout(() => {
            if (kind === 0) {
              try { Reflect.apply(History.prototype.pushState, history, [{}, '', unreadUrl]); } catch { /* guarded */ }
              try { History.prototype.replaceState.call(history, {}, '', backUrl); } catch { /* guarded */ }
            } else if (kind === 1) {
              void fetch(foreignUrl).catch(() => undefined);
            } else {
              try { history.pushState({}, '', unreadUrl); } catch { /* guarded */ }
            }
          }, delay);
        }, {
          delay: index % 11,
          kind: index % 3,
          foreignUrl: `${origin}${foreignPath}`,
          unreadUrl: `${origin}/messaging/thread/UNREAD/`,
          backUrl: selectionUrl,
        });

        let freshTarget: Page | undefined;
        try { freshTarget = await raceGate.armTarget(`${origin}${targetPath}`, ['READ']); }
        catch { /* a pre-close violation is an expected fail-closed outcome */ }
        const beforeNavigation = raceGate.snapshot();
        expect(beforeNavigation.targetNavigationsAllowed).toBe(0);
        expect(allRequests.get(foreignPath), JSON.stringify({ index, delay: index % 11, kind: index % 3, snapshot: beforeNavigation })).toBeUndefined();
        expect(unreadRequests).toBe(0);
        expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();

        if (beforeNavigation.hardSafetyViolations > 0) {
          expect(freshTarget).toBeUndefined();
        } else {
          expect(selectionPage.isClosed()).toBe(true);
          expect(freshTarget).toBeDefined();
          expect(raceContext.pages()).toEqual([freshTarget!]);
          const preflightHits = targetRequests.get(targetPath) ?? 0;
          await freshTarget!.goto(`${origin}${targetPath}`, { waitUntil: 'domcontentloaded' });
          expect(targetRequests.get(targetPath)).toBe(preflightHits);
          await raceGate.assertTargetSafe();
          expect(raceGate.snapshot()).toMatchObject({ targetNavigationsAllowed: 1, hardSafetyViolations: 0 });
        }
        expect(!(raceGate.snapshot().targetNavigationsAllowed > 0 && raceGate.snapshot().hardSafetyViolations > 0)).toBe(true);
      } finally {
        await raceGate.dispose().catch(() => undefined);
        await raceContext.close().catch(() => undefined);
      }
      const cleanupCase = `after cleanup: iteration ${index}, delay ${index % 11}ms`;
      expect(allRequests.get(foreignPath), cleanupCase).toBeUndefined();
      expect(allRequests.get('/voyager/api/unknownMessaging/conversations/UNREAD/events'), cleanupCase).toBeUndefined();
      expect(unreadRequests, cleanupCase).toBe(0);
      expect(targetRequests.get('/messaging/thread/UNREAD/'), cleanupCase).toBeUndefined();
    }
  });

  it('treats every externally created third page as fatal and never as the internal target page', async () => {
    await reset();
    await loadSafeSelection();
    const rogue = await context.newPage();
    await page.waitForTimeout(50);
    expect(rogue.isClosed()).toBe(true);
    expect(gate!.snapshot().popupPagesBlocked).toBe(1);
    expect(gate!.snapshot().hardSafetyViolations).toBeGreaterThan(0);
    await expect(gate!.armTarget(`${origin}/messaging/thread/READ/`, ['READ'])).rejects.toThrow(/unsafe selection/);
    expect(gate!.snapshot().targetNavigationsAllowed).toBe(0);
  });

  it('fails closed for client-side location navigation', async () => {
    const target = 'READ-LOCATION';
    await reset();
    await loadSafeSelection();
    page = await gate!.armTarget(`${origin}/messaging/thread/${target}/`, [target]);
    await page.goto(`${origin}/messaging/thread/${target}/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(100);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot().targetNavigationsAllowed).toBe(1);
  });

  it('keeps a target=_blank popup from reaching the unread target', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ-POPUP/`;
    page = await gate!.armTarget(target, ['READ-POPUP']);
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await expect.poll(() => gate!.snapshot().hardSafetyViolations, { timeout: 2_000 }).toBeGreaterThan(0);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
    expect(gate!.snapshot().targetNavigationsAllowed).toBe(1);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();
    await gate!.dispose().catch(() => undefined);
    await context.close();
    expect(unreadRequests, 'after cleanup').toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/'), 'after cleanup').toBeUndefined();
  });

  it('tolerates a guarded target History API attempt when the exact URL remains unchanged', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ-HISTORY/`;
    page = await gate!.armTarget(target, ['READ-HISTORY']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
    expect(unreadRequests).toBe(0);
    expect(gate!.snapshot()).toMatchObject({ targetNavigationsAllowed: 1, hardSafetyViolations: 0 });
  });

  it('allows exactly one target navigation and blocks a cross-thread GraphQL GET', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    const browserResponse = await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(browserResponse?.headers()['set-cookie']).toBeUndefined();
    expect(browserResponse?.headers()['x-private-canary']).toBeUndefined();
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    const exactHistory = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=READ';
    await page.evaluate((url) => fetch(url), exactHistory);
    await gate!.assertTargetSafe();
    expect(allRequests.get(exactHistory)).toBe(1);
    expect(gate!.snapshot()).toMatchObject({
      targetPreflightGets: 1,
      targetPreflightFailures: 0,
      targetNavigationsAllowed: 1,
      navigationAttemptsBlocked: 0,
    });

    await page.evaluate(() => fetch('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationUrn=urn%3Ali%3AmessagingThread%3AUNREAD').catch(() => undefined));
    await page.waitForTimeout(50);
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationUrn=urn%3Ali%3AmessagingThread%3AUNREAD')).toBeUndefined();
    expect(gate!.snapshot()).toMatchObject({
      crossThreadRequestsBlocked: 1,
      selectionSubrequestsBlocked: 1,
      hardSafetyViolations: 0,
    });
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('aborts a foreign messaging subrequest before the wire while the target is armed', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    const foreignPath = '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD';
    const foreignHistory = `${origin}${foreignPath}`;
    await page.evaluate((url) => fetch(url).catch(() => undefined), foreignHistory);
    await page.waitForTimeout(50);
    expect(allRequests.get(foreignPath)).toBeUndefined();
    expect(gate!.snapshot()).toMatchObject({
      crossThreadRequestsBlocked: 1,
      selectionSubrequestsBlocked: 1,
      hardSafetyViolations: 0,
      targetNavigationsAllowed: 0,
    });
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetNavigationsAllowed: 1, navigationAttemptsBlocked: 0 });
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('keeps a pristine about:blank target isolated before consuming its target cache', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    await page.evaluate((foreignUrl) => { try { history.pushState({}, '', foreignUrl); } catch { /* expected guard */ } }, `${origin}/messaging/thread/UNREAD/`);
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetNavigationsAllowed: 1, navigationAttemptsBlocked: 0, hardSafetyViolations: 0 });
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('blocks every later wire request for the exact cached target document', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);

    await page.evaluate(() => fetch('/messaging/thread/READ/').catch(() => undefined));
    await page.waitForTimeout(50);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('allows target list and exact target history but blocks unknown REST, GraphQL and wrong references', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    const allowed = [
      '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations',
      '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=READ',
    ];
    for (const url of allowed) await page.evaluate((value) => fetch(value), url);
    await gate!.assertTargetSafe();
    for (const url of allowed) expect(allRequests.get(url), url).toBe(1);

    const blocked = [
      '/voyager/api/messaging/conversations/READ/events',
      '/voyager/api/graphql?queryId=messengerMessagesByConversation&conversationId=READ',
      '/voyager/api/voyagerMessagingGraphQL/GraphQL?queryId=messengerMessagesByConversation&conversationId=READ',
      '/voyager/api/voyagerMessagingGraphQL/graphql/?queryId=messengerMessagesByConversation&conversationId=READ',
      '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=unknownMessagingRead&conversationId=READ',
      '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation',
      '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD',
      `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', threadId: 'UNREAD' }))}`,
    ];
    await page.evaluate(async (urls) => { await Promise.all(urls.map((url) => fetch(url).catch(() => undefined))); }, blocked);
    await page.waitForTimeout(100);
    for (const url of blocked) expect(allRequests.get(url), url).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(blocked.length);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('keeps R4 namespace and identity decoys at zero server requests', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();

    const blocked = [
      '/voyager/api/messagingV2/conversations/UNREAD/events',
      '/voyager/api/graphqlV2?queryId=messengerMessagesByConversation&conversationId=UNREAD',
      '/voyager/api/voyagerMessagingGraphQLV2/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD',
      '/voyager/api/voyagerMessagingRest/conversations/UNREAD/events',
      `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', id: 'UNREAD' }))}`,
      `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent('(conversationId:READ,ids:(UNREAD))')}`,
      `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ nested: { conversationId: 'READ', ids: ['UNREAD'] } }))}`,
      `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(encodeURIComponent(JSON.stringify({ conversationId: 'READ', ids: ['UNREAD'] })))}`,
      '/voyager/api/%6dessagingV2/conversations/UNREAD/events',
      '/voyager/api/MESSAGINGcustom/conversations/UNREAD/events',
      '/voyager/api/customGraphqlV2?operationName=mailboxMessagesV2',
    ];
    await page.evaluate(async (urls) => { await Promise.all(urls.map((url) => fetch(url).catch(() => undefined))); }, blocked);
    await page.waitForTimeout(100);
    for (const url of blocked) expect(allRequests.get(url), url).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(blocked.length);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('blocks typed foreign conversation URNs hidden under unknown values before the server', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    const history = (variables: string) => `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const allowed = json({ conversationId: 'READ', payload: 'urn:li:messagingThread:READ' });
    await page.evaluate((url) => fetch(url), allowed);
    expect(allRequests.get(allowed)).toBe(1);
    await gate!.assertTargetSafe();

    const simple = 'urn:li:messagingThread:UNREAD';
    const blocked = [
      json({ conversationId: 'READ', payload: simple }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,UNREAD)' }),
      json({ conversationId: 'READ', nested: { value: 'urn:li:messengerConversation:UNREAD' } }),
      json({ conversationId: 'READ', refs: ['urn:li:fsd_profile:MEMBER', 'urn:li:fsd_messengerConversation:UNREAD'] }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: simple }))),
      history(`(conversationId:READ,payload:${simple})`),
      history(`(conversationId:READ,outer:(refs:(${simple})))`),
    ];
    await page.evaluate(async (urls) => { await Promise.all(urls.map((url) => fetch(url).catch(() => undefined))); }, blocked);
    await page.waitForTimeout(100);
    for (const url of blocked) expect(allRequests.get(url), url).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(blocked.length);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('blocks malformed and future conversation-family URNs while the known target still reaches the server once', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    const history = (variables: string) => `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const knownTarget = json({ conversationId: 'READ', payload: 'urn:li:messagingThread:READ' });
    await page.evaluate((url) => fetch(url), knownTarget);
    expect(allRequests.get(knownTarget)).toBe(1);
    await gate!.assertTargetSafe();

    const blocked = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThreadV2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingConversationV2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:conversation-v2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread:' }),
      json({ conversationId: 'READ', nested: { payload: 'urn%3Ali%3AmessagingThreadV2%3AUNREAD' } }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: 'urn:li:conversation-v2:UNREAD' }))),
      history('(conversationId:READ,payload:urn:li:messagingConversationV2:UNREAD)'),
      history('(conversationId:READ,outer:(payload:urn:li:messagingThread:))'),
    ];
    await page.evaluate(async (urls) => { await Promise.all(urls.map((url) => fetch(url).catch(() => undefined))); }, blocked);
    await page.waitForTimeout(100);
    for (const url of blocked) expect(allRequests.get(url), url).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(blocked.length);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('blocks missing-separator conversation URNs before the server without blocking benign entity families', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });

    const history = (variables: string) => `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const allowed = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread:READ' }),
      json({
        conversationId: 'READ',
        payload: [
          'urn:li:fsd_profile/UNREAD',
          'urn:li:messagingParticipant',
          'urn:li:messagingMessageV2/UNREAD',
          'urn:li:mailboxV2=UNREAD',
          'urn:li:company/UNREAD',
          'prefixurn:li:fsd_profile/UNREAD',
          'messagingThread is a plain word, not a URN',
        ],
      }),
    ];
    for (const url of allowed) await page.evaluate((candidate) => fetch(candidate), url);
    for (const url of allowed) expect(allRequests.get(url), url).toBe(1);
    await gate!.assertTargetSafe();

    const blocked = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread=UNREAD' }),
      json({ conversationId: 'READ', nested: { refs: ['urn%3Ali%3AmessagingThread%2FUNREAD'] } }),
      json({ conversationId: 'READ', payload: 'UrN:Li:MeSsAgInGtHrEaD/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThreadV3/UNREAD' }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: 'urn:li:messagingThread=UNREAD' }))),
      history('(conversationId:READ,payload:urn:li:messagingThread/UNREAD)'),
      history('(conversationId:READ,outer:(payload:urn%3Ali%3AmessagingThread%3DUNREAD))'),
      json({ conversationId: 'READ', payload: 'prefixurn:li:messagingThread/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ' }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ)/UNREAD' }),
    ];
    await page.evaluate(async (urls) => { await Promise.all(urls.map((url) => fetch(url).catch(() => undefined))); }, blocked);
    await page.waitForTimeout(100);
    for (const url of blocked) expect(allRequests.get(url), url).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(blocked.length);
    expect(gate!.snapshot().hardSafetyViolations).toBe(0);
    await expect(gate!.assertTargetSafe()).resolves.toBeUndefined();
  });

  it('keeps browser cookies unchanged across disposable selection and target preflights', async () => {
    await context.addCookies([{ name: 'authCanary', value: 'original', url: origin }]);
    await reset('/selection-cookie');
    expect(await context.cookies()).toEqual([expect.objectContaining({ name: 'authCanary', value: 'original' })]);
    const selectionResponse = await page.goto(`${origin}/selection-cookie`, { waitUntil: 'domcontentloaded' });
    await gate!.assertSelectionSafe();
    expect(selectionResponse?.headers()['set-cookie']).toBeUndefined();
    expect(requestCookies.get('/selection-cookie')).toContain('authCanary=original');
    expect(await context.cookies()).toEqual([expect.objectContaining({ name: 'authCanary', value: 'original' })]);

    const target = `${origin}/messaging/thread/READ/`;
    page = await gate!.armTarget(target, ['READ']);
    expect(requestCookies.get('/messaging/thread/READ/')).toContain('authCanary=original');
    expect(requestCookies.get('/messaging/thread/READ/')).not.toContain('selectionPrivate');
    expect(await context.cookies()).toEqual([expect.objectContaining({ name: 'authCanary', value: 'original' })]);
    const targetResponse = await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(targetResponse?.headers()['set-cookie']).toBeUndefined();
    expect(targetResponse?.headers()['x-private-canary']).toBeUndefined();
    expect(await context.cookies()).toEqual([expect.objectContaining({ name: 'authCanary', value: 'original' })]);
  });
});
