import { NextFunction, Request, Response } from 'express';

interface RateLimitOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
}

const buckets = new Map<string, number[]>();

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
  const timestamps = (buckets.get(key) || []).filter((t) => t > windowStart);

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, timestamps);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - timestamps.length),
    retryAfterSeconds: 0,
  };
}

export function createRateLimiter(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const customKey = options.keyGenerator ? options.keyGenerator(req) : ip;
    const bucketKey = `${options.name}:${customKey}`;
    const result = checkSlidingWindowLimit(bucketKey, options.windowMs, options.maxRequests);

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
