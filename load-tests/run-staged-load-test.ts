/**
 * Controlled Staging Load Test Runner for LIFE-LINE AI
 * Executes real HTTP & WebSocket concurrency bursts across staged tiers against an isolated
 * temporary staging server instance (mocked/disabled external email/AI billing providers).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const STAGES = [100, 500, 1000, 5000, 10000];
const MAX_LOCAL_SOCKET_CONCURRENCY = 400; // keep client generator sockets non-exhausting while firing exact total request count

interface StageResult {
  scenario: string;
  targetConcurrency: number;
  totalRequests: number;
  durationMs: number;
  rps: number;
  statusCounts: Record<string, number>;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRatePercent: number;
  rssMb: number;
  heapMb: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

async function runHttpBurst(
  scenario: string,
  targetRequests: number,
  workerCount: number,
  makeReq: (index: number) => Promise<{ status: string; latencyMs: number }>
): Promise<StageResult> {
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let cursor = 0;
  let errors = 0;

  const t0 = performance.now();
  const workers = Array.from({ length: Math.min(workerCount, targetRequests) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= targetRequests) break;
      try {
        const res = await makeReq(idx);
        latencies.push(res.latencyMs);
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
        if (res.status.startsWith('5') || res.status === 'ERR') errors++;
      } catch {
        statusCounts.ERR = (statusCounts.ERR || 0) + 1;
        errors++;
      }
    }
  });

  await Promise.all(workers);
  const durationMs = Math.max(1, performance.now() - t0);
  latencies.sort((a, b) => a - b);
  const mem = process.memoryUsage();

  return {
    scenario,
    targetConcurrency: targetRequests,
    totalRequests: targetRequests,
    durationMs: Number(durationMs.toFixed(1)),
    rps: Number(((targetRequests / durationMs) * 1000).toFixed(1)),
    statusCounts,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    errorRatePercent: Number(((errors / targetRequests) * 100).toFixed(2)),
    rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    heapMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-loadtest-'));
  process.env.DB_DRIVER = 'sqlite';
  process.env.LIFELINE_DB_PATH = path.join(tempDir, 'staging-load.db');
  process.env.LIFELINE_NO_AUTOSTART = 'true';
  process.env.ALLOW_DEMO_LOGIN = 'true';
  process.env.NODE_ENV = 'test';
  delete process.env.GEMINI_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;

  const { createAppServer } = await import('../server.ts');
  const srv = await createAppServer({ enableVite: false });

  await new Promise<void>((resolve) => {
    srv.httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = srv.httpServer.address();
  if (!addr || typeof addr !== 'object') throw new Error('Failed to bind load-test staging port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const wsBaseUrl = `ws://127.0.0.1:${addr.port}`;

  try {
    // Seed a single regular user + operator token for authenticated scenarios
    const userTokens: string[] = [];
    for (let u = 0; u < 5; u++) {
      const reg = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `loaduser${u}@staging.local`,
          password: 'LoadTestPassword123!',
          displayName: `LoadUser${u}`,
        }),
      });
      const data = (await reg.json()) as { token: string };
      userTokens.push(data.token);
    }

    const opLogin = await fetch(`${baseUrl}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opAuth = (await opLogin.json()) as { token: string };

    const stageResults: StageResult[] = [];

    // Scenario A+E: Support directory + readiness + D3 clusters across ALL 5 staged concurrency levels
    for (const stage of STAGES) {
      const r = await runHttpBurst(
        `A/E SupportDirectory+Ready (${stage})`,
        stage,
        Math.min(stage, MAX_LOCAL_SOCKET_CONCURRENCY),
        async (i) => {
          const t = performance.now();
          const pathUrl =
            i % 3 === 0 ? '/api/ready' : i % 3 === 1 ? '/api/support-directory' : '/api/maps/sos-clusters?lat=37.77&lng=-122.41';
          const resp = await fetch(`${baseUrl}${pathUrl}`, {
            headers: { 'X-Forwarded-For': `10.0.${Math.floor(i / 250)}.${i % 250}` },
          });
          await resp.arrayBuffer();
          return { status: String(resp.status), latencyMs: performance.now() - t };
        }
      );
      stageResults.push(r);
    }

    // Scenario C: SOS Trigger + Idempotency Deduplication + Rate Limit Behavior
    for (const stage of [100, 500, 1000]) {
      const r = await runHttpBurst(
        `C SOS Trigger+Dedup (${stage})`,
        stage,
        Math.min(stage, 150),
        async (i) => {
          const t = performance.now();
          const token = userTokens[i % userTokens.length];
          const resp = await fetch(`${baseUrl}/api/incidents/sos`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              'X-Forwarded-For': `10.1.${Math.floor(i / 250)}.${i % 250}`,
            },
            body: JSON.stringify({
              idempotencyKey: `stage_${stage}_item_${Math.floor(i / 2)}`, // every pair tests idempotency!
              title: `Simulated Load SOS ${i}`,
              priority: 'HIGH',
              latitude: 37.7749,
              longitude: -122.4194,
              isSimulated: true,
            }),
          });
          await resp.arrayBuffer();
          return { status: String(resp.status), latencyMs: performance.now() - t };
        }
      );
      stageResults.push(r);
    }

    // Scenario B+F+G: Auth /me, Pulse Risk + Fallback AI under rate limiter
    for (const stage of [100, 500, 1000]) {
      const r = await runHttpBurst(
        `B/F/G Auth+Pulse+AI Fallback (${stage})`,
        stage,
        Math.min(stage, 200),
        async (i) => {
          const t = performance.now();
          const token = userTokens[i % userTokens.length];
          const mode = i % 3;
          let resp: Response;
          if (mode === 0) {
            resp = await fetch(`${baseUrl}/api/auth/me`, {
              headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.2.0.${i % 250}` },
            });
          } else if (mode === 1) {
            resp = await fetch(`${baseUrl}/api/pulse/risk?lat=37.7749&lng=-122.4194`, {
              headers: { 'X-Forwarded-For': `10.2.1.${i % 250}` },
            });
          } else {
            resp = await fetch(`${baseUrl}/api/ai/safety-intelligence`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'X-Forwarded-For': `10.2.2.${i % 250}`,
              },
              body: JSON.stringify({ concern: 'Evening walk', areaLabel: 'Downtown' }),
            });
          }
          await resp.arrayBuffer();
          return { status: String(resp.status), latencyMs: performance.now() - t };
        }
      );
      stageResults.push(r);
    }

    // Scenario D: WebSocket per-user connection limits + message burst
    const wsConnectionsAccepted: number[] = [];
    const wsConnectionsRejected: number[] = [];
    const openedSockets: WebSocket[] = [];
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`${wsBaseUrl}/ws/realtime?token=${encodeURIComponent(userTokens[0])}`);
          ws.once('open', () => {
            wsConnectionsAccepted.push(1);
            openedSockets.push(ws);
            ws.send(JSON.stringify({ type: 'ping' }));
            resolve();
          });
          ws.once('close', (code) => {
            if (code === 1008 || code === 1013) wsConnectionsRejected.push(code);
            resolve();
          });
          ws.once('error', () => resolve());
        });
      })
    );
    openedSockets.forEach((s) => s.close());

    // Final monitoring snapshot from Scenario H / Operator desk
    const monResp = await fetch(`${baseUrl}/api/admin/monitoring`, {
      headers: { Authorization: `Bearer ${opAuth.token}` },
    });
    const monSnapshot = (await monResp.json()) as Record<string, unknown>;

    console.log(
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          environment: 'Controlled Local Staging (SQLite temp DB, isolated mock AI/notifications)',
          stageResults,
          websocketBurstCheck: {
            attemptedPerSingleUser: 12,
            acceptedWithinCap: wsConnectionsAccepted.length,
            enforcedCapRejections: wsConnectionsRejected.length,
          },
          monitoringSnapshot: monSnapshot,
        },
        null,
        2
      )
    );
  } finally {
    await srv.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();
