import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { liveInmailConfig } from '../../scripts/manual-tests/inmail-live-config.js';

afterEach(() => vi.unstubAllEnvs());

it('defaults to one explicit probe and changes only that flag in passive manual mode', () => {
  const output = path.resolve('data/linkedin', 'synthetic-live-validation.json');
  const baseline = liveInmailConfig(output, undefined);
  expect(baseline).toMatchObject({ command: 'export', outputPath: output, limit: 100,
    withHistoryProbe: true, probeReadThread: false, diagnosticsContent: false });
  expect(liveInmailConfig(output, 'with-probe')).toEqual(baseline);
  expect(liveInmailConfig(output, 'without-probe')).toEqual({ ...baseline, withHistoryProbe: false });
});

it('rejects unknown manual modes with only a fixed error before export work', () => {
  for (const mode of ['', 'WITH-PROBE', 'passive', 'https://private-canary.invalid/?secret=canary']) {
    let message: string | undefined;
    try { liveInmailConfig('data/linkedin/synthetic.json', mode); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe('LIVE_VALIDATION_MODE_INVALID');
  }
});

it('ignores arbitrary product environment overrides in both manual modes', () => {
  vi.stubEnv('LINKEDIN_OUTPUT', 'private-canary');
  vi.stubEnv('LINKEDIN_LIMIT', '500');
  vi.stubEnv('LINKEDIN_HEADLESS', 'invalid-private-canary');
  vi.stubEnv('LINKEDIN_STATE_FILE', 'private-canary');
  const output = path.resolve('data/linkedin', 'synthetic-live-validation.json');
  for (const mode of ['with-probe', 'without-probe']) {
    expect(liveInmailConfig(output, mode)).toMatchObject({ outputPath: output, limit: 100,
      headless: true, statePath: path.resolve('.auth/linkedin-storage-state.json'), diagnosticsContent: false });
  }
});
