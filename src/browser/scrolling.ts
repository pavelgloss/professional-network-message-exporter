import type { Locator } from 'playwright';

export type ScrollResult = { iterations: number; reason: 'limit' | 'stagnation' | 'timeout' };

export async function scrollUntilStable(
  container: Locator,
  count: () => Promise<number>,
  options: { target?: number; maxIterations?: number; stagnationLimit?: number; timeoutMs?: number; direction?: 'up' | 'down'; delayMs?: number } = {},
): Promise<ScrollResult> {
  const started = Date.now();
  const maxIterations = options.maxIterations ?? 60;
  const stagnationLimit = options.stagnationLimit ?? 4;
  let prior = await count();
  let stagnant = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    if (options.target !== undefined && prior >= options.target) return { iterations: i, reason: 'limit' };
    if (Date.now() - started > (options.timeoutMs ?? 60_000)) return { iterations: i, reason: 'timeout' };
    await container.evaluate((element, direction) => { element.scrollTop = direction === 'up' ? 0 : element.scrollHeight; }, options.direction ?? 'down');
    await container.page().waitForTimeout(options.delayMs ?? 700);
    const current = await count();
    stagnant = current > prior ? 0 : stagnant + 1;
    prior = current;
    if (stagnant >= stagnationLimit) return { iterations: i + 1, reason: 'stagnation' };
  }
  return { iterations: maxIterations, reason: 'timeout' };
}

