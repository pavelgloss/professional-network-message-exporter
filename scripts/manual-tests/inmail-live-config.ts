import { parseConfig, type AppConfig } from '../../src/config.js';

// Manual harness only: never retry or silently downgrade a failed probe.
export function liveInmailConfig(output: string, mode: string | undefined): AppConfig {
  if (mode !== undefined && mode !== 'with-probe' && mode !== 'without-probe') {
    throw new Error('LIVE_VALIDATION_MODE_INVALID');
  }
  return parseConfig(['export', ...(mode === 'without-probe' ? [] : ['--with-history-probe']),
    '--limit', '100', '--output', output], {});
}
