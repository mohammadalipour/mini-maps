import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/ttl-cache.js';

describe('TtlCache', () => {
  it('reuses a value until it expires', async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 10, () => now);
    const load = vi.fn(async () => 42);

    await cache.getOrLoad('k', load);
    now = 999;
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(1);

    now = 1000;
    await cache.getOrLoad('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TtlCache<number>(1000);
    const load = vi.fn(() => new Promise<number>((resolve) => setTimeout(() => resolve(1), 5)));

    const results = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(results).toEqual([1, 1, 1]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1000);
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(7);

    await expect(cache.getOrLoad('k', load)).rejects.toThrow('boom');
    await expect(cache.getOrLoad('k', load)).resolves.toBe(7);
  });

  it('evicts the oldest entry when full', async () => {
    const cache = new TtlCache<string>(1000, 2);
    const load = vi.fn(async () => 'v');
    await cache.getOrLoad('a', load);
    await cache.getOrLoad('b', load);
    await cache.getOrLoad('c', load);
    await cache.getOrLoad('a', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
