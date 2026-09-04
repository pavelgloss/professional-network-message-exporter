import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/linkedin/exporter.js', async () => {
  const { AppError } = await vi.importActual<typeof import('../../src/errors.js')>('../../src/errors.js');
  return { exportMessages: vi.fn().mockRejectedValue(new AppError('AUTH_REQUIRED', 'LinkedIn session is missing or expired. Run: npm.cmd run login', 3)) };
});

describe('unauthenticated CLI', () => {
  it('returns AUTH_REQUIRED exit code without attempting an export write', async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const { main } = await import('../../src/cli.js');
    expect(await main(['export'])).toBe(3);
    write.mockRestore();
    expect(chunks.join('')).toContain('AUTH_REQUIRED');
    expect(chunks.join('')).toContain('npm.cmd run login');
  });

  it('returns exit 5 for a partial candidate', async () => {
    const exporter = await import('../../src/linkedin/exporter.js');
    vi.mocked(exporter.exportMessages).mockResolvedValueOnce({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      account: { id: 'me', name: 'Me' },
      stats: { requestedConversationLimit: 100, exportedConversationCount: 0, exportedMessageCount: 0, partial: true, warnings: ['INCOMPLETE'] },
      conversations: [],
    });
    const chunks: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const { main } = await import('../../src/cli.js');
    expect(await main(['export'])).toBe(5);
    write.mockRestore();
    expect(chunks.join('')).toContain('PARTIAL_EXPORT');
    expect(chunks.join('')).toContain('messages.json.partial');
  });

  it('npm.cmd preserves space-separated options and the CLI rejects unknown ones', () => {
    if (process.platform !== 'win32') return;
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run export -- --limit 17 --profile-dir C:\\Temp\\linkedin-cli-profile --definitely-unknown'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Unknown option: --definitely-unknown');
  });
});
