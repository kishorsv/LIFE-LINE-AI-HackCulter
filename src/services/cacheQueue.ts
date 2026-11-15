import crypto from 'node:crypto';
import Redis from 'ioredis';

const MAX_MEMORY_CACHE_ENTRIES = 1000;
const MAX_LOCAL_DEDUP_IDS = 5000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export interface BackgroundJob<T = Record<string, unknown>> {
  id: string;
  type: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  createdAt: string;
  lastError?: string;
}

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

class CacheQueueRuntime {
  private redis: Redis | null = null;
  private redisSub: Redis | null = null;
  private redisReady = false;
  private memoryCache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  private handlers = new Map<string, JobHandler>();
  private pendingJobs: BackgroundJob[] = [];
  private activeWorkers = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private retriedJobs = 0;
  private workerTimer: ReturnType<typeof setInterval> | null = null;

  private seenBusEventIds = new Set<string>();
  private busHandlers = new Map<string, Set<(msg: string) => void>>();

  constructor() {
    const redisUrl = (process.env.REDIS_URL || '').trim();
    if (redisUrl) {
      this.initRedis(redisUrl);
    }
    this.workerTimer = setInterval(() => {
      void this.processDueJobs();
    }, 1000);
    this.workerTimer.unref();
  }

  private initRedis(url: string) {
    try {
      const commonOpts = {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 250, 5000),
      };
      this.redis = new Redis(url, commonOpts);
      this.redisSub = new Redis(url, commonOpts);

      this.redis.on('ready', () => {
        this.redisReady = true;
      });
      this.redis.on('error', () => {
        this.redisReady = false;
      });
      this.redis.on('end', () => {
        this.redisReady = false;
      });

      this.redisSub.on('message', (channel, message) => {
        const listeners = this.busHandlers.get(channel);
        if (!listeners) return;
        for (const fn of listeners) {
          try {
            fn(message);
          } catch {
            // ignore subscriber handler error
          }
        }
      });
      this.redisSub.on('error', () => {
        // non-fatal fallback to local mode
      });
    } catch {
      this.redis = null;
      this.redisSub = null;
      this.redisReady = false;
    }
  }

  isRedisActive(): boolean {
    return Boolean(this.redis && this.redisReady);
  }

  // Strictly for non-sensitive, non-user-private shared data (e.g., support directory, public clusters, aggregate analytics)
  async getCachedJson<T>(key: string): Promise<T | null> {
    if (this.isRedisActive() && this.redis) {
      try {
        const raw = await this.redis.get(`cache:${key}`);
        if (raw) {
          this.cacheHits++;
          return JSON.parse(raw) as T;
        }
      } catch {
        // fall through to memory cache
      }
    }

    const hit = this.memoryCache.get(key);
    if (!hit) {
      this.cacheMisses++;
      return null;
    }
    if (Date.now() > hit.expiresAt) {
      this.memoryCache.delete(key);
      this.cacheMisses++;
      return null;
    }
    // Refresh insertion order for LRU behavior
    this.memoryCache.delete(key);
    this.memoryCache.set(key, hit);
    this.cacheHits++;
    return JSON.parse(hit.value) as T;
  }

  async setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const ttl = Math.max(1, Math.round(ttlSeconds));

    if (this.isRedisActive() && this.redis) {
      try {
        await this.redis.setex(`cache:${key}`, ttl, serialized);
      } catch {
        // continue to populate local fallback cache
      }
    }

    if (this.memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.memoryCache.delete(oldestKey);
      }
    }
    this.memoryCache.set(key, {
      value: serialized,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async invalidateCachePrefix(prefix: string): Promise<void> {
    for (const k of this.memoryCache.keys()) {
      if (k.startsWith(prefix)) {
        this.memoryCache.delete(k);
      }
    }
    if (this.isRedisActive() && this.redis) {
      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `cache:${prefix}*`, 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } while (cursor !== '0');
      } catch {
        // ignore redis scan errors
      }
    }
  }

  async checkDistributedSlidingWindow(
    key: string,
    windowMs: number,
    maxRequests: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number } | null> {
    if (!this.isRedisActive() || !this.redis) return null;
    try {
      const now = Date.now();
      const windowStart = now - windowMs;
      const member = `${now}-${crypto.randomUUID()}`;
      const redisKey = `rl:${key}`;

      const pipeline = this.redis.multi();
      pipeline.zremrangebyscore(redisKey, 0, windowStart);
      pipeline.zcard(redisKey);
      pipeline.zadd(redisKey, now, member);
      pipeline.pexpire(redisKey, windowMs + 1000);
      const res = await pipeline.exec();
      const currentCount = Number(res?.[1]?.[1] ?? 0);

      if (currentCount >= maxRequests) {
        await this.redis.zrem(redisKey, member);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - (currentCount + 1)),
        retryAfterSeconds: 0,
      };
    } catch {
      return null;
    }
  }

  // Pub/Sub for multi-instance WebSocket scaling
  async subscribeBus(channel: string, handler: (message: string) => void): Promise<void> {
    let set = this.busHandlers.get(channel);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.busHandlers.set(channel, set);
    }
    set.add(handler);

    if (isNew && this.redisSub) {
      try {
        await this.redisSub.subscribe(channel);
      } catch {
        // local bus still works
      }
    }
  }

  async publishBus(channel: string, payload: Record<string, unknown>): Promise<void> {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId : crypto.randomUUID();
    const wrapped = JSON.stringify({ ...payload, eventId });
    if (this.isRedisActive() && this.redis) {
      try {
        await this.redis.publish(channel, wrapped);
        return;
      } catch {
        // fall through to local handlers
      }
    }
    const listeners = this.busHandlers.get(channel);
    if (!listeners) return;
    for (const fn of listeners) {
      try {
        fn(wrapped);
      } catch {
        // ignore handler error
      }
    }
  }

  markEventSeen(eventId: string): boolean {
    if (this.seenBusEventIds.has(eventId)) return false;
    if (this.seenBusEventIds.size >= MAX_LOCAL_DEDUP_IDS) {
      const oldest = this.seenBusEventIds.values().next().value;
      if (oldest !== undefined) this.seenBusEventIds.delete(oldest);
    }
    this.seenBusEventIds.add(eventId);
    return true;
  }

  // Background reliable retry job queue (never delays primary SOS DB persistence)
  registerJobHandler(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueueJob(type: string, payload: Record<string, unknown>, opts?: { delayMs?: number; maxAttempts?: number }): string {
    const id = `job_${crypto.randomUUID()}`;
    const job: BackgroundJob = {
      id,
      type,
      payload,
      attempts: 0,
      maxAttempts: opts?.maxAttempts ?? 4,
      nextRunAt: Date.now() + (opts?.delayMs ?? 0),
      createdAt: new Date().toISOString(),
    };
    this.pendingJobs.push(job);
    return id;
  }

  private async processDueJobs() {
    if (this.pendingJobs.length === 0 || this.activeWorkers >= 4) return;
    const now = Date.now();
    const idx = this.pendingJobs.findIndex((j) => j.nextRunAt <= now);
    if (idx === -1) return;

    const [job] = this.pendingJobs.splice(idx, 1);
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.failedJobs++;
      return;
    }

    this.activeWorkers++;
    job.attempts++;
    try {
      await handler(job.payload);
      this.completedJobs++;
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      if (job.attempts < job.maxAttempts) {
        const backoffMs = Math.min(30_000, 1500 * Math.pow(2, job.attempts - 1));
        job.nextRunAt = Date.now() + backoffMs + Math.round(Math.random() * 500);
        this.pendingJobs.push(job);
        this.retriedJobs++;
      } else {
        this.failedJobs++;
      }
    } finally {
      this.activeWorkers--;
    }
  }

  getStats() {
    return {
      backend: (this.isRedisActive() ? 'redis' : 'memory') as 'redis' | 'memory',
      redisConnected: this.isRedisActive(),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      queueDepth: this.pendingJobs.length,
      activeWorkers: this.activeWorkers,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      retriedJobs: this.retriedJobs,
    };
  }

  clearAllForTests() {
    this.memoryCache.clear();
    this.pendingJobs = [];
    this.seenBusEventIds.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.completedJobs = 0;
    this.failedJobs = 0;
    this.retriedJobs = 0;
  }

  async close() {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    try {
      await this.redisSub?.quit();
    } catch {
      // ignore
    }
    try {
      await this.redis?.quit();
    } catch {
      // ignore
    }
  }
}

export const cacheQueue = new CacheQueueRuntime();
