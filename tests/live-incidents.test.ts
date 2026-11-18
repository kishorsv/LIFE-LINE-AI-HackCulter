import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-live-incidents-test-'));
const dbPath = path.join(tempDir, 'live-incidents-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.LIFELINE_DISABLE_AUTO_POLL = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

describe('LIVE INCIDENT INTELLIGENCE (NDMA SACHET, IMD CAP, Open-Meteo, SGS & RBAC)', () => {
  let baseUrl = '';
  let wsBaseUrl = '';
  let shutdown: () => Promise<void>;
  let feedsMod: typeof import('../src/services/liveFeeds.ts');
  let intelMod: typeof import('../src/services/incidentIntelligence.ts');
  let pollerMod: typeof import('../src/services/livePoller.ts');
  let repoMod: typeof import('../src/db/repository.ts');

  before(async () => {
    feedsMod = await import('../src/services/liveFeeds.ts');
    intelMod = await import('../src/services/incidentIntelligence.ts');
    pollerMod = await import('../src/services/livePoller.ts');
    repoMod = await import('../src/db/repository.ts');
    const serverMod = await import('../server.ts');

    const srv = await serverMod.createAppServer({ enableVite: false });
    shutdown = srv.shutdown;
    await new Promise<void>((resolve) => {
      srv.httpServer.listen(0, '127.0.0.1', () => {
        const addr = srv.httpServer.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
          wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (shutdown) await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses NDMA SACHET "lng,lat" centroids and IST timestamps accurately', () => {
    const coords = feedsMod.parseSachetCentroidLngLat('82.541112,18.044453');
    assert.ok(coords);
    assert.equal(coords.lat, 18.044453);
    assert.equal(coords.lng, 82.541112);

    const parsedIso = feedsMod.parseSachetTimestamp('Wed Nov 18 17:10:00 IST 2026');
    assert.ok(parsedIso);
    assert.equal(parsedIso, '2026-11-18T11:40:00.000Z');

    const nowFuture = Date.parse('2026-11-18T10:00:00.000Z');
    const alerts = feedsMod.parseNdmaSachetJsonAlerts(
      [
        {
          identifier: '1794065348854019',
          severity: 'Watch',
          effective_start_time: 'Wed Nov 18 14:00:00 IST 2026',
          effective_end_time: 'Wed Nov 18 22:00:00 IST 2026',
          disaster_type: 'Heavy Rainfall',
          area_description: 'Mysuru, Mandya, Kodagu',
          severity_level: 'MODERATE',
          actual_lang: 'en',
          warning_message: 'Heavy rainfall likely over Mysuru and Kodagu.',
          severity_color: 'yellow',
          centroid: '76.6394,12.2958',
          alert_source: 'IMD Bengaluru',
          area_covered: '1420',
        },
      ],
      nowFuture
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].externalKey, 'ndma-sachet:1794065348854019');
    assert.equal(alerts[0].latitude, 12.2958);
    assert.equal(alerts[0].longitude, 76.6394);
    assert.equal(alerts[0].category, 'Heavy Rainfall');
    assert.equal(alerts[0].isActive, true);
    assert.equal(alerts[0].verificationStatus, 'Official Alert');
  });

  it('parses NDMA SACHET Karnataka RSS & CAP XML (including expired status and Mysuru district centroid fallback)', async () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <item>
          <title><![CDATA[Thunderstorm with Lightning very likely in Mysuru]]></title>
          <link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=cap-ka-1</link>
          <guid>cap-ka-1</guid>
          <pubDate>Wed, 18 Nov 2026 08:00:00 GMT</pubDate>
          <author>controlroom@ndma.gov.in (IMD Bengaluru)</author>
          <description><![CDATA[IMD Bengaluru nowcast for Mysuru]]></description>
        </item>
      </channel></rss>`;

    const capXml = `<?xml version="1.0" encoding="UTF-8"?>
      <cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
        <cap:identifier>cap-ka-1</cap:identifier>
        <cap:info>
          <cap:event>Thunderstorm</cap:event>
          <cap:severity>Moderate</cap:severity>
          <cap:certainty>Likely</cap:certainty>
          <cap:effective>2026-11-18T13:30:00+05:30</cap:effective>
          <cap:expires>2026-11-18T19:30:00+05:30</cap:expires>
          <cap:senderName>IMD Bengaluru</cap:senderName>
          <cap:headline>Thunderstorm warning for Mysuru district</cap:headline>
          <cap:description>Lightning and gusty winds likely in Mysuru.</cap:description>
          <cap:instruction>Stay indoors during lightning.</cap:instruction>
          <cap:area><cap:areaDesc>Mysuru District, Karnataka</cap:areaDesc></cap:area>
        </cap:info>
      </cap:alert>`;

    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('rss_karnataka.xml')) return new Response(rssXml, { status: 200 });
      return new Response(capXml, { status: 200 });
    }) as typeof fetch;

    const activeRes = await feedsMod.fetchNdmaKarnatakaRssAndCap(
      mockFetch,
      Date.parse('2026-11-18T10:00:00.000Z')
    );
    assert.equal(activeRes.alerts.length, 1);
    assert.equal(activeRes.alerts[0].externalKey, 'ndma-karnataka-cap:cap-ka-1');
    assert.equal(activeRes.alerts[0].districtName, 'Mysuru');
    assert.equal(activeRes.alerts[0].latitude, 12.2958);
    assert.equal(activeRes.alerts[0].longitude, 76.6394);
    assert.equal(activeRes.alerts[0].isActive, true);

    const expiredRes = await feedsMod.fetchNdmaKarnatakaRssAndCap(
      mockFetch,
      Date.parse('2026-11-18T16:00:00.000Z')
    );
    assert.equal(expiredRes.alerts[0].isActive, false);
    assert.equal(expiredRes.alerts[0].verificationStatus, 'Resolved Incident');
  });

  it('deduplicates DB alerts by externalKey, preserves manual verification, and resolves disappeared official alerts', async () => {
    const nowIso = new Date().toISOString();
    const first = await repoMod.upsertLiveExternalAlerts([
      {
        externalKey: 'test-dedup:001',
        sourceId: 'test-feed',
        sourceName: 'Test CAP Feed',
        sourceUrl: 'https://sachet.ndma.gov.in/',
        category: 'Flooding',
        title: 'Test Official Flood Watch',
        description: 'Observed waterlogging alert.',
        severity: 'MODERATE',
        severityColor: 'amber',
        certainty: 'Observed',
        verificationStatus: 'Official Alert',
        locationLabel: 'Mandya, Karnataka',
        stateName: 'Karnataka',
        districtName: 'Mandya',
        latitude: 12.5218,
        longitude: 76.8951,
        firstReportedAt: nowIso,
        lastUpdatedAt: nowIso,
        isActive: true,
      },
    ]);
    assert.equal(first.insertedCount, 1);
    const createdId = first.newActiveAlerts[0].id;

    // Human operator promotes alert to Verified Incident
    const verified = await repoMod.updateLiveExternalAlertStatus(createdId, 'Verified Incident', 'Confirmed by local unit');
    assert.equal(verified?.verificationStatus, 'Verified Incident');

    // Subsequent poll with same externalKey must update timestamps WITHOUT overwriting Verified Incident back to Official Alert
    const second = await repoMod.upsertLiveExternalAlerts([
      {
        externalKey: 'test-dedup:001',
        sourceId: 'test-feed',
        sourceName: 'Test CAP Feed',
        sourceUrl: 'https://sachet.ndma.gov.in/',
        category: 'Flooding',
        title: 'Test Official Flood Watch Updated',
        description: 'Updated description.',
        severity: 'SEVERE',
        severityColor: 'orange',
        certainty: 'Observed',
        verificationStatus: 'Official Alert',
        locationLabel: 'Mandya, Karnataka',
        stateName: 'Karnataka',
        districtName: 'Mandya',
        latitude: 12.5218,
        longitude: 76.8951,
        firstReportedAt: nowIso,
        lastUpdatedAt: new Date(Date.now() + 5000).toISOString(),
        isActive: true,
      },
      {
        externalKey: 'test-dedup:002',
        sourceId: 'test-feed',
        sourceName: 'Test CAP Feed',
        sourceUrl: 'https://sachet.ndma.gov.in/',
        category: 'Heatwave',
        title: 'Second Official Alert',
        description: 'Official alert to be auto-resolved when dropped.',
        severity: 'MODERATE',
        severityColor: 'amber',
        certainty: 'Likely',
        verificationStatus: 'Official Alert',
        locationLabel: 'Mandya, Karnataka',
        stateName: 'Karnataka',
        districtName: 'Mandya',
        latitude: 12.5218,
        longitude: 76.8951,
        firstReportedAt: nowIso,
        lastUpdatedAt: nowIso,
        isActive: true,
      },
    ]);
    assert.equal(second.insertedCount, 1);
    assert.equal(second.updatedCount, 1);

    const reloaded = await repoMod.getLiveExternalAlertById(createdId);
    assert.equal(reloaded?.verificationStatus, 'Verified Incident');
    assert.equal(reloaded?.title, 'Test Official Flood Watch Updated');

    // When test-dedup:002 disappears from upstream Official Alert feed, markStaleSourceAlertsResolved marks it resolved
    const resolvedCnt = await repoMod.markStaleSourceAlertsResolved('test-feed', ['test-dedup:001']);
    assert.equal(resolvedCnt, 1);

    // Clean up test-feed records so subsequent API tests start cleanly
    await repoMod.updateLiveExternalAlertStatus(createdId, 'Resolved Incident');
  });

  it('computes honest Mysuru SGS + What-If deltas and enforces RBAC + WebSocket updates on API endpoints', async () => {
    // 1. Public GET /api/live-incidents?region=mysuru returns honest zero-state & seeded Mysuru hospitals
    const pubRes = await fetch(`${baseUrl}/api/live-incidents?region=mysuru`);
    assert.equal(pubRes.status, 200);
    const pubData = (await pubRes.json()) as {
      hasActiveLocalIncidents: boolean;
      zeroStateMessage: string;
      safetyGap: { localityName: string; nearestSupportHub: { name: string } | null; isInformationalOnly: boolean };
    };
    assert.equal(pubData.hasActiveLocalIncidents, false);
    assert.equal(pubData.zeroStateMessage, 'NO VERIFIED ACTIVE INCIDENTS — CONTINUOUS MONITORING ACTIVE.');
    assert.equal(pubData.safetyGap.localityName, 'Mysuru');
    assert.equal(pubData.safetyGap.isInformationalOnly, true);
    assert.ok(pubData.safetyGap.nearestSupportHub, 'Expected seeded Mysuru support hub');

    // 2. Mysuru intel with What-If hospital_offline computes valid delta
    const intelRes = await fetch(`${baseUrl}/api/live-incidents/mysuru-intel?scenario=hospital_offline`);
    assert.equal(intelRes.status, 200);
    const intelData = (await intelRes.json()) as {
      whatIf: { isSimulation: boolean; simulatedScore: number; baselineScore: number };
    };
    assert.equal(intelData.whatIf.isSimulation, true);
    assert.ok(intelData.whatIf.simulatedScore >= intelData.whatIf.baselineScore);

    // 3. Regular user cannot trigger manual sync or change verification status (RBAC 403)
    const demoUserRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    const demoUser = (await demoUserRes.json()) as { token: string };

    const forbiddenSync = await fetch(`${baseUrl}/api/live-incidents/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${demoUser.token}` },
    });
    assert.equal(forbiddenSync.status, 403);

    // 4. Operator login + seed one active alert + verify via PATCH triggers WebSocket broadcast
    const opRes = await fetch(`${baseUrl}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opData = (await opRes.json()) as { token: string };

    const wsMessages: Array<{ type?: string }> = [];
    const ws = new WebSocket(`${wsBaseUrl}/ws/realtime?token=${encodeURIComponent(demoUser.token)}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS connect timeout')), 4000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    ws.on('message', (raw) => {
      try {
        wsMessages.push(JSON.parse(raw.toString()) as { type?: string });
      } catch {
        // ignore
      }
    });

    const seeded = await repoMod.upsertLiveExternalAlerts([
      {
        externalKey: 'mysuru-ws-test:1',
        sourceId: 'ndma-sachet-karnataka-imd',
        sourceName: 'NDMA SACHET Karnataka (IMD Bengaluru)',
        sourceUrl: 'https://sachet.ndma.gov.in/',
        category: 'Heavy Rainfall',
        title: 'Mysuru Heavy Rainfall Advisory',
        description: 'Official CAP test advisory for Mysuru.',
        severity: 'MODERATE',
        severityColor: 'amber',
        certainty: 'Likely',
        verificationStatus: 'Official Alert',
        locationLabel: 'Mysuru, Karnataka',
        stateName: 'Karnataka',
        districtName: 'Mysuru',
        latitude: 12.2958,
        longitude: 76.6394,
        firstReportedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        isActive: true,
      },
    ]);
    const alertId = seeded.newActiveAlerts[0].id;

    const patchForbidden = await fetch(`${baseUrl}/api/live-incidents/${alertId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${demoUser.token}`,
      },
      body: JSON.stringify({ verificationStatus: 'Verified Incident' }),
    });
    assert.equal(patchForbidden.status, 403);

    const patchOk = await fetch(`${baseUrl}/api/live-incidents/${alertId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opData.token}`,
      },
      body: JSON.stringify({
        verificationStatus: 'Verified Incident',
        instructionNote: 'Verified with Mysuru district control room.',
      }),
    });
    assert.equal(patchOk.status, 200);
    const patched = (await patchOk.json()) as { alert: { verificationStatus: string } };
    assert.equal(patched.alert.verificationStatus, 'Verified Incident');

    // Wait briefly for WebSocket delivery
    await new Promise((r) => setTimeout(r, 150));
    ws.close();
    assert.ok(
      wsMessages.some((m) => m.type === 'live_incident:status_updated'),
      'Expected live_incident:status_updated over WebSocket'
    );

    // 5. AI live incident analysis endpoint (bilingual EN/KN safe fallback when GEMINI_API_KEY unset or test env)
    const aiRes = await fetch(`${baseUrl}/api/ai/analyze-live-incident`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opData.token}`,
      },
      body: JSON.stringify({
        region: 'mysuru',
        city: 'Mysuru',
        whatIfQuestion: 'What if K.R. Hospital is overwhelmed?',
        language: 'kn',
      }),
    });
    assert.equal(aiRes.status, 200);
    const aiBody = (await aiRes.json()) as {
      analysis: { isAiAdvisory: boolean; lastMileSurvivalGuidance: string[] };
    };
    assert.equal(aiBody.analysis.isAiAdvisory, true);
    assert.ok(aiBody.analysis.lastMileSurvivalGuidance.length >= 2);
  });

  it('handles offline / failing upstream feeds gracefully in pollAllLiveSources without crashing', async () => {
    const failFetch = (async () => {
      throw new Error('Simulated network failure');
    }) as typeof fetch;

    const summary = await pollerMod.pollAllLiveSources({
      force: true,
      fetchImpl: failFetch,
    });
    assert.ok(summary.sources.length >= 5);
    assert.ok(summary.sources.some((s) => s.status === 'degraded'));
  });
});
