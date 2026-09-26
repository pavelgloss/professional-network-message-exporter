import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createInmailWitness } from './inmail-witness.js';
import { AppError } from '../../src/errors.js';
import { parseConfig } from '../../src/config.js';
import { loadExport } from '../../src/io/export-store.js';

const witness = vi.hoisted(() => ({ current: undefined as ReturnType<typeof createInmailWitness> | undefined }));
vi.mock('../../src/linkedin/network/response-parser.js', async (original) => {
  const module = await original<typeof import('../../src/linkedin/network/response-parser.js')>();
  return { ...module, parseNetworkPayload: (...args: Parameters<typeof module.parseNetworkPayload>) => {
    const parsed = module.parseNetworkPayload(...args);
    witness.current?.observe(args[0], parsed.misses);
    return parsed;
  } };
});

// Explicit config + environment acknowledgement are both required; npm test and
// npm run check never include this file. Requires current user authorization.
it('validates fresh live InMail bodies using in-memory independent reference paths', async () => {
  if (process.env.LINKEDIN_LIVE_INMAIL_VALIDATION !== '1') throw new Error('LIVE_VALIDATION_NOT_EXPLICITLY_ENABLED');
  witness.current = createInmailWitness();
  const output = path.resolve('data/linkedin', `messages.inmail-validation-${randomUUID()}.json`);
  for (const candidate of [output, `${output}.partial`]) {
    let exists = true;
    try { await access(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw new Error('OUTPUT_CHECK_FAILED');
    }
    if (exists) throw new Error('OUTPUT_COLLISION');
  }
  // Use explicit defaults, not arbitrary env overrides (including output/baseline
  // or invalid boolean values that could leak through configuration exceptions).
  const config = parseConfig(['export', '--with-history-probe', '--limit', '100', '--output', output], {});
  config.diagnosticsContent = false;
  const counts = { info: 0, warn: 0, error: 0 };
  const logger = {
    info: () => { counts.info += 1; return true; },
    warn: () => { counts.warn += 1; return true; },
    error: () => { counts.error += 1; return true; },
  };
  const timer = setInterval(() => console.log(JSON.stringify({ liveValidationRunning: true, ...counts })), 30_000);
  try {
    const { exportMessages } = await import('../../src/linkedin/exporter.js');
    const result = await exportMessages(config, logger);
    const persisted = await loadExport(result.stats.partial ? `${output}.partial` : output);
    if (!persisted) throw new Error('VALIDATION_OUTPUT_MISSING');
    const summary = witness.current.compare(persisted);
    console.log(JSON.stringify(summary));
    // Never pass content or IDs to assertion APIs: failures must remain counts-only.
    expect(summary.passed, 'LIVE_INMAIL_BODY_EVIDENCE_INSUFFICIENT').toBe(true);
  } catch (error) {
    const safeCode = error instanceof AppError ? error.code : 'LIVE_VALIDATION_FAILED';
    console.log(JSON.stringify({ status: safeCode, ...counts }));
    // Discard original errors/stacks: Playwright and schema errors may contain data.
    throw new Error(safeCode);
  } finally {
    clearInterval(timer);
    witness.current = undefined;
  }
}, 900_000);
