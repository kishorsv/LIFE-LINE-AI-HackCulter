import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-pulse-test-'));
const dbPath = path.join(tempDir, 'pulse-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

describe('LIFE-LINE PULSE, SafeRoute v2, Shared Journeys, 6 AI Agents & Command Center Hardening', () => {
  let baseUrl = '';
  let shutdown: () => Promise<void>;
  let pulseMod: typeof import('../src/services/pulse.ts');
  let geminiMod: typeof import('../src/services/gemini.ts');

  before(async () => {
    pulseMod = await import('../src/services/pulse.ts');
    geminiMod = await import('../src/services/gemini.ts');
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

  it('fetches Open-Meteo weather with graceful unreachable fallback and never invents danger without evidence', async () => {
    const okFetch = (async () =>
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 24.5,
            precipitation: 0,
            rain: 0,
            weather_code: 0,
            wind_speed_10m: 8.2,
            is_day: 1,
          },
          hourly: {
            visibility: [10000],
            precipitation_probability: [5],
          },
        }),
        { status: 200 }
      )) as typeof fetch;

    const okWeather = await pulseMod.fetchOpenMeteoWeather(12.9716, 77.5946, okFetch);
    assert.equal(okWeather.available, true);
    assert.equal(okWeather.temperatureC, 24.5);
    assert.equal(okWeather.weatherLabel, 'Clear sky');

    const failFetch = (async () => {
      throw new Error('Network offline');
    }) as typeof fetch;
    const offlineWeather = await pulseMod.fetchOpenMeteoWeather(12.9716, 77.5946, failFetch);
    assert.equal(offlineWeather.available, false);

    // Without weather or incidents/reports, predictive risk must return INSUFFICIENT_DATA instead of inventing danger
    const insufficient = pulseMod.computePredictiveRisk({
      latitude: 12.9716,
      longitude: 77.5946,
      weather: offlineWeather,
      incidents: [
        {
          id: 99,
          category: 'Simulated Drill',
          priority: 'CRITICAL',
          status: 'SOS Activated',
          latitude: 12.9716,
          longitude: 77.5946,
          isSimulated: true,
          createdAt: new Date().toISOString(),
        },
      ],
      reports: [],
      supportHubs: [],
    });
    assert.equal(insufficient.riskLevel, 'INSUFFICIENT_DATA');
    assert.equal(insufficient.counts.verifiedNearbyIncidents, 0);
    assert.equal(insufficient.counts.simulatedIncidentsExcluded, 1);

    // With verified incident + non-simulated report + clear weather, computes ELEVATED / MODERATE transparently
    const elevated = pulseMod.computePredictiveRisk({
      latitude: 12.9716,
      longitude: 77.5946,
      weather: okWeather,
      incidents: [
        {
          id: 100,
          category: 'Harassment',
          priority: 'HIGH',
          status: 'SOS Activated',
          latitude: 12.972,
          longitude: 77.595,
          isSimulated: false,
          createdAt: new Date().toISOString(),
        },
      ],
      reports: [
        {
          id: 1,
          category: 'Poor Street Lighting',
          severity: 'HIGH',
          latitude: 12.9722,
          longitude: 77.5948,
          verificationStatus: 'community_unverified',
          isSimulated: false,
          createdAt: new Date().toISOString(),
        },
      ],
      supportHubs: [
        {
          id: 1,
          name: 'City Hospital 24/7',
          category: 'Hospital',
          latitude: 12.973,
          longitude: 77.596,
          is24Hours: true,
        },
      ],
    });
    assert.ok(['MODERATE', 'ELEVATED'].includes(elevated.riskLevel));
    assert.equal(elevated.counts.verifiedNearbyIncidents, 1);
    assert.equal(elevated.counts.communityReportsCount, 1);
    assert.equal(elevated.counts.open24hSupportHubs, 1);
    assert.ok(elevated.evidence.length >= 4);
  });

  it('validates /api/maps/saferoute and scores decoded Google Routes API v2 polylines transparently', async () => {
    const badResp = await fetch(`${baseUrl}/api/maps/saferoute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originLat: 999, originLng: 77.5, destinationLat: 12.9, destinationLng: 77.6 }),
    });
    assert.equal(badResp.status, 400);

    // Truthful 503 when server Maps key is absent
    const prevKey = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    const unconfigured = await fetch(`${baseUrl}/api/maps/saferoute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originLat: 12.9716,
        originLng: 77.5946,
        destinationLat: 12.9784,
        destinationLng: 77.6408,
        travelMode: 'WALK',
      }),
    });
    assert.equal(unconfigured.status, 503);
    if (prevKey) process.env.GOOGLE_MAPS_API_KEY = prevKey;

    // Unit-verify Google Routes v2 decoder & safety ranking using a standard encoded polyline
    // Encodes (38.5, -120.2) -> (40.7, -120.95) -> (43.252, -126.453): '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
    const decoded = pulseMod.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    assert.equal(decoded.length, 3);
    assert.ok(Math.abs(decoded[0].lat - 38.5) < 0.001);

    let capturedBody: Record<string, unknown> | null = null;
    const mockRoutesFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          routes: [
            {
              description: 'Shortcut Alley',
              distanceMeters: 1100,
              duration: '720s',
              polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
            },
            {
              description: 'Illuminated Avenue',
              distanceMeters: 1350,
              duration: '900s',
              polyline: { encodedPolyline: '}_seF~ps|U_ulLnnqC' },
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const scored = await pulseMod.computeSafeRoutesWithGoogle(
      {
        origin: { lat: 38.5, lng: -120.2 },
        destination: { lat: 40.7, lng: -120.95 },
        travelMode: 'WALK',
      },
      'fake-server-maps-key',
      {
        weather: { available: true, source: 'Open-Meteo', retrievedAt: new Date().toISOString(), temperatureC: 20, weatherLabel: 'Clear sky', isDay: true },
        incidents: [
          {
            id: 501,
            category: 'Emergency',
            priority: 'HIGH',
            status: 'SOS Activated',
            latitude: 38.5,
            longitude: -120.2,
            isSimulated: false,
            createdAt: new Date().toISOString(),
          },
        ],
        reports: [],
        supportHubs: [],
      },
      mockRoutesFetch
    );

    assert.equal(scored.available, true);
    assert.equal(scored.routes.length, 2);
    // Ensure WALK mode does NOT send routingPreference: 'TRAFFIC_AWARE'
    assert.equal(capturedBody?.['routingPreference'], undefined);
    // Route 1 should score higher than Route 0 which passes directly over incident at (38.5, -120.2)
    assert.ok(scored.routes[1].safetyScore >= scored.routes[0].safetyScore);
    assert.equal(scored.routes.some((r) => r.isRecommended), true);
  });

  it('supports privacy-conscious safety reports, journey sharing IDOR isolation, 6 AI agents, and responder command workflow', async () => {
    // Register User 1 & User 2
    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pulse.u1@example.com', password: 'Password123!', displayName: 'Pulse User 1' }),
    });
    const s1 = (await r1.json()) as { token: string; user: { id: number } };

    const r2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pulse.u2@example.com', password: 'Password123!', displayName: 'Pulse User 2' }),
    });
    const s2 = (await r2.json()) as { token: string };

    // 1. Anonymous privacy-conscious safety report
    const repResp = await fetch(`${baseUrl}/api/pulse/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({
        category: 'Poor Street Lighting',
        severity: 'MODERATE',
        description: 'Streetlights out near north footbridge.',
        locationLabel: 'North Footbridge',
        latitude: 12.975,
        longitude: 77.599,
        isAnonymous: true,
      }),
    });
    assert.equal(repResp.status, 201);
    const repData = (await repResp.json()) as { report: { reporterLabel: string; isAnonymous: boolean } };
    assert.equal(repData.report.isAnonymous, true);
    assert.equal(repData.report.reporterLabel, 'Anonymous Community Member');

    // 2. Shared Journey lifecycle + cross-user IDOR protection
    const jResp = await fetch(`${baseUrl}/api/journeys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({
        originLabel: 'Library Gate',
        originLat: 12.9716,
        originLng: 77.5946,
        destinationLabel: 'Women Hostel Block B',
        destinationLat: 12.978,
        destinationLng: 77.602,
        travelMode: 'WALK',
        checkInIntervalMinutes: 15,
      }),
    });
    assert.equal(jResp.status, 201);
    const jBody = (await jResp.json()) as { journey: { id: number; status: string } };
    assert.equal(jBody.journey.status, 'Active');

    // User 2 cannot check in or arrive User 1's journey
    const idorResp = await fetch(`${baseUrl}/api/journeys/${jBody.journey.id}/arrive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s2.token}` },
    });
    assert.equal(idorResp.status, 403);

    const checkinResp = await fetch(`${baseUrl}/api/journeys/${jBody.journey.id}/checkin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s1.token}` },
    });
    assert.equal(checkinResp.status, 200);

    const arriveResp = await fetch(`${baseUrl}/api/journeys/${jBody.journey.id}/arrive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s1.token}` },
    });
    assert.equal(arriveResp.status, 200);
    const arriveBody = (await arriveResp.json()) as { journey: { status: string } };
    assert.equal(arriveBody.journey.status, 'Arrived Safe');

    // 3. SafeRoute Agent & Incident Follow-up Agent + Kannada Assistant fallback
    const srAgent = await fetch(`${baseUrl}/api/ai/saferoute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({
        originLabel: 'Library',
        destinationLabel: 'Hostel',
        travelMode: 'WALK',
        routes: [
          {
            routeIndex: 0,
            summary: 'Main Illuminated Avenue',
            durationLabel: '14 min',
            distanceMeters: 1100,
            safetyScore: 88,
            riskLevel: 'LOW',
            nearbyIncidentsCount: 0,
            nearbySupportHubsCount: 2,
            reasons: ['Well lit corridor'],
          },
        ],
      }),
    });
    assert.equal(srAgent.status, 200);
    const srAgentBody = (await srAgent.json()) as { saferoute: { isAiAdvisory: boolean; recommendedRouteIndex: number } };
    assert.equal(srAgentBody.saferoute.isAiAdvisory, true);

    const fuAgent = await fetch(`${baseUrl}/api/ai/follow-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({
        incidentTitle: 'Late Transit Alert',
        incidentStatus: 'Resolved',
        incidentCategory: 'Transit',
        locationLabel: 'Station Plaza',
        language: 'kn',
      }),
    });
    assert.equal(fuAgent.status, 200);
    const fuBody = (await fuAgent.json()) as { followUp: { requiresHumanAuthorization: boolean } };
    assert.equal(fuBody.followUp.requiresHumanAuthorization, true);

    const knReply = await geminiMod.runSupportAssistantChat(
      { history: [], message: 'I feel unsafe walking home', language: 'kn' },
      { client: null }
    );
    assert.ok(knReply.reply.includes('112'));

    // 4. Mark all notifications read + paginated incidents
    const readAllResp = await fetch(`${baseUrl}/api/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${s1.token}` },
    });
    assert.equal(readAllResp.status, 200);

    const pageResp = await fetch(`${baseUrl}/api/incidents?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${s1.token}` },
    });
    assert.equal(pageResp.status, 200);
    const pageBody = (await pageResp.json()) as { pagination: { page: number; limit: number; total: number } };
    assert.equal(pageBody.pagination.page, 1);
    assert.equal(pageBody.pagination.limit, 10);

    // 5. Operator Availability + Responder Assignment + Analytics avgResolutionSeconds
    const opLogin = await fetch(`${baseUrl}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    const opSession = (await opLogin.json()) as { token: string; user: { id: number } };

    // Regular user cannot update responder availability
    const forbiddenAvail = await fetch(`${baseUrl}/api/operator/availability`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({ status: 'Responding' }),
    });
    assert.equal(forbiddenAvail.status, 403);

    const okAvail = await fetch(`${baseUrl}/api/operator/availability`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opSession.token}` },
      body: JSON.stringify({ status: 'Responding' }),
    });
    assert.equal(okAvail.status, 200);

    // Create an SOS then assign responder
    const sosResp = await fetch(`${baseUrl}/api/incidents/sos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s1.token}` },
      body: JSON.stringify({ idempotencyKey: 'pulse_assign_sos_1', title: 'Operator Assignment SOS' }),
    });
    const sosData = (await sosResp.json()) as { incident: { id: number } };

    const assignResp = await fetch(`${baseUrl}/api/operator/incidents/${sosData.incident.id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opSession.token}` },
      body: JSON.stringify({ operatorUserId: opSession.user.id }),
    });
    assert.equal(assignResp.status, 200);
    const assignData = (await assignResp.json()) as { incident: { acknowledgedByUserId: number } };
    assert.equal(assignData.incident.acknowledgedByUserId, opSession.user.id);

    const analyticsResp = await fetch(`${baseUrl}/api/analytics`, {
      headers: { Authorization: `Bearer ${opSession.token}` },
    });
    assert.equal(analyticsResp.status, 200);
    const analyticsBody = (await analyticsResp.json()) as { responders: { responding: number } };
    assert.ok(analyticsBody.responders.responding >= 1);
  });
});
