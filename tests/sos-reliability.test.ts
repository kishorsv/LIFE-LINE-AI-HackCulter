import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-sos-test-'));
const dbPath = path.join(tempDir, 'sos-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

describe('SOS Reliability, Idempotency, Offline Queue Isolation & Truthful Notifications', () => {
  let baseUrl = '';
  let shutdown: () => Promise<void>;
  let queueMod: typeof import('../src/lib/offlineSosQueue.ts');
  let notifMod: typeof import('../src/services/notifications.ts');
  let repoMod: typeof import('../src/db/repository.ts');

  before(async () => {
    queueMod = await import('../src/lib/offlineSosQueue.ts');
    notifMod = await import('../src/services/notifications.ts');
    repoMod = await import('../src/db/repository.ts');
    const serverMod = await import('../server.ts');

    const srv = await serverMod.createAppServer({ enableVite: false });
    shutdown = srv.shutdown;
    await new Promise<void>((resolve) => {
      srv.httpServer.listen(0, '127.0.0.1', () => {
        const addr = srv.httpServer.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (shutdown) await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('deduplicates duplicate SOS submissions using unique idempotencyKey per user', async () => {
    const regResp = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'sos.dedup@example.com',
        password: 'Password123!',
        displayName: 'SOS Dedup',
      }),
    });
    const session = (await regResp.json()) as { token: string };

    const key = 'sos_unique_retry_key_001';
    const first = await fetch(`${baseUrl}/api/incidents/sos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        idempotencyKey: key,
        title: 'Urgent Personal Safety SOS',
        latitude: 37.775,
        longitude: -122.419,
      }),
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as { incident: { id: number }; deduplicated: boolean };
    assert.equal(firstBody.deduplicated, false);

    // Retry with identical idempotencyKey returns existing incident with HTTP 200 and deduplicated: true
    const second = await fetch(`${baseUrl}/api/incidents/sos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        idempotencyKey: key,
        title: 'Urgent Personal Safety SOS',
        latitude: 37.775,
        longitude: -122.419,
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { incident: { id: number }; deduplicated: boolean };
    assert.equal(secondBody.deduplicated, true);
    assert.equal(secondBody.incident.id, firstBody.incident.id);
  });

  it('binds offline SOS queue items strictly to originating user, enforces TTL expiry, and tracks retry backoff/failed states', () => {
    const storage = createMemoryStorage();
    const userA = { id: 101, uid: 'uid-user-a' };
    const userB = { id: 202, uid: 'uid-user-b' };
    const t0 = 1_700_000_000_000;

    const itemA = queueMod.enqueueOfflineSos(
      {
        userId: userA.id,
        userUid: userA.uid,
        idempotencyKey: 'sos_offline_a_1',
        title: 'User A Offline SOS',
        description: 'Battery critical',
        category: 'Personal Safety',
        priority: 'CRITICAL',
        latitude: 37.77,
        longitude: -122.41,
        locationLabel: 'Downtown',
        locationAccuracyMeters: 15,
        isSimulated: false,
      },
      { storage, nowMs: t0, ttlMs: 60_000, maxRetries: 2 }
    );

    // User B cannot see or remove User A's queued SOS
    assert.equal(queueMod.getQueuedSosAlerts(userB, storage, t0).length, 0);
    assert.equal(queueMod.getQueuedSosAlerts(userA, storage, t0).length, 1);
    queueMod.removeQueuedSos(itemA.id, userB, storage);
    assert.equal(queueMod.getQueuedSosAlerts(userA, storage, t0).length, 1);

    // Retry failure schedules backoff and transitions to 'failed' after maxRetries
    const afterAttempt1 = queueMod.recordQueuedSosRetryFailure(itemA.id, userA, 'Network down', {
      storage,
      nowMs: t0 + 1000,
    });
    assert.equal(afterAttempt1?.state, 'queued');
    assert.equal(afterAttempt1?.attempts, 1);
    // Not immediately retryable during backoff window
    assert.equal(queueMod.getRetryableQueuedSosAlerts(userA, storage, t0 + 2000).length, 0);
    // Retryable once backoff elapses
    assert.equal(queueMod.getRetryableQueuedSosAlerts(userA, storage, t0 + 10_000).length, 1);

    const afterAttempt2 = queueMod.recordQueuedSosRetryFailure(itemA.id, userA, 'Network still down', {
      storage,
      nowMs: t0 + 10_000,
    });
    assert.equal(afterAttempt2?.state, 'failed');
    assert.equal(queueMod.getRetryableQueuedSosAlerts(userA, storage, t0 + 20_000).length, 0);

    // Expired items (> ttlMs) are pruned automatically
    assert.equal(queueMod.getQueuedSosAlerts(userA, storage, t0 + 61_000).length, 0);
  });

  it('reports truthful delivery states (submitted vs failed vs provider-confirmed delivered)', async () => {
    notifMod.resetNotificationRateLimits();
    const { user } = await repoMod.registerEmailUser({
      email: 'truthful.notif@example.com',
      password: 'Password123!',
      displayName: 'Truthful Notif',
    });
    const { incident } = await repoMod.createIncident({
      userId: user.id,
      idempotencyKey: 'sos_notif_truth_1',
      title: 'Truthful Delivery Test',
    });
    assert.ok(incident);

    const contacts = [
      { id: 1, name: 'Mom', email: 'mom@example.com', phone: '+15550101', notifyEmail: true, notifySms: true },
    ];

    // 1. Unconfigured providers must NEVER claim delivered
    delete process.env.RESEND_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    const unconfiguredSummary = await notifMod.dispatchEmergencyNotifications({
      senderUserId: user.id,
      incidentId: incident.id,
      incidentTitle: incident.title,
      locationLabel: 'Station 4',
      latitude: 37.77,
      longitude: -122.41,
      isSimulated: false,
      contacts,
    });
    assert.equal(unconfiguredSummary.overallDeliveryState, 'submitted');
    assert.equal(unconfiguredSummary.externalConfirmedCount, 0);
    assert.equal(unconfiguredSummary.externalUnconfiguredCount, 2);
    assert.ok(unconfiguredSummary.deliveryResults.every((r) => r.status === 'provider_not_configured'));

    // 2. Failing provider marks failed truthfully
    process.env.RESEND_API_KEY = 're_test_key';
    const failedFetch = (async () =>
      new Response(JSON.stringify({ message: 'Upstream rejected' }), { status: 500 })) as typeof fetch;
    const failedSummary = await notifMod.dispatchEmergencyNotifications({
      senderUserId: user.id,
      incidentId: incident.id,
      incidentTitle: incident.title,
      locationLabel: 'Station 4',
      latitude: 37.77,
      longitude: -122.41,
      isSimulated: false,
      contacts: [{ id: 1, name: 'Mom', email: 'mom@example.com', phone: '', notifyEmail: true, notifySms: false }],
      fetchImpl: failedFetch,
    });
    assert.equal(failedSummary.overallDeliveryState, 'failed');
    assert.equal(failedSummary.externalFailedCount, 1);

    // 3. Provider returning confirmed message ID marks delivered truthfully
    const okFetch = (async () =>
      new Response(JSON.stringify({ id: 'resend_msg_confirmed_123' }), { status: 200 })) as typeof fetch;
    const okSummary = await notifMod.dispatchEmergencyNotifications({
      senderUserId: user.id,
      incidentId: incident.id,
      incidentTitle: incident.title,
      locationLabel: 'Station 4',
      latitude: 37.77,
      longitude: -122.41,
      isSimulated: false,
      contacts: [{ id: 1, name: 'Mom', email: 'mom@example.com', phone: '', notifyEmail: true, notifySms: false }],
      fetchImpl: okFetch,
    });
    assert.equal(okSummary.overallDeliveryState, 'delivered');
    assert.equal(okSummary.externalConfirmedCount, 1);
    delete process.env.RESEND_API_KEY;
  });
});
