// Client-side stale-while-revalidate memory cache + in-flight deduplication + route/data prefetching

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  staleAt: number;
  expiresAt: number;
}

const MAX_CLIENT_CACHE_ENTRIES = 80;
const responseCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

export interface CachedFetchOptions {
  ttlMs?: number;
  staleWhileRevalidateMs?: number;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

function setEntry<T>(key: string, data: T, ttlMs: number, swrMs: number) {
  if (responseCache.size >= MAX_CLIENT_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== undefined) responseCache.delete(oldestKey);
  }
  const now = Date.now();
  responseCache.set(key, {
    data,
    fetchedAt: now,
    staleAt: now + ttlMs,
    expiresAt: now + ttlMs + swrMs,
  });
}

export async function cachedFetchJson<T>(
  key: string,
  fetcher: (signal?: AbortSignal) => Promise<T>,
  opts: CachedFetchOptions = {}
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const swrMs = opts.staleWhileRevalidateMs ?? 60_000;
  const now = Date.now();

  if (!opts.forceRefresh) {
    const existing = responseCache.get(key) as CacheEntry<T> | undefined;
    if (existing) {
      if (now <= existing.staleAt) {
        return existing.data;
      }
      if (now <= existing.expiresAt) {
        // Return stale immediately and revalidate quietly in background
        if (!inFlightRequests.has(key)) {
          const bgPromise = fetcher()
            .then((fresh) => {
              setEntry(key, fresh, ttlMs, swrMs);
              return fresh;
            })
            .catch(() => existing.data)
            .finally(() => {
              inFlightRequests.delete(key);
            });
          inFlightRequests.set(key, bgPromise);
        }
        return existing.data;
      }
      responseCache.delete(key);
    }
  }

  const existingInFlight = !opts.forceRefresh ? (inFlightRequests.get(key) as Promise<T> | undefined) : undefined;
  if (existingInFlight) {
    if (!opts.signal) return existingInFlight;
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      existingInFlight.then(
        (res) => {
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err) => {
          opts.signal?.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  const reqPromise = fetcher(opts.signal)
    .then((fresh) => {
      setEntry(key, fresh, ttlMs, swrMs);
      return fresh;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, reqPromise);
  return reqPromise;
}

export function invalidateClientCache(prefix?: string) {
  if (!prefix) {
    responseCache.clear();
    return;
  }
  for (const k of responseCache.keys()) {
    if (k.startsWith(prefix)) {
      responseCache.delete(k);
    }
  }
}

export function prefetchPublicJson(key: string, url: string, ttlMs = 30_000) {
  const existing = responseCache.get(key);
  if (existing && Date.now() <= existing.staleAt) return;
  if (inFlightRequests.has(key)) return;

  void cachedFetchJson(
    key,
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Prefetch failed (${res.status})`);
      return res.json();
    },
    { ttlMs, staleWhileRevalidateMs: 60_000 }
  ).catch(() => {});
}
