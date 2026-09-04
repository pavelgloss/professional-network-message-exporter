import path from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { AppError } from './errors.js';

loadDotenv({ quiet: true });

export type Command = 'login' | 'export';
export type AppConfig = {
  command: Command;
  profileDir: string;
  outputPath: string;
  diagnosticsDir: string;
  limit: number;
  timeoutMs: number;
  headless: boolean;
  allowThreadOpen: boolean;
  diagnosticsContent: boolean;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new AppError('CONFIG_INVALID', `Invalid boolean value: ${value}`, 2);
}

function int(value: string | undefined, fallback: number, min: number, max: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new AppError('CONFIG_INVALID', `${label} must be an integer from ${min} to ${max}`, 2);
  return parsed;
}

function valueAfter(args: string[], name: string): string | undefined {
  const equals = args.find((a) => a.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safePath(value: string, cwd: string, label: string): string {
  const absolute = path.resolve(cwd, value);
  const parsed = path.parse(absolute);
  if (absolute === parsed.root || absolute === cwd) throw new AppError('CONFIG_INVALID', `${label} cannot be a filesystem or workspace root`, 2);
  return absolute;
}

export function parseConfig(args = process.argv.slice(2), env = process.env, cwd = process.cwd()): AppConfig {
  const command = args[0];
  if (command !== 'login' && command !== 'export') throw new AppError('CONFIG_INVALID', 'Usage: npm run login | npm run export -- [options]', 2);
  const profileDir = safePath(valueAfter(args, '--profile-dir') ?? env.LINKEDIN_PROFILE_DIR ?? '.auth/linkedin-chromium', cwd, 'profile directory');
  const outputPath = safePath(valueAfter(args, '--output') ?? env.LINKEDIN_OUTPUT ?? 'data/linkedin/messages.json', cwd, 'output path');
  const limit = int(valueAfter(args, '--limit') ?? env.LINKEDIN_LIMIT, 100, 1, 500, 'limit');
  const timeoutMs = int(valueAfter(args, '--timeout-ms') ?? env.LINKEDIN_TIMEOUT_MS, 30_000, 5_000, 300_000, 'timeout');
  return {
    command,
    profileDir,
    outputPath,
    diagnosticsDir: path.join(path.dirname(outputPath), 'diagnostics'),
    limit,
    timeoutMs,
    headless: args.includes('--headed') ? false : bool(env.LINKEDIN_HEADLESS, true),
    allowThreadOpen: args.includes('--allow-thread-open'),
    diagnosticsContent: args.includes('--diagnostics-content'),
  };
}

