import type { NextFunction, Request, Response } from 'express';

export interface SystemAlert {
  id: string;
  severity: 'warning' | 'critical';
  title: string;
  message: string;
  value: string;
  threshold: string;
  triggeredAt: string;
}

export interface MonitoringSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  nodeVersion: string;
  process: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    cpuPercent: number;
    eventLoopLagMs: number;
  };
  http: {
    inFlight: number;
    totalRequests: number;
    rpsLast60s: number;
    error5xxCount: number;
    errorRatePercent: number;
    rateLimited429Count: number;
    overload503Count: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  };
  database: {
    dialect: string;
    ok: boolean;
    healthLatencyMs: number;
    avgQueryLatencyMs: number;
    p95QueryLatencyMs: number;
    slowQueryCount: number;
    slowestQueryMs: number;
    pool: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      maxConnections: number;
    };
  };
  webVitals: {
    sampleCount: number;
    lcpP75Ms: number;
    inpP75Ms: number;
    clsP75: number;
    ttfbP75Ms: number;
    lastReportedAt: string | null;
  };
  websockets: {
    realtimeActive: number;
    liveVoiceActive: number;
    maxRealtimeCapacity: number;
    maxLiveCapacity: number;
    rateLimitedMessages: number;
    pubsubMode: 'redis' | 'local';
  };
  cacheAndQueue: {
    backend: 'redis' | 'memory';
    redisConnected: boolean;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRatePercent: number;
    queueDepth: number;
    activeWorkers: number;
    completedJobs: number;
    failedJobs: number;
    retriedJobs: number;
  };
  ai: {
    configured: boolean;
    circuitState: 'closed' | 'open' | 'half-open';
    inFlight: number;
    maxConcurrency: number;
    totalCalls: number;
    fallbackCalls: number;
    quotaExceededCount: number;
    avgLatencyMs: number;
  };
  sos: {
    totalCreated: number;
    deduplicatedCount: number;
    externalConfirmed: number;
    externalFailed: number;
    lastDeliveryAt: string | null;
  };
  alerts: SystemAlert[];
}

const MAX_LATENCY_SAMPLES = 2048;
const MAX_DB_SAMPLES = 512;
const MAX_VITAL_SAMPLES = 256;
const MAX_RPS_BUCKET_SECONDS = 60;
const SLOW_QUERY_THRESHOLD_MS = Math.max(25, Number(process.env.SLOW_QUERY_THRESHOLD_MS || 100));

class MetricsRegistry {
  private startedAt = Date.now();
  private inFlight = 0;
  private totalRequests = 0;
  private error5xxCount = 0;
  private rateLimited429Count = 0;
  private overload503Count = 0;
  private httpLatencies: number[] = [];
  private dbLatencies: number[] = [];
  private slowQueryCount = 0;
  private slowestQueryMs = 0;
  private lastSlowQueryWarnAt = 0;
  private rpsBuckets = new Map<number, number>();

  private lcpSamples: number[] = [];
  private inpSamples: number[] = [];
  private clsSamples: number[] = [];
  private ttfbSamples: number[] = [];
  private webVitalsSampleCount = 0;
  private lastWebVitalAt: string | null = null;

  private lastCpuUsage = process.cpuUsage();
  private lastCpuCheckMs = Date.now();
  private lastCpuPercent = 0;
  private eventLoopLagMs = 0;

  private wsRateLimitedMessages = 0;
  private aiTotalCalls = 0;
  private aiFallbackCalls = 0;
  private aiQuotaExceededCount = 0;
  private aiLatencySumMs = 0;

  private sosTotalCreated = 0;
  private sosDeduplicatedCount = 0;
  private sosExternalConfirmed = 0;
  private sosExternalFailed = 0;
  private sosLastDeliveryAt: string | null = null;

  constructor() {
    const timer = setInterval(() => {
      const t0 = performance.now();
      setImmediate(() => {
        this.eventLoopLagMs = Number((performance.now() - t0).toFixed(2));
      });
    }, 5000);
    timer.unref();
  }

  incrementInFlight() {
    this.inFlight++;
    return this.inFlight;
  }

  decrementInFlight() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  getInFlight() {
    return this.inFlight;
  }

  recordHttpRequest(statusCode: number, durationMs: number) {
    this.totalRequests++;
    if (statusCode >= 500) this.error5xxCount++;
    if (statusCode === 429) this.rateLimited429Count++;
    if (statusCode === 503) this.overload503Count++;

    this.httpLatencies.push(durationMs);
    if (this.httpLatencies.length > MAX_LATENCY_SAMPLES) {
      this.httpLatencies.shift();
    }

    const sec = Math.floor(Date.now() / 1000);
    this.rpsBuckets.set(sec, (this.rpsBuckets.get(sec) || 0) + 1);
    const cutoff = sec - MAX_RPS_BUCKET_SECONDS;
    for (const k of this.rpsBuckets.keys()) {
      if (k < cutoff) this.rpsBuckets.delete(k);
    }
  }

