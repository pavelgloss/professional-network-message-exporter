#!/usr/bin/env node
import { parseConfig } from './config.js';
import { AppError } from './errors.js';
import { createLogger } from './logger.js';
import { login } from './auth/login.js';
import { exportMessages } from './linkedin/exporter.js';
import { probeReadThread } from './linkedin/probe.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function main(args = process.argv.slice(2)): Promise<number> {
  const logger = createLogger();
  try {
    const config = parseConfig(args);
    if (config.command === 'login') await login(config, logger);
    else {
      if (config.probeReadThread) {
        logger.warn('read-state-warning', { message: 'Probe opens exactly one network-confirmed already-read thread and saves redacted GET query metadata only.' });
        await probeReadThread(config, logger);
        return 0;
      }
      const result = await exportMessages(config, logger);
      if (result.stats.partial) {
        logger.error('PARTIAL_EXPORT', { message: `Coverage is incomplete. Candidate saved to ${config.outputPath}.partial; the last complete export was not changed.`, warnings: result.stats.warnings });
        return 5;
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      logger.error(error.code, { message: error.message });
      return error.exitCode;
    }
    logger.error('UNEXPECTED_ERROR', { message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
