import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createManifest } from '../io/diagnostics.js';
import { launchContext } from '../browser/context.js';
import { detectAuthState } from '../linkedin/auth-check.js';
import { saveStorageState } from './session.js';
import { closeContext } from '../browser/context.js';

export async function login(config: AppConfig, logger: Logger): Promise<void> {
  const context = await launchContext(config, 'login', createManifest(), logger);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    logger.info('login-browser-opened', { instruction: 'Complete login directly in the browser. Credentials are never read by this program.' });
    const deadline = Date.now() + Math.max(config.timeoutMs, 10 * 60_000);
    while (Date.now() < deadline) {
      if (await detectAuthState(page) === 'authenticated') {
        await saveStorageState(context, config.statePath);
        logger.info('session-ready');
        return;
      }
      await page.waitForTimeout(1_000);
    }
    throw new Error('Login timed out; run npm run login again.');
  } finally {
    await closeContext(context);
  }
}