  recordDbQuery(durationMs: number, queryName?: string) {
    this.dbLatencies.push(durationMs);
    if (this.dbLatencies.length > MAX_DB_SAMPLES) {
      this.dbLatencies.shift();
    }
    if (durationMs > this.slowestQueryMs) {
      this.slowestQueryMs = Number(durationMs.toFixed(2));
    }
    if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
      this.slowQueryCount++;
      const now = Date.now();
      if (process.env.NODE_ENV !== 'test' && now - this.lastSlowQueryWarnAt >= 5000) {
        this.lastSlowQueryWarnAt = now;
        console.warn(
          `[db-slow-query] ${queryName || 'query'} took ${durationMs.toFixed(1)}ms (threshold=${SLOW_QUERY_THRESHOLD_MS}ms)`
        );
      }
    }
  }

  recordWebVitals(sample: { lcpMs?: number; inpMs?: number; cls?: number; ttfbMs?: number }) {
    let recorded = false;
    const pushBounded = (arr: number[], val: number | undefined, maxValid: number) => {
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= maxValid) {
        arr.push(val);
        if (arr.length > MAX_VITAL_SAMPLES) arr.shift();
        recorded = true;
      }
    };
    pushBounded(this.lcpSamples, sample.lcpMs, 60_000);
    pushBounded(this.inpSamples, sample.inpMs, 30_000);
    pushBounded(this.clsSamples, sample.cls, 25);
    pushBounded(this.ttfbSamples, sample.ttfbMs, 60_000);
    if (recorded) {
      this.webVitalsSampleCount++;
      this.lastWebVitalAt = new Date().toISOString();
    }
  }

  recordWsRateLimited() {
    this.wsRateLimitedMessages++;
  }

  recordAiCall(opts: { durationMs: number; fallback: boolean; quotaExceeded?: boolean }) {
    this.aiTotalCalls++;
    this.aiLatencySumMs += opts.durationMs;
    if (opts.fallback) this.aiFallbackCalls++;
    if (opts.quotaExceeded) this.aiQuotaExceededCount++;
  }

  recordSosOutcome(opts: { deduplicated: boolean; confirmedCount: number; failedCount: number }) {
    if (opts.deduplicated) {
      this.sosDeduplicatedCount++;
      return;
    }
    this.sosTotalCreated++;
    this.sosExternalConfirmed += opts.confirmedCount;
    this.sosExternalFailed += opts.failedCount;
    this.sosLastDeliveryAt = new Date().toISOString();
  }

  private sampleCpuPercent(): number {
    const now = Date.now();
    const elapsedMs = now - this.lastCpuCheckMs;
    if (elapsedMs >= 500) {
      const diff = process.cpuUsage(this.lastCpuUsage);
      const totalMicros = diff.user + diff.system;
      this.lastCpuPercent = Number(Math.min(100, (totalMicros / (elapsedMs * 1000)) * 100).toFixed(1));
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuCheckMs = now;
    }
    return this.lastCpuPercent;
  }

  private percentile(sorted: number[], p: number, decimals = 2): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[idx].toFixed(decimals));
  }

  buildSnapshot(extra: {
    database: Omit<
      MonitoringSnapshot['database'],
      'avgQueryLatencyMs' | 'p95QueryLatencyMs' | 'slowQueryCount' | 'slowestQueryMs'
    > & {
      avgQueryLatencyMs?: number;
      p95QueryLatencyMs?: number;
    };
    websockets: Omit<MonitoringSnapshot['websockets'], 'rateLimitedMessages'>;
    cacheAndQueue: Omit<MonitoringSnapshot['cacheAndQueue'], 'cacheHitRatePercent'>;
    aiRuntime: {
      configured: boolean;
      circuitState: 'closed' | 'open' | 'half-open';
      inFlight: number;
      maxConcurrency: number;
    };
  }): MonitoringSnapshot {
    const mem = process.memoryUsage();
    const sortedHttp = [...this.httpLatencies].sort((a, b) => a - b);
    const sortedDb = [...this.dbLatencies].sort((a, b) => a - b);
    const sortedLcp = [...this.lcpSamples].sort((a, b) => a - b);
    const sortedInp = [...this.inpSamples].sort((a, b) => a - b);
    const sortedCls = [...this.clsSamples].sort((a, b) => a - b);
    const sortedTtfb = [...this.ttfbSamples].sort((a, b) => a - b);

    const avgLatencyMs = sortedHttp.length
      ? Number((sortedHttp.reduce((a, b) => a + b, 0) / sortedHttp.length).toFixed(2))
      : 0;
    const avgQueryLatencyMs = sortedDb.length
      ? Number((sortedDb.reduce((a, b) => a + b, 0) / sortedDb.length).toFixed(2))
      : 0;

    const nowSec = Math.floor(Date.now() / 1000);
    let recentReqs = 0;
    for (const [sec, count] of this.rpsBuckets.entries()) {
      if (sec >= nowSec - 10) recentReqs += count;
    }
    const rpsLast60s = Number((recentReqs / 10).toFixed(2));

    const errorRatePercent =
      this.totalRequests > 0 ? Number(((this.error5xxCount / this.totalRequests) * 100).toFixed(2)) : 0;

    const p95LatencyMs = this.percentile(sortedHttp, 95);
    const p99LatencyMs = this.percentile(sortedHttp, 99);
    const lcpP75Ms = this.percentile(sortedLcp, 75, 0);
    const inpP75Ms = this.percentile(sortedInp, 75, 0);
    const clsP75 = this.percentile(sortedCls, 75, 3);
    const ttfbP75Ms = this.percentile(sortedTtfb, 75, 0);

    const alerts: SystemAlert[] = [];
    const nowIso = new Date().toISOString();

    if (!extra.database.ok) {
      alerts.push({
        id: 'db_unhealthy',
        severity: 'critical',
        title: 'Database Health Degraded',
        message: 'Database health probe failed or missing required tables.',
        value: extra.database.dialect,
        threshold: 'ok = true',
        triggeredAt: nowIso,
      });
    }
    if (
      extra.database.pool.waitingCount > 0 ||
      (extra.database.pool.maxConnections > 0 &&
        extra.database.pool.totalCount >= extra.database.pool.maxConnections * 0.85 &&
        extra.database.pool.idleCount === 0)
    ) {
      alerts.push({
        id: 'db_saturation',
        severity: 'warning',
        title: 'Database Pool Saturation',
        message: 'PostgreSQL connection pool has waiting callers or near-max active connections.',
        value: `${extra.database.pool.totalCount}/${extra.database.pool.maxConnections} (waiting: ${extra.database.pool.waitingCount})`,
        threshold: '< 85% utilization & 0 waiting',
        triggeredAt: nowIso,
      });
    }
    if (this.totalRequests >= 20 && errorRatePercent > 5) {
      alerts.push({
        id: 'high_error_rate',
        severity: 'critical',
        title: 'Elevated 5xx Error Rate',
        message: 'Server 5xx error percentage exceeded 5% threshold.',
        value: `${errorRatePercent}%`,
        threshold: '<= 5%',
        triggeredAt: nowIso,
      });
    }
    if (sortedHttp.length >= 10 && p95LatencyMs > 500) {
      alerts.push({
        id: 'high_latency',
        severity: 'warning',
        title: 'High API p95 Latency',
        message: 'Rolling HTTP p95 response time exceeded 500 ms target.',
        value: `${p95LatencyMs} ms`,
        threshold: '<= 500 ms',
        triggeredAt: nowIso,
      });
    }
    if (sortedLcp.length >= 5 && lcpP75Ms > 2500) {
      alerts.push({
        id: 'poor_lcp',
        severity: 'warning',
        title: 'Core Web Vital: LCP Above 2.5s Target',
        message: 'Observed 75th-percentile Largest Contentful Paint exceeded 2500 ms.',
        value: `${lcpP75Ms} ms`,
        threshold: '<= 2500 ms',
        triggeredAt: nowIso,
      });
    }
    if (sortedInp.length >= 5 && inpP75Ms > 200) {
      alerts.push({
        id: 'poor_inp',
        severity: 'warning',
        title: 'Core Web Vital: INP Above 200ms Target',
        message: 'Observed 75th-percentile Interaction to Next Paint exceeded 200 ms.',
        value: `${inpP75Ms} ms`,
        threshold: '<= 200 ms',
        triggeredAt: nowIso,
      });
    }
    if (extra.cacheAndQueue.queueDepth > 50 || extra.cacheAndQueue.failedJobs > 0) {
      alerts.push({
        id: 'queue_backlog',
        severity: extra.cacheAndQueue.failedJobs > 0 ? 'critical' : 'warning',
        title: 'Background Retry Queue Alert',
        message: 'Background queue has pending backlog or failed notification retry jobs.',
        value: `depth=${extra.cacheAndQueue.queueDepth}, failed=${extra.cacheAndQueue.failedJobs}`,
        threshold: 'depth <= 50, failed = 0',
        triggeredAt: nowIso,
      });
    }
    if (this.sosExternalFailed > 0) {
      alerts.push({
        id: 'failed_sos_notifications',
        severity: 'warning',
        title: 'External SOS Contact Delivery Failures Logged',
        message: 'One or more external SMS/email SOS notifications failed delivery; check delivery logs.',
        value: `${this.sosExternalFailed} failed`,
        threshold: '0 failed external deliveries',
        triggeredAt: nowIso,
      });
    }
    if (extra.aiRuntime.circuitState !== 'closed' || this.aiQuotaExceededCount > 0) {
      alerts.push({
        id: 'ai_quota_or_circuit',
        severity: extra.aiRuntime.circuitState === 'open' ? 'critical' : 'warning',
        title: 'AI Provider Quota / Circuit Breaker Active',
        message: 'Gemini circuit breaker tripped or quota errors encountered; serving deterministic safety fallbacks.',
        value: `circuit=${extra.aiRuntime.circuitState}, 429s=${this.aiQuotaExceededCount}`,
        threshold: 'circuit=closed, 429s=0',
        triggeredAt: nowIso,
      });
    }

    const totalCacheLookups = extra.cacheAndQueue.cacheHits + extra.cacheAndQueue.cacheMisses;
    const cacheHitRatePercent =
      totalCacheLookups > 0
        ? Number(((extra.cacheAndQueue.cacheHits / totalCacheLookups) * 100).toFixed(1))
        : 0;

    return {
      timestamp: nowIso,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      nodeVersion: process.version,
      process: {
        rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
        heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(1)),
        cpuPercent: this.sampleCpuPercent(),
        eventLoopLagMs: this.eventLoopLagMs,
      },
      http: {
        inFlight: this.inFlight,
        totalRequests: this.totalRequests,
        rpsLast60s,
        error5xxCount: this.error5xxCount,
        errorRatePercent,
        rateLimited429Count: this.rateLimited429Count,
        overload503Count: this.overload503Count,
        avgLatencyMs,
        p50LatencyMs: this.percentile(sortedHttp, 50),
        p95LatencyMs,
        p99LatencyMs,
      },
      database: {
        dialect: extra.database.dialect,
        ok: extra.database.ok,
        healthLatencyMs: extra.database.healthLatencyMs,
        pool: extra.database.pool,
        avgQueryLatencyMs,
        p95QueryLatencyMs: this.percentile(sortedDb, 95),
        slowQueryCount: this.slowQueryCount,
        slowestQueryMs: this.slowestQueryMs,
      },
      webVitals: {
        sampleCount: this.webVitalsSampleCount,
        lcpP75Ms,
        inpP75Ms,
        clsP75,
        ttfbP75Ms,
        lastReportedAt: this.lastWebVitalAt,
      },
      websockets: {
        ...extra.websockets,
        rateLimitedMessages: this.wsRateLimitedMessages,
      },
      cacheAndQueue: {
        ...extra.cacheAndQueue,
        cacheHitRatePercent,
      },
      ai: {
        configured: extra.aiRuntime.configured,
        circuitState: extra.aiRuntime.circuitState,
        inFlight: extra.aiRuntime.inFlight,
        maxConcurrency: extra.aiRuntime.maxConcurrency,
        totalCalls: this.aiTotalCalls,
        fallbackCalls: this.aiFallbackCalls,
        quotaExceededCount: this.aiQuotaExceededCount,
        avgLatencyMs:
          this.aiTotalCalls > 0 ? Number((this.aiLatencySumMs / this.aiTotalCalls).toFixed(1)) : 0,
      },
      sos: {
        totalCreated: this.sosTotalCreated,
        deduplicatedCount: this.sosDeduplicatedCount,
        externalConfirmed: this.sosExternalConfirmed,
        externalFailed: this.sosExternalFailed,
        lastDeliveryAt: this.sosLastDeliveryAt,
      },
      alerts,
    };
  }

  resetForTests() {
    this.inFlight = 0;
    this.totalRequests = 0;
    this.error5xxCount = 0;
    this.rateLimited429Count = 0;
    this.overload503Count = 0;
    this.httpLatencies = [];
    this.dbLatencies = [];
    this.slowQueryCount = 0;
    this.slowestQueryMs = 0;
    this.lcpSamples = [];
    this.inpSamples = [];
    this.clsSamples = [];
    this.ttfbSamples = [];
    this.webVitalsSampleCount = 0;
    this.lastWebVitalAt = null;
    this.rpsBuckets.clear();
    this.wsRateLimitedMessages = 0;
    this.aiTotalCalls = 0;
    this.aiFallbackCalls = 0;
    this.aiQuotaExceededCount = 0;
    this.aiLatencySumMs = 0;
    this.sosTotalCreated = 0;
    this.sosDeduplicatedCount = 0;
    this.sosExternalConfirmed = 0;
    this.sosExternalFailed = 0;
    this.sosLastDeliveryAt = null;
  }
}

export const metrics = new MetricsRegistry();

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  const started = performance.now();
  res.on('finish', () => {
    const durationMs = performance.now() - started;
    metrics.recordHttpRequest(res.statusCode, durationMs);
  });
  next();
}
