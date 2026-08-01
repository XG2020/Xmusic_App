import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * API 响应缓存：内存 Map 优先，AsyncStorage 持久化兜底（重启后仍有效），
 * 带 TTL 过期，减少对服务器的重复请求。
 */

type Entry = {v: any; e: number}; // value / 过期时间戳(ms)

const PREFIX = 'apicache:';
const mem = new Map<string, Entry>();

/** 空结果（null/undefined/空数组）不缓存，避免接口偶发空响应被固化 */
function isEmpty(v: any) {
  return v == null || (Array.isArray(v) && v.length === 0);
}

/**
 * 读缓存，未命中或过期时调用 fetcher 并写入缓存。
 * fetcher 抛错时不缓存，错误原样抛出。
 */
export async function cachedGet<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const m = mem.get(key);
  if (m && m.e > now) {
    return m.v as T;
  }
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (raw) {
      const ent = JSON.parse(raw) as Entry;
      if (ent.e > now) {
        mem.set(key, ent);
        return ent.v as T;
      }
      AsyncStorage.removeItem(PREFIX + key).catch(() => {});
    }
  } catch (e) {
    // 读缓存失败当作未命中
  }
  const v = await fetcher();
  if (!isEmpty(v)) {
    const ent: Entry = {v, e: now + ttlMs};
    mem.set(key, ent);
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(ent)).catch(() => {});
  }
  return v;
}

/** 丢弃指定键的缓存（内存+持久化），供下拉刷新等强制重拉场景使用 */
export function dropCache(key: string) {
  mem.delete(key);
  AsyncStorage.removeItem(PREFIX + key).catch(() => {});
}

/**
 * 给已有缓存条目续期（内存+持久化），无条目时不做任何事。
 * 供「收藏歌单」等需要把短 TTL 缓存升级为长缓存的场景使用。
 */
export async function cacheTouch(key: string, ttlMs: number) {
  const e = Date.now() + ttlMs;
  const m = mem.get(key);
  if (m) {
    m.e = e;
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(m)).catch(() => {});
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (raw) {
      const ent = JSON.parse(raw) as Entry;
      ent.e = e;
      mem.set(key, ent);
      AsyncStorage.setItem(PREFIX + key, JSON.stringify(ent)).catch(() => {});
    }
  } catch (err) {
    // 续期失败不影响功能，下次打开会重新拉取
  }
}

/**
 * 批量读缓存（不触发请求）：返回命中的 key->值 映射，未命中/过期的不含在内。
 * 供按 mid 粒度缓存播放直链等「批量键」场景使用。
 */
export async function cachePeekMany<T>(keys: string[]): Promise<Map<string, T>> {
  const now = Date.now();
  const out = new Map<string, T>();
  const missing: string[] = [];
  for (const k of keys) {
    const m = mem.get(k);
    if (m && m.e > now) {
      out.set(k, m.v as T);
    } else {
      missing.push(k);
    }
  }
  if (missing.length) {
    try {
      const pairs = await AsyncStorage.multiGet(missing.map(k => PREFIX + k));
      for (const [pk, raw] of pairs) {
        if (!raw) {
          continue;
        }
        const ent = JSON.parse(raw) as Entry;
        const k = pk.slice(PREFIX.length);
        if (ent.e > now) {
          mem.set(k, ent);
          out.set(k, ent.v as T);
        } else {
          AsyncStorage.removeItem(pk).catch(() => {});
        }
      }
    } catch (e) {
      // 读缓存失败当作未命中
    }
  }
  return out;
}

/** 批量写缓存（内存 + 持久化），空值跳过 */
export function cachePutMany(entries: Array<[string, any]>, ttlMs: number) {
  const e = Date.now() + ttlMs;
  const kv: Array<[string, string]> = [];
  for (const [k, v] of entries) {
    if (isEmpty(v)) {
      continue;
    }
    const ent: Entry = {v, e};
    mem.set(k, ent);
    kv.push([PREFIX + k, JSON.stringify(ent)]);
  }
  if (kv.length) {
    AsyncStorage.multiSet(kv).catch(() => {});
  }
}

/** 清空全部 API 缓存（内存 + 持久化） */
export async function clearApiCache() {
  mem.clear();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter(k => k.startsWith(PREFIX));
    if (targets.length) {
      await AsyncStorage.multiRemove(targets);
    }
  } catch (e) {
    // 忽略清理失败
  }
}

/** API 持久化缓存占用的字节数（按 JSON 字符长度估算） */
export async function getApiCacheBytes(): Promise<number> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(k =>
      k.startsWith(PREFIX),
    );
    if (!keys.length) {
      return 0;
    }
    const pairs = await AsyncStorage.multiGet(keys);
    return pairs.reduce((sum, [k, v]) => sum + k.length + (v?.length ?? 0), 0);
  } catch (e) {
    return 0;
  }
}
