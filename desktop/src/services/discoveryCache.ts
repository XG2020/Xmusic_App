/** Disposable browsing data only. User collections, downloads and artwork are stored elsewhere. */
export const DISCOVERY_CACHE_KEY = 'xmusic:discoveryCache';
export const DISCOVERY_CACHE_LIMITS = { entries: 40, bytes: 2 * 1024 * 1024 } as const;
export const DISCOVERY_TTL = {
  ranks: 10 * 60_000,
  rankTracks: 10 * 60_000,
  playlists: 10 * 60_000,
  playlistDetail: 15 * 60_000,
  categories: 24 * 60 * 60_000,
} as const;

interface CacheEntry { key: string; createdAt: number; expiresAt: number; value: unknown }
export interface DiscoveryCacheStats { entries: number; bytes: number }

const entries = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
const clearHandlers = new Set<() => void>();
let initialized = false;
let generation = 0;

function storage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
}

function serialized(): string {
  return JSON.stringify({ version: 1, entries: [...entries.values()] });
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function prune(): boolean {
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= Date.now()) { entries.delete(key); changed = true; }
  }
  while (entries.size > DISCOVERY_CACHE_LIMITS.entries) {
    entries.delete(entries.keys().next().value!);
    changed = true;
  }
  return changed;
}

function boundedSerialized(): string {
  let data = serialized();
  while (entries.size && byteLength(data) > DISCOVERY_CACHE_LIMITS.bytes) {
    entries.delete(entries.keys().next().value!);
    data = serialized();
  }
  return data;
}

function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    const raw = storage()?.getItem(DISCOVERY_CACHE_KEY);
    if (!raw || raw.length > DISCOVERY_CACHE_LIMITS.bytes || byteLength(raw) > DISCOVERY_CACHE_LIMITS.bytes) return;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 ||
        !('entries' in saved) || !Array.isArray(saved.entries)) return;
    for (const entry of saved.entries.slice(-DISCOVERY_CACHE_LIMITS.entries)) {
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || entry.key.length > 4096 ||
          !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt) || entry.createdAt > Date.now() ||
          entry.expiresAt <= Date.now() || entry.expiresAt <= entry.createdAt ||
          entry.expiresAt - entry.createdAt > DISCOVERY_TTL.categories || !Object.hasOwn(entry, 'value')) continue;
      entries.set(entry.key, entry as CacheEntry);
    }
  } catch { /* Browsing still works when storage is unavailable or contains an invalid cache. */ }
}

function notify() {
  for (const listener of listeners) {
    try { listener(); } catch { /* A subscriber cannot fail a successful music request. */ }
  }
}

function persist() {
  const data = boundedSerialized();
  try {
    if (entries.size) storage()?.setItem(DISCOVERY_CACHE_KEY, data);
    else storage()?.removeItem(DISCOVERY_CACHE_KEY);
  } catch { /* Keep the bounded memory cache if the browser storage quota is full. */ }
  notify();
}

export function discoveryServiceKey(baseUrl?: string): string {
  return baseUrl?.trim() || 'builtin';
}

/** Share in-flight reads, but never cache a rejection or let a pre-clear read repopulate storage. */
export async function cachedDiscovery<T>(
  keyParts: readonly (string | number)[],
  ttl: number,
  load: () => Promise<T>,
  accepts: (value: unknown) => value is T,
): Promise<T> {
  initialize();
  if (prune()) persist();
  const key = JSON.stringify(keyParts);
  const hit = entries.get(key);
  if (hit && hit.createdAt + ttl > Date.now() && accepts(hit.value)) {
    // Reinsert to retain frequently used entries when enforcing the count/byte bounds.
    entries.delete(key);
    entries.set(key, hit);
    return JSON.parse(JSON.stringify(hit.value)) as T;
  }
  if (hit) { entries.delete(key); persist(); }
  let request = pending.get(key) as Promise<T> | undefined;
  if (!request) {
    const startedIn = generation;
    request = Promise.resolve().then(load).then(value => {
      if (startedIn === generation && accepts(value)) {
        try {
          const snapshot: unknown = JSON.parse(JSON.stringify(value));
          const createdAt = Date.now();
          const entry = { key, value: snapshot, createdAt, expiresAt: createdAt + ttl };
          // One unusually large playlist must not evict every useful cached page.
          if (byteLength(JSON.stringify({ version: 1, entries: [entry] })) > DISCOVERY_CACHE_LIMITS.bytes) return value;
          entries.set(key, entry);
          prune();
          persist();
        } catch { /* An uncacheable result remains available to its caller. */ }
      }
      return value;
    }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
  }
  return request;
}

export function getDiscoveryCacheStats(): DiscoveryCacheStats {
  initialize();
  if (prune()) persist();
  return { entries: entries.size, bytes: entries.size ? byteLength(serialized()) : 0 };
}

export function subscribeDiscoveryCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Register another disposable interface cache, without touching user-owned storage. */
export function onDiscoveryCacheClear(clear: () => void): () => void {
  clearHandlers.add(clear);
  return () => clearHandlers.delete(clear);
}

export function clearDiscoveryCache(): void {
  initialize();
  generation += 1;
  entries.clear();
  pending.clear();
  for (const clear of clearHandlers) clear();
  try { storage()?.removeItem(DISCOVERY_CACHE_KEY); }
  catch {
    notify();
    throw new Error('内存缓存已清理，但本地浏览缓存无法移除，请稍后重试。');
  }
  notify();
}
