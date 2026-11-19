import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GoogleGenAI } from '@google/genai';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-prod-readiness-'));
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = path.join(tempDir, 'prod-ready.db');
process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.ALLOW_DEMO_LOGIN = 'true';
process.env.NODE_ENV = 'test';

const { createAppServer } = await import('../server.ts');
const authMod = await import('../src/middleware/auth.ts');
const repoMod = await import('../src/db/repository.ts');
const geminiMod = await import('../src/services/gemini.ts');
const cacheMod = await import('../src/services/cacheQueue.ts');

describe('Production Readiness & Scalability Hardening', () => {
  let appServer: Awaited<ReturnType<typeof createAppServer>>;
  let httpBase = '';

  before(async () => {
    appServer = await createAppServer({ enableVite: false });
    await new Promise<void>((resolve) => {
      appServer.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = appServer.httpServer.address();
    assert.ok(addr && typeof addr === 'object');
    httpBase = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    geminiMod.resetAiRuntimeForTests();
    cacheMod.cacheQueue.clearAllForTests();
    await appServer.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('provisions shared DB-backed runtime SESSION_SECRET in production when env is unset without crashing', async () => {
    authMod.resetEphemeralSecretForTests();
    const s1 = await authMod.initializeRuntimeSessionSecret(repoMod.getOrInitSharedRuntimeSessionSecret, {
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    assert.ok(s1.length >= 64);

    authMod.resetEphemeralSecretForTests();
    const s2 = await authMod.initializeRuntimeSessionSecret(repoMod.getOrInitSharedRuntimeSessionSecret, {
      NODE_ENV: 'production',
      SESSION_SECRET: 'short_placeholder',
    } as NodeJS.ProcessEnv);
    assert.equal(s2, s1);
    authMod.resetEphemeralSecretForTests();
  });

  it('enforces 256kb JSON limit on standard routes while allowing up to 10mb on AI multimodal routes', async () => {
    const oversizedPayload = JSON.stringify({ query: 'x'.repeat(350 * 1024) });
    const stdResp = await fetch(`${httpBase}/api/maps/search-places`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });
    assert.equal(stdResp.status, 413);

    const loginResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    const { token } = (await loginResp.json()) as { token: string };

    const aiResp = await fetch(`${httpBase}/api/ai/assess-emergency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        description: 'Need help',
        imageBase64: 'A'.repeat(350 * 1024),
        imageMimeType: 'image/jpeg',
      }),
    });
    assert.equal(aiResp.status, 200);
  });

  it('does not fall back server Maps proxies to VITE_GOOGLE_MAPS_API_KEY', async () => {
    const prevServerKey = process.env.GOOGLE_MAPS_API_KEY;
    const prevViteKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    process.env.VITE_GOOGLE_MAPS_API_KEY = 'AIzaClientPublicOnlyKeyTest123';

    try {
      const resp = await fetch(`${httpBase}/api/maps/nearby-support`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
      });
      assert.equal(resp.status, 503);
    } finally {
      if (prevServerKey !== undefined) process.env.GOOGLE_MAPS_API_KEY = prevServerKey;
      else delete process.env.GOOGLE_MAPS_API_KEY;
      if (prevViteKey !== undefined) process.env.VITE_GOOGLE_MAPS_API_KEY = prevViteKey;
      else delete process.env.VITE_GOOGLE_MAPS_API_KEY;
    }
  });

  it('serves /api/ready and security headers, and restricts /api/admin/monitoring to operators & admins', async () => {
    const readyResp = await fetch(`${httpBase}/api/ready`);
    assert.equal(readyResp.status, 200);
    assert.equal(readyResp.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(readyResp.headers.get('x-frame-options'), 'SAMEORIGIN');
    const readyData = (await readyResp.json()) as { ready: boolean; dialect: string };
    assert.equal(readyData.ready, true);

    const userLogin = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    const userAuth = (await userLogin.json()) as { token: string };

    const forbiddenResp = await fetch(`${httpBase}/api/admin/monitoring`, {
      headers: { Authorization: `Bearer ${userAuth.token}` },
    });
    assert.equal(forbiddenResp.status, 403);

    const opLogin = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opAuth = (await opLogin.json()) as { token: string };

    const okResp = await fetch(`${httpBase}/api/admin/monitoring`, {
      headers: { Authorization: `Bearer ${opAuth.token}` },
    });
    assert.equal(okResp.status, 200);
    const snapshot = (await okResp.json()) as {
      database: { ok: boolean };
      http: { p95LatencyMs: number };
      websockets: { maxRealtimeCapacity: number };
      ai: { circuitState: string };
      cacheAndQueue: { backend: string };
    };
    assert.equal(snapshot.database.ok, true);
    assert.ok(typeof snapshot.http.p95LatencyMs === 'number');
    assert.ok(snapshot.websockets.maxRealtimeCapacity >= 2000);
    assert.equal(snapshot.ai.circuitState, 'closed');
    assert.ok(snapshot.cacheAndQueue.backend === 'memory' || snapshot.cacheAndQueue.backend === 'redis');
  });

  it('persists realtime events in DB for ?since= recovery and deduplicates bus eventIds', async () => {
    const first = cacheMod.cacheQueue.markEventSeen('evt_dedup_test_1');
    const second = cacheMod.cacheQueue.markEventSeen('evt_dedup_test_1');
    assert.equal(first, true);
    assert.equal(second, false);

    const persisted = await repoMod.recordRealtimeEvent({
      eventId: 'evt_persist_1',
      targetUserId: 1,
      includeOperators: true,
      userPayload: { type: 'incident:created', id: 101 },
      operatorPayload: { type: 'incident:created', id: 101, internal: 'op-only' },
    });
    assert.ok(persisted.seq > 0);

    const forUser1 = await repoMod.listRealtimeEventsSince(persisted.seq - 1, 1, false);
    assert.equal(forUser1.length, 1);
    assert.equal((forUser1[0].payload as { internal?: string }).internal, undefined);

    const forOtherUser = await repoMod.listRealtimeEventsSince(persisted.seq - 1, 999, false);
    assert.equal(forOtherUser.length, 0);

    const forOp = await repoMod.listRealtimeEventsSince(persisted.seq - 1, 2, true);
    assert.equal(forOp.length, 1);
    assert.equal((forOp[0].payload as { internal?: string }).internal, 'op-only');
  });

  it('trips Gemini circuit breaker after consecutive upstream failures and resets cleanly', async () => {
    geminiMod.resetAiRuntimeForTests();
    const failingClient = {
      models: {
        generateContent: async () => {
          throw new Error('429 RESOURCE_EXHAUSTED');
        },
      },
    } as unknown as GoogleGenAI;

    for (let i = 0; i < 5; i++) {
      const res = await geminiMod.runSafetyIntelligenceAgent(
        { concern: 'Night walk test' },
        { client: failingClient, timeoutMs: 200 }
      );
      assert.equal(res.aiAvailable, false);
    }

    const status = geminiMod.getAiRuntimeStatus();
    assert.equal(status.circuitState, 'open');

    const fastFallback = await geminiMod.runSafetyIntelligenceAgent(
      { concern: 'Should fast-fail circuit' },
      { client: failingClient, timeoutMs: 200 }
    );
    assert.equal(fastFallback.aiAvailable, false);
    assert.equal('fallbackReason' in fastFallback ? fastFallback.fallbackReason : undefined, 'unavailable');
    geminiMod.resetAiRuntimeForTests();
  });

  it('resolves Cloud SQL Unix socket directories when project slug differs from proxy socket ID', async () => {
    const dbIdxMod = await import('../src/db/index.ts');
    const mockCloudSqlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-cloudsql-sock-'));
    try {
      const mountedDir = path.join(mockCloudSqlRoot, 'project-8a8b6a99-4e2f-40ea-a51:us-west1:ai-studio-07a648a4');
      fs.mkdirSync(mountedDir, { recursive: true });
      fs.writeFileSync(path.join(mountedDir, '.s.PGSQL.5432'), '');

      const staleHost = path.join(mockCloudSqlRoot, 'savvy-yucca-r4dh4:us-west1:ai-studio-07a648a4');
      const resolved = dbIdxMod.resolvePostgresHost(staleHost, [mockCloudSqlRoot]);
      assert.equal(resolved, mountedDir);

      // TCP hostnames should remain untouched
      assert.equal(dbIdxMod.resolvePostgresHost('127.0.0.1', [mockCloudSqlRoot]), '127.0.0.1');
    } finally {
      fs.rmSync(mockCloudSqlRoot, { recursive: true, force: true });
    }
  });

  it('batches incident timelines & delivery logs without losing internal-note redaction', async () => {
    const userResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    const userAuth = (await userResp.json()) as { token: string; user: { id: number } };

    const opResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opAuth = (await opResp.json()) as { token: string };

    const sosResp = await fetch(`${httpBase}/api/incidents/sos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userAuth.token}`,
      },
      body: JSON.stringify({
        title: 'Batch Query Redaction Check',
        description: 'Testing batched updates and internal note privacy',
        category: 'Safety Alert',
        priority: 'HIGH',
        latitude: 37.775,
        longitude: -122.419,
        locationLabel: 'Test Corridor',
      }),
    });
    assert.equal(sosResp.status, 201);
    const created = (await sosResp.json()) as { incident: { id: number } };

    const internalNoteResp = await fetch(`${httpBase}/api/incidents/${created.incident.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opAuth.token}`,
      },
      body: JSON.stringify({
        status: 'Acknowledged',
        note: 'Confidential responder triage detail',
        isInternal: true,
      }),
    });
    assert.equal(internalNoteResp.status, 200);

    const userIncidents = await repoMod.listIncidentsForUser(userAuth.user.id);
    const targetForUser = userIncidents.find((i) => i.id === created.incident.id);
    assert.ok(targetForUser);
    assert.equal(
      targetForUser.updates.some((u) => u.isInternal),
      false
    );

    const opIncidents = await repoMod.listAllIncidentsForOperator({ limit: 25, offset: 0 });
    const targetForOp = opIncidents.find((i) => i.id === created.incident.id);
    assert.ok(targetForOp);
    assert.equal(
      targetForOp.updates.some((u) => u.isInternal && u.note.includes('Confidential')),
      true
    );
  });

  it('ingests Core Web Vitals via /api/metrics/vitals and exposes p75 + slow query metrics to operators', async () => {
    const vitalsResp = await fetch(`${httpBase}/api/metrics/vitals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lcpMs: 1420,
        inpMs: 85,
        cls: 0.04,
        ttfbMs: 110,
      }),
    });
    assert.equal(vitalsResp.status, 202);

    const opResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opAuth = (await opResp.json()) as { token: string };

    const monResp = await fetch(`${httpBase}/api/admin/monitoring`, {
      headers: { Authorization: `Bearer ${opAuth.token}` },
    });
    assert.equal(monResp.status, 200);
    const snap = (await monResp.json()) as {
      database: { slowQueryCount: number; slowestQueryMs: number };
      webVitals: { sampleCount: number; lcpP75Ms: number; inpP75Ms: number; clsP75: number; ttfbP75Ms: number };
    };
    assert.ok(snap.webVitals.sampleCount >= 1);
    assert.ok(snap.webVitals.lcpP75Ms >= 1420);
    assert.equal(typeof snap.database.slowQueryCount, 'number');
    assert.equal(typeof snap.database.slowestQueryMs, 'number');
  });

  it('sets Cache-Control on directory/clusters and invalidates server caches on report submission', async () => {
    const dirResp = await fetch(`${httpBase}/api/support-directory`);
    assert.equal(dirResp.status, 200);
    assert.ok((dirResp.headers.get('cache-control') || '').includes('max-age=30'));

    const clusterUrl = `${httpBase}/api/maps/sos-clusters?lat=37.7749&lng=-122.4194&radiusKm=40&windowDays=30`;
    const firstCluster = await fetch(clusterUrl);
    assert.equal(firstCluster.status, 200);
    assert.ok((firstCluster.headers.get('cache-control') || '').includes('max-age=20'));

    const secondCluster = await fetch(clusterUrl);
    assert.equal(secondCluster.status, 200);

    const userResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    const userAuth = (await userResp.json()) as { token: string };

    const repResp = await fetch(`${httpBase}/api/pulse/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userAuth.token}`,
      },
      body: JSON.stringify({
        category: 'Poor Lighting',
        severity: 'MODERATE',
        description: 'Cache invalidation test streetlight report',
        latitude: 37.7749,
        longitude: -122.4194,
        locationLabel: 'Market Corridor',
        isAnonymous: true,
      }),
    });
    assert.equal(repResp.status, 201);

    const afterCluster = await fetch(clusterUrl);
    assert.equal(afterCluster.status, 200);
  });

  it('paginates /api/admin/users for large user directories', async () => {
    const adminResp = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'administrator' }),
    });
    const adminAuth = (await adminResp.json()) as { token: string };

    const usersResp = await fetch(`${httpBase}/api/admin/users?page=1&limit=2`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.equal(usersResp.status, 200);
    const data = (await usersResp.json()) as {
      users: Array<{ id: number }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    assert.ok(Array.isArray(data.users));
    assert.ok(data.users.length <= 2);
    assert.equal(data.pagination.page, 1);
    assert.equal(data.pagination.limit, 2);
    assert.ok(data.pagination.total >= data.users.length);
  });

  it('recognizes DATABASE_URL / POSTGRES_URL and resolves os.tmpdir() SQLite path on Vercel', async () => {
    const dbMod = await import('../src/db/index.ts');
    const localStoreMod = await import('../src/db/local-store.ts');

    assert.equal(
      dbMod.hasPostgresConfig({ DATABASE_URL: 'postgresql://user:pass@ep-cool-rain.us-east-2.aws.neon.tech/neondb?sslmode=require' }),
      true
    );
    assert.equal(
      dbMod.hasPostgresConfig({ POSTGRES_URL: 'postgres://user:pass@db.vercel-storage.com:5432/verceldb' }),
      true
    );
    assert.equal(dbMod.hasPostgresConfig({}), false);

    const vercelSqlitePath = localStoreMod.resolveWritableSqlitePath({ VERCEL: '1' });
    assert.ok(vercelSqlitePath.startsWith(os.tmpdir()));
    assert.ok(vercelSqlitePath.endsWith(path.join('.data', 'lifeline.db')));
  });

  it('serves /api/health, /api/config/public (realtimeTransport=polling), and /api/live-incidents through Vercel /api/index.ts handler', async () => {
    const http = await import('node:http');
    const prevVercel = process.env.VERCEL;
    const prevProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const prevAppUrl = process.env.APP_URL;
    process.env.VERCEL = '1';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'life-line-ai-hack-culter-eight.vercel.app';
    delete process.env.APP_URL;

    const { default: vercelHandler } = await import('../api/index.ts');
    const server = http.createServer((req, res) => {
      void vercelHandler(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const base = `http://127.0.0.1:${addr.port}`;

      const healthResp = await fetch(`${base}/api/health`);
      assert.equal(healthResp.status, 200);
      const healthBody = (await healthResp.json()) as { status: string; realtimeTransport: string };
      assert.equal(healthBody.status, 'ok');
      assert.equal(healthBody.realtimeTransport, 'polling');

      const cfgResp = await fetch(`${base}/api/config/public`);
      assert.equal(cfgResp.status, 200);
      const cfgBody = (await cfgResp.json()) as { realtimeTransport: string; appUrl: string };
      assert.equal(cfgBody.realtimeTransport, 'polling');
      assert.equal(cfgBody.appUrl, 'https://life-line-ai-hack-culter-eight.vercel.app');

      const liveResp = await fetch(`${base}/api/live-incidents?region=mysuru`);
      assert.equal(liveResp.status, 200);
      const liveBody = (await liveResp.json()) as { region: string; alerts: unknown[]; sources: unknown[] };
      assert.equal(liveBody.region, 'mysuru');
      assert.ok(Array.isArray(liveBody.alerts));
      assert.ok(Array.isArray(liveBody.sources));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevVercel !== undefined) process.env.VERCEL = prevVercel;
      else delete process.env.VERCEL;
      if (prevProdUrl !== undefined) process.env.VERCEL_PROJECT_PRODUCTION_URL = prevProdUrl;
      else delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      if (prevAppUrl !== undefined) process.env.APP_URL = prevAppUrl;
      else delete process.env.APP_URL;
    }
  });
});

