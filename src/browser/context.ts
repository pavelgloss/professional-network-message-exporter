import { chromium, type BrowserContext } from 'playwright';
import type { AppConfig } from '../config.js';
import { loadStorageState } from '../auth/session.js';
import type { DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import { installRequestGuard } from './request-guard.js';
import { createProbeContext } from './probe-transport.js';

type LaunchOptions = { headless?: boolean; probe?: boolean };

export async function launchContext(config: AppConfig, mode: 'login' | 'export', manifest: DiagnosticsManifest, logger: Logger, options: LaunchOptions = {}): Promise<BrowserContext> {
  // Read and validate secret state before launching a browser. Missing state cannot
  // accidentally trigger a request to LinkedIn.
  const storageState = mode === 'export' ? await loadStorageState(config.statePath) : undefined;
  const browser = await chromium.launch({ headless: options.headless ?? (mode === 'login' ? false : config.headless) });
  try {
    const createContext = options.probe ? createProbeContext.bind(null, browser) : browser.newContext.bind(browser);
    const context = await createContext({
      ...(storageState ? { storageState } : {}),
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      acceptDownloads: false,
    });
    context.setDefaultTimeout(config.timeoutMs);
    if (mode === 'export') await installRequestGuard(context, manifest, logger);
    return context;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function closeContext(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
