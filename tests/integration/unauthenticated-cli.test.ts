import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/linkedin/exporter.js', async () => {
  const { AppError } = await vi.importActual<typeof import('../../src/errors.js')>('../../src/errors.js');
  return { exportMessages: vi.fn().mockRejectedValue(new AppError('AUTH_REQUIRED', 'LinkedIn session is missing or expired. Run: npm run login', 3)) };
});

describe('unauthenticated CLI', () => {
  it('returns AUTH_REQUIRED exit code without attempting an export write', async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write);
    const { main } = await import('../../src/cli.js');
    expect(await main(['export'])).toBe(3);
    write.mockRestore();
    expect(chunks.join('')).toContain('AUTH_REQUIRED');
    expect(chunks.join('')).toContain('npm run login');
  });
});
