/**
 * k6 Load Test Script for LIFE-LINE AI Staging Environments
 * Covers Scenarios A-H across staged VU ramps (100 -> 500 -> 1,000 -> 5,000 -> 10,000 VUs).
 *
 * Run against dedicated staging URL only (NEVER production):
 *   k6 run -e BASE_URL=https://staging.example.com load-tests/k6-lifeline.js
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');

export const options = {
  scenarios: {
    public_landing_and_directory: {
      executor: 'ramping-vus',
      exec: 'scenarioPublicRead',
      stages: [
        { duration: '15s', target: 100 },
        { duration: '20s', target: 500 },
        { duration: '20s', target: 1000 },
        { duration: '20s', target: 5000 },
        { duration: '15s', target: 10000 },
        { duration: '15s', target: 0 },
      ],
    },
    sos_idempotency_and_pulse: {
      executor: 'ramping-vus',
      exec: 'scenarioSosAndPulse',
      stages: [
        { duration: '15s', target: 50 },
        { duration: '30s', target: 250 },
        { duration: '20s', target: 500 },
        { duration: '15s', target: 0 },
      ],
    },
    websocket_burst: {
      executor: 'ramping-vus',
      exec: 'scenarioWebSocket',
      stages: [
        { duration: '15s', target: 100 },
        { duration: '30s', target: 500 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<500'],
  },
};

export function scenarioPublicRead() {
  const r1 = http.get(`${BASE_URL}/api/ready`);
  check(r1, { 'ready 200 or 503': (r) => r.status === 200 || r.status === 503 });

  const r2 = http.get(`${BASE_URL}/api/support-directory`);
  check(r2, { 'support directory 200': (r) => r.status === 200 });

  const r3 = http.get(`${BASE_URL}/api/maps/sos-clusters?lat=37.7749&lng=-122.4194`);
  check(r3, { 'sos clusters ok/429': (r) => r.status === 200 || r.status === 429 });
  sleep(0.5);
}

export function scenarioSosAndPulse() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/demo-login`,
    JSON.stringify({ role: 'regular_user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (loginRes.status !== 200) {
    sleep(0.5);
    return;
  }
  const token = loginRes.json('token');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const sosPayload = JSON.stringify({
    idempotencyKey: `k6_${__VU}_${__ITER}`,
    title: 'k6 Staging SOS Drill',
    priority: 'HIGH',
    latitude: 37.7749,
    longitude: -122.4194,
    isSimulated: true,
  });

  const s1 = http.post(`${BASE_URL}/api/incidents/sos`, sosPayload, { headers });
  const s2 = http.post(`${BASE_URL}/api/incidents/sos`, sosPayload, { headers });
  check(s1, { 'SOS created/429': (r) => r.status === 201 || r.status === 429 });
  check(s2, { 'SOS dedup/429': (r) => r.status === 200 || r.status === 429 });
  sleep(0.5);
}

export function scenarioWebSocket() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/demo-login`,
    JSON.stringify({ role: 'regular_user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (loginRes.status !== 200) return;
  const token = loginRes.json('token');

  ws.connect(`${WS_URL}/ws/realtime?token=${encodeURIComponent(token)}`, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'ping' }));
      socket.setTimeout(() => socket.close(), 2000);
    });
  });
}
