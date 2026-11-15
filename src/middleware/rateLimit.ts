import { NextFunction, Request, Response } from 'express';
import { cacheQueue } from '../services/cacheQueue.ts';

interface RateLimitOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
}

const buckets = new Map<string, { timestamps: number[]; lastSeen: number }>();
const MAX_LOCAL_BUCKETS = 10_000;

// Periodic background sweep prevents sliding-window memory growth under sustained DDoS/high traffic
const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [key, entry] of buckets.entries()) {
    if (entry.lastSeen < cutoff) {
      buckets.delete(key);
    }
  }
}, 60_000);
sweepTimer.unref();

export function resetRateLimits() {
  buckets.clear();
}

export function checkSlidingWindowLimit(key: string, windowMs: number, maxRequests: number): {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const windowStart = now - windowMs;
  const existing = buckets.get(key);
  const timestamps = (existing?.timestamps || []).filter((t) => t > windowStart);

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, { timestamps, lastSeen: now });
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  timestamps.push(now);
  if (!existing && buckets.size >= MAX_LOCAL_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }
  buckets.set(key, { timestamps, lastSeen: now });
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - timestamps.length),
    retryAfterSeconds: 0,
  };
}

export function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const customKey = options.keyGenerator ? options.keyGenerator(req) : ip;
    const bucketKey = `${options.name}:${customKey}`;

    const distributed = await cacheQueue.checkDistributedSlidingWindow(
      bucketKey,
      options.windowMs,
      options.maxRequests
    );
    const result = distributed || checkSlidingWindowLimit(bucketKey, options.windowMs, options.maxRequests);

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return res.status(429).json({
        error: options.message || 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    next();
  };
}
