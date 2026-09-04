import path from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { AppError } from './errors.js';

loadDotenv({ quiet: true });

export type Command = 'login' | 'export';
export type AppConfig = {
  command: Command;
  statePath: string;
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

type ParsedArgs = { values: Map<string, string>; flags: Set<string> };
function parseArguments(args: string[], command: Command): ParsedArgs {
  const valueOptions = new Set(command === 'login' ? ['--state-file', '--timeout-ms'] : ['--state-file', '--output', '--limit', '--timeout-ms']);
  const booleanOptions = new Set(command === 'login' ? [] : ['--headed', '--allow-thread-open', '--diagnostics-content']);
  const parsed: ParsedArgs = { values: new Map(), flags: new Set() };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf('=');
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    if (booleanOptions.has(name)) {
      if (equals >= 0) throw new AppError('CONFIG_INVALID', `Boolean option does not accept a value: ${name}`, 2);
      if (parsed.flags.has(name)) throw new AppError('CONFIG_INVALID', `Duplicate option: ${name}`, 2);
      parsed.flags.add(name);
      continue;
    }
    if (valueOptions.has(name)) {
      if (parsed.values.has(name)) throw new AppError('CONFIG_INVALID', `Duplicate option: ${name}`, 2);
      const value = equals >= 0 ? argument.slice(equals + 1) : args[++index];
      if (!value || value.startsWith('--')) throw new AppError('CONFIG_INVALID', `Missing value for option: ${name}`, 2);
      parsed.values.set(name, value);
      continue;
    }
    if (argument.startsWith('--')) throw new AppError('CONFIG_INVALID', `Unknown option: ${name}`, 2);
    throw new AppError('CONFIG_INVALID', `Unexpected argument: ${argument}`, 2);
  }
  return parsed;
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
  const parsed = parseArguments(args, command);
  const statePath = safePath(parsed.values.get('--state-file') ?? env.LINKEDIN_STATE_FILE ?? '.auth/linkedin-storage-state.json', cwd, 'session state file');
  const outputPath = safePath(parsed.values.get('--output') ?? env.LINKEDIN_OUTPUT ?? 'data/linkedin/messages.json', cwd, 'output path');
  const limit = int(parsed.values.get('--limit') ?? env.LINKEDIN_LIMIT, 100, 1, 500, 'limit');
  const timeoutMs = int(parsed.values.get('--timeout-ms') ?? env.LINKEDIN_TIMEOUT_MS, 30_000, 5_000, 300_000, 'timeout');
  return {
    command,
    statePath,
    outputPath,
    diagnosticsDir: path.join(path.dirname(outputPath), 'diagnostics'),
    limit,
    timeoutMs,
    headless: parsed.flags.has('--headed') ? false : bool(env.LINKEDIN_HEADLESS, true),
    allowThreadOpen: parsed.flags.has('--allow-thread-open'),
    diagnosticsContent: parsed.flags.has('--diagnostics-content'),
  };
}
