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
});
