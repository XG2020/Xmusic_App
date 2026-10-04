import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type CacheModule = typeof import('./discoveryCache');
let cache: CacheModule;
let saved: Map<string, string>;
let local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const start = new Date('2026-10-02T00:00:00Z').getTime();

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.resetModules();
  saved = new Map();
  local = {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {saved.set(key, value);}),
    removeItem: vi.fn((key: string) => {saved.delete(key);}),
  };
  vi.stubGlobal('localStorage', local);
  cache = await import('./discoveryCache');
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

describe('bounded browsing cache', () => {
  it('shares concurrent reads, serves independent snapshots and reloads after the exact TTL', async () => {
    const response = deferred<string[]>();
    const load = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(['updated']);
    const first = cache.cachedDiscovery(['ranks', 'builtin'], 1000, load, strings);
    const concurrent = cache.cachedDiscovery(['ranks', 'builtin'], 1000, load, strings);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    response.resolve(['original']);
    const [value] = await Promise.all([first, concurrent]);
    value.push('caller change');
    vi.setSystemTime(start + 999);
    expect(await cache.cachedDiscovery(['ranks', 'builtin'], 1000, load, strings)).toEqual(['original']);
    vi.setSystemTime(start + 1000);
    expect(await cache.cachedDiscovery(['ranks', 'builtin'], 1000, load, strings)).toEqual(['updated']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('restores valid persistent data and keeps service/id/page keys isolated', async () => {
    const load = vi.fn().mockResolvedValue(['data']);
    for (const key of [['rank', 'a', 26], ['rank', 'b', 26], ['rank', 'a', 27], ['category', 10, 1], ['category', 10, 2]]) {
      await cache.cachedDiscovery(key, 1000, load, strings);
    }
    expect(load).toHaveBeenCalledTimes(5);
    expect(cache.getDiscoveryCacheStats().entries).toBe(5);
    vi.resetModules();
    cache = await import('./discoveryCache');
    expect(await cache.cachedDiscovery(['rank', 'a', 26], 1000, load, strings)).toEqual(['data']);
    expect(load).toHaveBeenCalledTimes(5);
    expect(cache.getDiscoveryCacheStats().entries).toBe(5);
  });

  it('shares failures without caching them and allows a later successful retry', async () => {
    const failed = deferred<string[]>();
    const firstLoad = vi.fn(() => failed.promise);
    const first = cache.cachedDiscovery(['same'], 1000, firstLoad, strings);
    const alsoFirst = cache.cachedDiscovery(['same'], 1000, firstLoad, strings);
    const settled = Promise.allSettled([first, alsoFirst]);
    failed.reject(new Error('HTTP 403'));
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(cache.getDiscoveryCacheStats()).toEqual({entries: 0, bytes: 0});
    const nextLoad = vi.fn().mockResolvedValue(['recovered']);
    expect(await cache.cachedDiscovery(['same'], 1000, nextLoad, strings)).toEqual(['recovered']);
    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(nextLoad).toHaveBeenCalledTimes(1);
  });

  it('clear invalidates in-flight writes and removes only browsing data', async () => {
    for (const name of ['xmusic:favorites', 'xmusic:playlistLibrary', 'xmusic:downloads', 'xmusic:theme']) saved.set(name, `preserve ${name}`);
    const old = deferred<string[]>();
    const oldRequest = cache.cachedDiscovery(['same'], 1000, () => old.promise, strings);
    await Promise.resolve();
    const clearOtherCache = vi.fn();
    const stop = cache.onDiscoveryCacheClear(clearOtherCache);
    const notify = vi.fn();
    const unsubscribe = cache.subscribeDiscoveryCache(notify);
    cache.clearDiscoveryCache();
    expect(clearOtherCache).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
    const fresh = deferred<string[]>();
    const freshLoad = vi.fn(() => fresh.promise);
    const freshRequest = cache.cachedDiscovery(['same'], 1000, freshLoad, strings);
    old.resolve(['stale']);
    expect(await oldRequest).toEqual(['stale']);
    const concurrentFresh = cache.cachedDiscovery(['same'], 1000, freshLoad, strings);
    fresh.resolve(['fresh']);
    expect(await Promise.all([freshRequest, concurrentFresh])).toEqual([['fresh'], ['fresh']]);
    expect(await cache.cachedDiscovery(['same'], 1000, freshLoad, strings)).toEqual(['fresh']);
    expect(freshLoad).toHaveBeenCalledTimes(1);
    for (const name of ['xmusic:favorites', 'xmusic:playlistLibrary', 'xmusic:downloads', 'xmusic:theme']) expect(saved.get(name)).toBe(`preserve ${name}`);
    expect(local.removeItem).toHaveBeenCalledWith(cache.DISCOVERY_CACHE_KEY);
    expect(vi.mocked(local.removeItem).mock.calls.every(([key]) => key === cache.DISCOVERY_CACHE_KEY)).toBe(true);
    stop(); unsubscribe();
    cache.clearDiscoveryCache();
    expect(cache.getDiscoveryCacheStats()).toEqual({entries: 0, bytes: 0});
  });

  it('a clear with no subsequent read stays empty even after the old response finishes', async () => {
    const response = deferred<string[]>();
    const request = cache.cachedDiscovery(['old'], 1000, () => response.promise, strings);
    await Promise.resolve();
    cache.clearDiscoveryCache();
    response.resolve(['old']);
    await request;
    expect(saved.has(cache.DISCOVERY_CACHE_KEY)).toBe(false);
    expect(cache.getDiscoveryCacheStats()).toEqual({entries: 0, bytes: 0});
  });

  it('bounds entry count and stored bytes while declining an oversized result without evicting useful data', async () => {
    for (let index = 0; index < 45; index += 1) await cache.cachedDiscovery(['small', index], 1000, async () => [String(index)], strings);
    expect(cache.getDiscoveryCacheStats().entries).toBe(cache.DISCOVERY_CACHE_LIMITS.entries);
    for (let index = 0; index < 7; index += 1) await cache.cachedDiscovery(['large', index], 1000, async () => ['x'.repeat(400_000)], strings);
    expect(cache.getDiscoveryCacheStats().bytes).toBeLessThanOrEqual(cache.DISCOVERY_CACHE_LIMITS.bytes);
    expect(new TextEncoder().encode(saved.get(cache.DISCOVERY_CACHE_KEY)).byteLength).toBeLessThanOrEqual(cache.DISCOVERY_CACHE_LIMITS.bytes);
    const before = cache.getDiscoveryCacheStats();
    const huge = ['x'.repeat(cache.DISCOVERY_CACHE_LIMITS.bytes + 1)];
    expect(await cache.cachedDiscovery(['oversized'], 1000, async () => huge, strings)).toBe(huge);
    expect(cache.getDiscoveryCacheStats()).toEqual(before);
  });

  it('ignores damaged, expired or wrong-shaped persistent values and can still cache in memory when storage is full', async () => {
    saved.set(cache.DISCOVERY_CACHE_KEY, JSON.stringify({version: 1, entries: [
      {key: '["expired"]', value: ['expired'], createdAt: start - 2000, expiresAt: start - 1},
      {key: '["invalid"]', value: {wrong: true}, createdAt: start, expiresAt: start + 1000},
    ]}));
    const load = vi.fn().mockResolvedValue(['valid']);
    expect(await cache.cachedDiscovery(['invalid'], 1000, load, strings)).toEqual(['valid']);
    expect(cache.getDiscoveryCacheStats().entries).toBe(1);
    vi.mocked(local.setItem).mockImplementation(() => {throw new Error('QuotaExceededError');});
    expect(await cache.cachedDiscovery(['memory'], 1000, load, strings)).toEqual(['valid']);
    expect(await cache.cachedDiscovery(['memory'], 1000, load, strings)).toEqual(['valid']);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
