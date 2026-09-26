import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { AppError } from '../errors.js';

type Transport = { hits: number; listeners: Set<() => void> };
const transports = new WeakMap<BrowserContext, Transport>();

/** No request is ever forwarded. Playwright route bypasses terminate here. */
export async function createProbeContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const transport: Transport = { hits: 0, listeners: new Set() };
  const sockets = new Set<Socket>();
  const denied = () => {
    transport.hits += 1;
    for (const listener of transport.listeners) listener();
  };
  const server = createServer((_request, response) => {
    denied();
    response.writeHead(502, { connection: 'close', 'content-length': '0' });
    response.end();
  });
  server.on('connect', (_request, socket) => { denied(); socket.destroy(); });
  server.on('upgrade', (_request, socket) => { denied(); socket.destroy(); });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AppError('READ_POLICY_BLOCK', 'Probe transport could not bind');
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  try {
    const context = await browser.newContext({
      ...options,
      serviceWorkers: 'block', acceptDownloads: false,
      // Chromium otherwise bypasses proxies for loopback targets, including tests.
      proxy: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' },
    });
    transports.set(context, transport);
    context.once('close', close);
    await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'Read-only probe' }));
    return context;
  } catch (error) { close(); throw error; }
}

export function probeTransport(context: BrowserContext): Transport {
  const transport = transports.get(context);
  if (!transport) throw new AppError('READ_POLICY_BLOCK', 'Probe requires transport isolation before its first page', 4);
  return transport;
}
