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
  let allRequests = new Map<string, number>();
  let requestCookies = new Map<string, string>();
  let redirectConversationList = false;

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
      if (request.url === '/worker.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end("fetch('/messaging/thread/UNREAD/').catch(()=>{})");
        return;
      }
      if (redirectConversationList && request.url === '/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations') {
        response.writeHead(302, { location: '/voyager/api/messagingV2/conversations/UNREAD/events' });
        response.end();
        return;
      }
      if (request.url?.startsWith('/voyager/api/')) {
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
        '/selection-worker': '<script>new Worker("/worker.js")</script>',
        '/selection-list': '<script>fetch("/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations").catch(()=>{})</script>',
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
    expect(gate!.snapshot()).toMatchObject({ selectionPreflightGets: 1, selectionNavigationsAllowed: 0, targetNavigationsAllowed: 0, navigationAttemptsBlocked: 1 });
  });

  it.each(['img', 'iframe', 'prefetch', 'subframe', 'worker'])('blocks a thread URL used by a %s before it reaches the server', async (resource) => {
    await reset(`/selection-${resource}`);
    await page.goto(`${origin}/selection-${resource}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/UNREAD/')).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBeGreaterThan(0);
  });

  it('allows only the exact Dash conversation-list GET while selecting', async () => {
    await reset('/selection-list');
    await page.goto(`${origin}/selection-list`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    await gate!.assertSelectionSafe();
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations')).toBe(1);
  });

  it('blocks an allowed list GET redirect before an unknown messaging namespace reaches the server', async () => {
    redirectConversationList = true;
    await reset('/selection-list');
    await page.goto(`${origin}/selection-list`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations')).toBe(1);
    expect(allRequests.get('/voyager/api/messagingV2/conversations/UNREAD/events')).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    await expect(gate!.assertSelectionSafe()).rejects.toThrow(/exact safe target/);
  });

  it('allows one exact target request but blocks its server redirect to unread', async () => {
    await reset();
    await loadSafeSelection();
    await expect(gate!.armTarget(`${origin}/messaging/thread/READ-REDIRECT/`, ['READ-REDIRECT'])).rejects.toThrow(/preflight/);
    expect(unreadRequests).toBe(0);
    expect(targetRequests.get('/messaging/thread/READ-REDIRECT/')).toBe(1);
    expect(gate!.snapshot()).toMatchObject({ targetPreflightGets: 1, targetNavigationsAllowed: 0, navigationAttemptsBlocked: 1 });
  });

  it.each(['READ-HEADER-LOCATION', 'READ-OVERSIZE'])('rejects an unsafe target preflight response for %s', async (targetId) => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/${targetId}/`;
    await expect(gate!.armTarget(target, [targetId])).rejects.toThrow(/preflight/);
    expect(targetRequests.get(`/messaging/thread/${targetId}/`)).toBe(1);
    expect(unreadRequests).toBe(0);
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

    await page.evaluate(() => fetch('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationUrn=urn%3Ali%3AmessagingThread%3AUNREAD').catch(() => undefined));
    await page.waitForTimeout(50);
    expect(allRequests.get('/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessagesByConversation&conversationUrn=urn%3Ali%3AmessagingThread%3AUNREAD')).toBeUndefined();
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('blocks every later wire request for the exact cached target document', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await gate!.assertTargetSafe();
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);

    await page.evaluate(() => fetch('/messaging/thread/READ/').catch(() => undefined));
    await page.waitForTimeout(50);
    expect(targetRequests.get('/messaging/thread/READ/')).toBe(1);
    expect(gate!.snapshot().crossThreadRequestsBlocked).toBe(1);
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('allows target list and exact target history but blocks unknown REST, GraphQL and wrong references', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
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
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('keeps R4 namespace and identity decoys at zero server requests', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
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
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('blocks typed foreign conversation URNs hidden under unknown values before the server', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
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
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('blocks malformed and future conversation-family URNs while the known target still reaches the server once', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
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
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
  });

  it('blocks missing-separator conversation URNs before the server without blocking benign entity families', async () => {
    await reset();
    await loadSafeSelection();
    const target = `${origin}/messaging/thread/READ/`;
    await gate!.armTarget(target, ['READ']);
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
    await expect(gate!.assertTargetSafe()).rejects.toThrow(/exact safe target/);
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
    await gate!.armTarget(target, ['READ']);
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
