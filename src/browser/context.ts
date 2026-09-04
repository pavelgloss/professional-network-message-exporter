import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';
import type { AppConfig } from '../config.js';
import type { DiagnosticsManifest } from '../io/diagnostics.js';
import type { Logger } from '../logger.js';
import { installRequestGuard } from './request-guard.js';

export async function launchContext(config: AppConfig, mode: 'login' | 'export', manifest: DiagnosticsManifest, logger: Logger): Promise<BrowserContext> {
  await mkdir(config.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: mode === 'login' ? false : config.headless,
    serviceWorkers: mode === 'export' ? 'block' : 'allow',
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    acceptDownloads: false,
  });
  context.setDefaultTimeout(config.timeoutMs);
  if (mode === 'export') await installRequestGuard(context, manifest, logger);
  return context;
}

