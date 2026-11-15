import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-clusters-test-'));
const dbPath = path.join(tempDir, 'clusters-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

describe('D3.js Historical SOS Incident Clusters Analytics & Privacy Hardening', () => {
  let baseUrl = '';
  let shutdown: () => Promise<void>;
  let pulseMod: typeof import('../src/services/pulse.ts');

  before(async () => {
    pulseMod = await import('../src/services/pulse.ts');
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

  it('aggregates spatial grid clusters, excludes Cancelled SOS, and separates verified vs simulated signals', () => {
    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    const result = pulseMod.buildSosIncidentClusters({
      centerLat: 37.775,
      centerLng: -122.419,
      radiusKm: 25,
      windowDays: 30,
      includeSimulated: true,
      incidents: [
        {
          id: 1,
          category: 'Personal Safety',
          priority: 'CRITICAL',
          status: 'SOS Activated',
          latitude: 37.77519,
          longitude: -122.41918,
          isSimulated: false,
          createdAt: nowIso,
        },
        {
          id: 2,
          category: 'Personal Safety',
          priority: 'HIGH',
          status: 'Resolved',
          latitude: 37.77525,
          longitude: -122.41925,
          isSimulated: false,
          createdAt: nowIso,
        },
        {
          id: 3,
          category: 'Medical',
          priority: 'CRITICAL',
          status: 'Cancelled',
          latitude: 37.7752,
          longitude: -122.4192,
          isSimulated: false,
          createdAt: nowIso,
        },
        {
          id: 4,
          category: 'Stale Event',
          priority: 'HIGH',
          status: 'SOS Activated',
          latitude: 37.7752,
          longitude: -122.4192,
          isSimulated: false,
          createdAt: staleIso,
        },
        {
          id: 5,
          category: 'Demo Drill',
          priority: 'HIGH',
          status: 'SOS Activated',
          latitude: 37.79144,
          longitude: -122.40544,
          isSimulated: true,
          createdAt: nowIso,
        },
      ],
      reports: [
        {
          id: 10,
          category: 'Poor Street Lighting',
          severity: 'MODERATE',
          latitude: 37.77522,
          longitude: -122.41922,
          verificationStatus: 'community_unverified',
          isSimulated: false,
          createdAt: nowIso,
        },
      ],
    });

    assert.equal(result.totalVerifiedRecords, 3);
    assert.equal(result.totalSimulatedRecords, 1);
    assert.equal(result.clusters.length, 2);

    const verifiedCluster = result.clusters.find((c) => c.dataOrigin === 'verified');
    assert.ok(verifiedCluster);
    assert.equal(verifiedCluster.verifiedSosCount, 2);
    assert.equal(verifiedCluster.communityReportCount, 1);
    assert.equal(verifiedCluster.simulatedCount, 0);
    // Centroid coordinates generalized to 3 decimals (~110m privacy anonymization)
    assert.equal(verifiedCluster.lat, Number(verifiedCluster.lat.toFixed(3)));
    assert.equal(verifiedCluster.lng, Number(verifiedCluster.lng.toFixed(3)));

    const demoCluster = result.clusters.find((c) => c.dataOrigin === 'simulated');
    assert.ok(demoCluster);
    assert.equal(demoCluster.simulatedCount, 1);

    // Excluding simulated drills omits demo cluster cleanly
    const noSimResult = pulseMod.buildSosIncidentClusters({
      centerLat: 37.775,
      centerLng: -122.419,
      radiusKm: 25,
      windowDays: 30,
      includeSimulated: false,
      incidents: [
        {
          id: 5,
          category: 'Demo Drill',
          priority: 'HIGH',
          status: 'SOS Activated',
          latitude: 37.79144,
          longitude: -122.40544,
          isSimulated: true,
          createdAt: nowIso,
        },
      ],
      reports: [],
    });
    assert.equal(noSimResult.clusters.length, 0);
  });

  it('validates /api/maps/sos-clusters inputs and omits all user PII from cluster analytics payloads', async () => {
    const badCoords = await fetch(`${baseUrl}/api/maps/sos-clusters?lat=999&lng=-122.4`);
    assert.equal(badCoords.status, 400);

    const badWindow = await fetch(`${baseUrl}/api/maps/sos-clusters?lat=37.77&lng=-122.41&windowDays=999`);
    assert.equal(badWindow.status, 400);

    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cluster.privacy@example.com',
        password: 'Password123!',
        displayName: 'Sensitive Victim Name',
      }),
    });
    const session = (await reg.json()) as { token: string };

    const sos = await fetch(`${baseUrl}/api/incidents/sos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'cluster_privacy_sos_01',
        title: 'PRIVATE-STREET-TITLE-DO-NOT-LEAK',
        description: 'Private victim details should never appear in cluster endpoints',
        category: 'Transit Safety',
        priority: 'HIGH',
        latitude: 37.77492,
        longitude: -122.41942,
      }),
    });
    assert.equal(sos.status, 201);

    const resp = await fetch(`${baseUrl}/api/maps/sos-clusters?lat=37.775&lng=-122.419&radiusKm=40&windowDays=30`);
    assert.equal(resp.status, 200);
    const bodyText = await resp.text();
    const payload = JSON.parse(bodyText) as {
      totalVerifiedRecords: number;
      clusters: Array<{ verifiedSosCount: number }>;
      hourlyDistribution: Array<{ hour: number }>;
      privacyNotice: string;
    };

    assert.ok(payload.totalVerifiedRecords >= 1);
    assert.ok(payload.clusters.length >= 1);
    assert.equal(payload.hourlyDistribution.length, 24);
    assert.ok(payload.privacyNotice.includes('550m'));

    // Strictly verify no victim PII leaks in public cluster analytics response
    assert.equal(bodyText.includes('cluster.privacy@example.com'), false);
    assert.equal(bodyText.includes('Sensitive Victim Name'), false);
    assert.equal(bodyText.includes('PRIVATE-STREET-TITLE-DO-NOT-LEAK'), false);
    assert.equal(bodyText.includes('Private victim details'), false);
  });
});
