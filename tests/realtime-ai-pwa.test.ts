import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-rt-ai-test-'));
const dbPath = path.join(tempDir, 'rt-ai-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

function connectWs(url: string): Promise<{ ws: WebSocket; messages: Record<string, unknown>[]; closeCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // ignore non-json
      }
    });
    ws.on('open', () => {
      setTimeout(() => resolve({ ws, messages }), 60);
    });
    ws.on('close', (code) => {
      resolve({ ws, messages, closeCode: code });
    });
    ws.on('error', () => {
      resolve({ ws, messages, closeCode: 1006 });
    });
  });
}

describe('WebSocket Auth/Replay, Gemini/Maps Hardening & PWA Cache Isolation', () => {
  let httpBase = '';
  let wsBase = '';
  let shutdown: () => Promise<void>;
  let geminiMod: typeof import('../src/services/gemini.ts');

  before(async () => {
    geminiMod = await import('../src/services/gemini.ts');
    const serverMod = await import('../server.ts');

    const srv = await serverMod.createAppServer({ enableVite: false });
    shutdown = srv.shutdown;
    await new Promise<void>((resolve) => {
      srv.httpServer.listen(0, '127.0.0.1', () => {
        const addr = srv.httpServer.address();
        if (addr && typeof addr === 'object') {
          httpBase = `http://127.0.0.1:${addr.port}`;
          wsBase = `ws://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (shutdown) await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated connections on /ws/realtime and /ws/live, enforces limits, filters internal notes, and replays missed events', async () => {
    const unauthRealtime = await connectWs(`${wsBase}/ws/realtime`);
    assert.equal(unauthRealtime.closeCode, 1008);

    const unauthLive = await connectWs(`${wsBase}/ws/live`);
    assert.equal(unauthLive.closeCode, 1008);

    // Register User A & User B, and obtain Demo Operator token
    const regA = await fetch(`${httpBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ws.usera@example.com', password: 'Password123!', displayName: 'User A' }),
    });
    const sessionA = (await regA.json()) as { token: string };

    const regB = await fetch(`${httpBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ws.userb@example.com', password: 'Password123!', displayName: 'User B' }),
    });
    const sessionB = (await regB.json()) as { token: string };

    const opLogin = await fetch(`${httpBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opSession = (await opLogin.json()) as { token: string };

    // Connect User A & Operator to /ws/realtime
    const clientA = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(sessionA.token)}`);
    const clientOp = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(opSession.token)}`);

    const connectedA = clientA.messages.find((m) => m.type === 'realtime:connected') as { latestSeq: number };
    assert.ok(connectedA);
    const seqBeforeSos = connectedA.latestSeq;

    // Trigger SOS as User A
    const sosResp = await fetch(`${httpBase}/api/incidents/sos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionA.token}` },
      body: JSON.stringify({ idempotencyKey: 'ws_test_sos_1', title: 'WS Event Test' }),
    });
    const sosBody = (await sosResp.json()) as { incident: { id: number } };

    // Operator posts an internal-only responder note
    await fetch(`${httpBase}/api/incidents/${sosBody.incident.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opSession.token}` },
      body: JSON.stringify({
        status: 'Acknowledged',
        note: 'Internal triage radio channel 4 note',
        isInternal: true,
      }),
    });

    await new Promise((r) => setTimeout(r, 80));

    // User A receives update WITHOUT internal note; Operator receives WITH internal note
    const userAUpdate = clientA.messages.find((m) => m.type === 'incident:updated') as {
      incident: { updates: Array<{ note: string; isInternal?: boolean }> };
    };
    const opUpdate = clientOp.messages.find((m) => m.type === 'incident:updated') as {
      incident: { updates: Array<{ note: string; isInternal?: boolean }> };
    };
    assert.ok(userAUpdate);
    assert.ok(opUpdate);
    assert.equal(
      userAUpdate.incident.updates.some((u) => u.isInternal || u.note.includes('Internal triage radio')),
      false
    );
    assert.equal(
      opUpdate.incident.updates.some((u) => u.note.includes('Internal triage radio')),
      true
    );

    // Missed-event recovery via ?since= replays User A's events to User A, and NEVER leaks them to User B
    const replayA = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(sessionA.token)}&since=${seqBeforeSos}`);
    const replayB = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(sessionB.token)}&since=${seqBeforeSos}`);
    assert.ok(replayA.messages.some((m) => m.type === 'incident:created'));
    assert.equal(replayB.messages.some((m) => m.type === 'incident:created'), false);

    // Per-user connection limit (> 5 concurrent sockets for User A rejected)
    const extraSockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(sessionA.token)}`);
      extraSockets.push(c.ws);
    }
    const overLimit = await connectWs(`${wsBase}/ws/realtime?token=${encodeURIComponent(sessionA.token)}`);
    assert.equal(overLimit.closeCode, 1008);

    clientA.ws.close();
    clientOp.ws.close();
    replayA.ws.close();
    replayB.ws.close();
    extraSockets.forEach((s) => s.close());
  });

  it('handles Gemini timeouts, 429 quotas, malformed JSON responses, and marks AI advisory separate from verified facts', async () => {
    const quota = geminiMod.classifyGeminiError(new Error('429 RESOURCE_EXHAUSTED: Quota exceeded'));
    assert.equal(quota.reason, 'quota_exceeded');
    assert.equal(quota.statusCode, 429);

    const timeoutErr = geminiMod.classifyGeminiError(new Error('Gemini API timed out after 15000ms'));
    assert.equal(timeoutErr.reason, 'timeout');
    assert.equal(timeoutErr.statusCode, 504);

    await assert.rejects(
      geminiMod.withTimeout(new Promise((resolve) => setTimeout(resolve, 200)), 20, 'TestOp'),
      /timed out/
    );

    assert.equal(geminiMod.safeParseJsonObject('not valid json {oops'), null);
    assert.deepEqual(geminiMod.safeParseJsonObject('```json\n{"urgencyLevel":"HIGH"}\n```'), {
      urgencyLevel: 'HIGH',
    });

    const mockMalformedClient = {
      models: {
        generateContent: async () => ({ text: 'corrupted non-json payload' }),
      },
    } as unknown as NonNullable<Parameters<typeof geminiMod.runEmergencyAssessmentAgent>[1]>['client'];

    const fallback = await geminiMod.runEmergencyAssessmentAgent(
      { description: 'Someone is following me near the station' },
      { client: mockMalformedClient }
    );
    assert.equal(fallback.isAiAdvisory, true);
    assert.equal(fallback.aiAvailable, false);
    assert.equal('fallbackReason' in fallback ? fallback.fallbackReason : undefined, 'malformed_response');
    assert.equal(fallback.verificationStatus, 'Deterministic Safety Fallback (Unverified)');
    assert.ok(fallback.advisoryNotice.includes('advisory'));
  });

  it('protects server GOOGLE_MAPS_API_KEY in /api/config/public and validates map coordinates', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'server_only_secret_maps_key_xyz';
    delete process.env.VITE_GOOGLE_MAPS_API_KEY;

    const cfgResp = await fetch(`${httpBase}/api/config/public`);
    const cfg = (await cfgResp.json()) as { mapsApiKey: string };
    assert.equal(cfg.mapsApiKey, '');
    delete process.env.GOOGLE_MAPS_API_KEY;

    const badCoordsResp = await fetch(`${httpBase}/api/maps/nearby-support`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 999, longitude: -122.4 }),
    });
    assert.equal(badCoordsResp.status, 400);
  });

  it('verifies PWA Workbox runtimeCaching does not cache private authenticated API endpoints', () => {
    const viteConfig = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    assert.equal(/\/api\/\(support-directory\|contacts/.test(viteConfig), false);
    assert.equal(viteConfig.includes('emergency-api-cache'), false);
    assert.ok(viteConfig.includes('public-directory-cache'));
    assert.ok(/support-directory\|health/.test(viteConfig));
  });
});
