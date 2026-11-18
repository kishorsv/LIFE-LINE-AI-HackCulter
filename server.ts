import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { closePool, getPoolStats } from './src/db/index.ts';
import {
  addTrustedContact,
  assignIncidentToOperator,
  checkDatabaseHealth,
  checkInSafetyJourney,
  completePasswordReset,
  countAllIncidentsForOperator,
  countAllUsers,
  countAuditLogs,
  countIncidentsForUser,
  countNotificationsForUser,
  createIncident,
  createNotification,
  createSafetyJourney,
  createSafetyReport,
  deleteTrustedContact,
  deleteUserAccount,
  getDemoAccounts,
  getIncidentById,
  getLatestRealtimeEventSeq,
  getLiveExternalAlertById,
  getOperationalAnalytics,
  getOrInitSharedRuntimeSessionSecret,
  getSafetyJourneyById,
  getUserProfile,
  initializeDatabase,
  initiatePasswordReset,
  listAllIncidentsForOperator,
  listAiRecommendationsForUser,
  listAuditLogs,
  listIncidentsForPulse,
  listIncidentsForUser,
  listLiveExternalAlerts,
  listLiveFeedSyncRuns,
  listNotificationsForUser,
  listOperatorUserIds,
  listRealtimeEventsSince,
  listRespondersWithAvailability,
  listSafetyJourneysForUser,
  listSafetyReportsForPulse,
  listSupportDirectory,
  listTrustedContacts,
  listUsersForAdminPaginated,
  loginEmailUser,
  markAllNotificationsRead,
  markNotificationRead,
  recordRealtimeEvent,
  refreshSafetyJourneyRisk,
  registerEmailUser,
  resendVerificationCode,
  ResponderAvailabilityStatus,
  sanitizeIncidentForViewer,
  saveAiAssessment,
  updateIncidentDeliveryState,
  updateIncidentStatus,
  updateLiveExternalAlertStatus,
  updateResponderAvailability,
  updateSafetyJourneyState,
  updateTrustedContact,
  updateUserProfile,
  updateUserRole,
  UserRole,
  verifyUserEmailCode,
  writeAuditLog,
} from './src/db/repository.ts';
import firebaseConfig from './firebase-applet-config.json';
import {
  AuthRequest,
  FirebaseTokenVerifier,
  initializeRuntimeSessionSecret,
  requireAuth,
  requireRole,
  resolveUserFromToken,
  signAppToken,
  verifyAndSyncFirebaseUser,
} from './src/middleware/auth.ts';
import { createRateLimiter } from './src/middleware/rateLimit.ts';
import {
  ALLOWED_MAP_PLACE_TYPES,
  isValidEmail,
  isValidIdempotencyKey,
  isValidLatitude,
  isValidLongitude,
  isValidPassword,
  isValidPhone,
  isValidVerificationCode,
  normalizeEmail,
  parsePagination,
  parsePositiveInt,
  sanitizeBoundedString,
  VALID_INCIDENT_STATUSES,
  VALID_LANGUAGES,
  VALID_LOCATION_MODES,
  VALID_PRIORITIES,
  VALID_REPORT_SEVERITIES,
  VALID_RESPONDER_STATUSES,
  VALID_SAFETY_STATUSES,
  VALID_THEMES,
  VALID_TRAVEL_MODES,
  VALID_USER_ROLES,
  validateOptionalCoordinates,
} from './src/lib/validation.ts';
import {
  GEMINI_MODELS,
  GeminiServiceError,
  getAiRuntimeStatus,
  isGeminiConfigured,
  runEmergencyAssessmentAgent,
  runEmergencyCoordinationAgent,
  runIncidentFollowUpAgent,
  runLiveIncidentIntelligenceAgent,
  runResourceDiscoveryAgent,
  runSafeRouteAgent,
  runSafetyIntelligenceAgent,
  runSupportAssistantChat,
  synthesizeSafetyGuidanceSpeech,
  transcribeAudioNote,
} from './src/services/gemini.ts';
import { dispatchEmergencyNotifications, DispatchSummary } from './src/services/notifications.ts';
import {
  buildSosIncidentClusters,
  computePredictiveRisk,
  computeSafeRoutesWithGoogle,
  fetchOpenMeteoWeather,
} from './src/services/pulse.ts';
import { fetchMysuruAndCityWeather, resolveIndiaDistrictCoordinates } from './src/services/liveFeeds.ts';
import { computeSafetyGapScore, runDeterministicWhatIfScenario } from './src/services/incidentIntelligence.ts';
import { pollAllLiveSources, startLiveFeedPolling, stopLiveFeedPolling } from './src/services/livePoller.ts';
import { cacheQueue } from './src/services/cacheQueue.ts';
import { httpMetricsMiddleware, metrics } from './src/services/metrics.ts';
import { errorHandlerMiddleware, requestLoggerMiddleware } from './src/services/logger.ts';
import type { LiveIncidentVerificationStatus } from './src/types/lifeline.ts';

const MAPS_ATTRIBUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';
const OPERATOR_ROLES: UserRole[] = ['emergency_operator', 'support_organization', 'administrator'];
const MAX_REALTIME_PER_USER = Math.max(1, Number(process.env.WS_MAX_REALTIME_PER_USER || 5));
const MAX_REALTIME_TOTAL = Math.max(50, Number(process.env.WS_MAX_REALTIME_TOTAL || 2000));
const MAX_LIVE_PER_USER = Math.max(1, Number(process.env.WS_MAX_LIVE_PER_USER || 2));
const MAX_LIVE_TOTAL = Math.max(10, Number(process.env.WS_MAX_LIVE_TOTAL || 100));
const REALTIME_REPLAY_LIMIT = 500;
const WS_HEARTBEAT_INTERVAL_MS = 25_000;
const REALTIME_BUS_CHANNEL = 'lifeline:realtime:events';

function isConfiguredKey(val: string | undefined, placeholder: string): boolean {
  const trimmed = (val || '').trim();
  return Boolean(trimmed && trimmed !== placeholder);
}

function getServerMapsApiKey(): string {
  if (isConfiguredKey(process.env.GOOGLE_MAPS_API_KEY, 'MY_GOOGLE_MAPS_API_KEY')) {
    return process.env.GOOGLE_MAPS_API_KEY!.trim();
  }
  return '';
}

function getPublicClientMapsApiKey(): string {
  if (isConfiguredKey(process.env.VITE_GOOGLE_MAPS_API_KEY, 'MY_GOOGLE_MAPS_API_KEY')) {
    return process.env.VITE_GOOGLE_MAPS_API_KEY!.trim();
  }
  return '';
}

function isDemoLoginAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_LOGIN === 'true';
}

function extractWsToken(req: http.IncomingMessage): string {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken.trim();
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export async function createAppServer(options?: {
  enableVite?: boolean;
  firebaseVerifier?: FirebaseTokenVerifier;
}) {
  // Initialize authoritative DB first, then resolve or provision shared CSPRNG SESSION_SECRET
  await initializeDatabase();
  await initializeRuntimeSessionSecret(getOrInitSharedRuntimeSessionSecret);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(compression());

  // Security headers without inline style breakage for Google Maps / Tailwind SPA
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self)');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Multimodal AI endpoints retain a 10 MB cap; all other routes enforce strict 256 KB limit
  const largeAiJsonParser = express.json({ limit: '10mb' });
  app.use('/api/ai/assess-emergency', largeAiJsonParser);
  app.use('/api/ai/transcribe', largeAiJsonParser);
  app.use(express.json({ limit: '256kb' }));
  app.use(requestLoggerMiddleware);

  const MAX_INFLIGHT_REQUESTS = Math.max(50, Number(process.env.MAX_INFLIGHT_REQUESTS || 1500));
  let isDraining = false;

  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/health/db' || req.path === '/ready') {
      next();
      return;
    }
    if (isDraining) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'Server instance is draining for shutdown.' });
    }
    const inFlight = metrics.incrementInFlight();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        metrics.decrementInFlight();
      }
    };
    res.on('finish', release);
    res.on('close', release);
    if (inFlight > MAX_INFLIGHT_REQUESTS) {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'Server capacity threshold reached. Please retry briefly.' });
    }
    next();
  });
  app.use(httpMetricsMiddleware);

  const allowedOrigins = new Set(
    [
      process.env.APP_URL || '',
      ...(process.env.CORS_ALLOWED_ORIGINS || '').split(','),
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
    ]
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );

  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : '';
    if (origin && (allowedOrigins.has(origin) || allowedOrigins.size === 0)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Google-Access-Token');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  interface RealtimeClient {
    ws: WebSocket;
    userId: number;
    role: UserRole;
    isAlive: boolean;
    msgWindowStart: number;
    msgCount: number;
  }

  interface BufferedRealtimeEvent {
    seq: number;
    eventId: string;
    targetUserId?: number;
    includeOperators: boolean;
    broadcastAll?: boolean;
    userPayload: Record<string, unknown>;
    operatorPayload: Record<string, unknown>;
  }

  const realtimeClients = new Set<RealtimeClient>();
  const liveClients = new Set<{
    ws: WebSocket;
    userId: number;
    isAlive: boolean;
    msgWindowStart: number;
    msgCount: number;
  }>();
  const eventReplayBuffer: BufferedRealtimeEvent[] = [];
  let currentEventSeq = await getLatestRealtimeEventSeq().catch(() => 0);

  function deliverLocalRealtimeEvent(ev: BufferedRealtimeEvent) {
    if (!cacheQueue.markEventSeen(ev.eventId)) return;
    currentEventSeq = Math.max(currentEventSeq, ev.seq);

    eventReplayBuffer.push(ev);
    if (eventReplayBuffer.length > REALTIME_REPLAY_LIMIT) {
      eventReplayBuffer.shift();
    }

    const serializedUser = JSON.stringify(ev.userPayload);
    const serializedOp = JSON.stringify(ev.operatorPayload);

    for (const client of realtimeClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const isOperator = OPERATOR_ROLES.includes(client.role);
      const isTargetUser = ev.targetUserId !== undefined && client.userId === ev.targetUserId;
      if (ev.broadcastAll) {
        client.ws.send(isOperator ? serializedOp : serializedUser);
      } else if (ev.includeOperators && isOperator) {
        client.ws.send(serializedOp);
      } else if (isTargetUser) {
        client.ws.send(serializedUser);
      }
    }
  }

  await cacheQueue.subscribeBus(REALTIME_BUS_CHANNEL, (raw) => {
    try {
      const parsed = JSON.parse(raw) as BufferedRealtimeEvent;
      if (!parsed || typeof parsed.eventId !== 'string') return;
      deliverLocalRealtimeEvent(parsed);
    } catch {
      // ignore malformed bus message
    }
  });

  function pushAndBroadcastRealtimeEvent(params: {
    targetUserId?: number;
    includeOperators?: boolean;
    broadcastAll?: boolean;
    userPayload: Record<string, unknown>;
    operatorPayload?: Record<string, unknown>;
  }) {
    const seq = ++currentEventSeq;
    const eventId = crypto.randomUUID();
    const includeOperators = Boolean(params.includeOperators);
    const broadcastAll = Boolean(params.broadcastAll);
    const userMsg = { ...params.userPayload, seq };
    const opMsg = { ...(params.operatorPayload || params.userPayload), seq };

    const ev: BufferedRealtimeEvent = {
      seq,
      eventId,
      targetUserId: params.targetUserId,
      includeOperators,
      broadcastAll,
      userPayload: userMsg,
      operatorPayload: opMsg,
    };

    // Deliver immediately to local sockets and mark eventId seen before Redis fan-out
    deliverLocalRealtimeEvent(ev);

    if (cacheQueue.isRedisActive()) {
      void cacheQueue.publishBus(REALTIME_BUS_CHANNEL, ev as unknown as Record<string, unknown>);
    }

    // Durable persistence for multi-instance replay (?since=<seq>) and restarts
    void recordRealtimeEvent({
      eventId,
      targetUserId: params.targetUserId ?? undefined,
      includeOperators,
      userPayload: userMsg,
      operatorPayload: opMsg,
    }).catch((err) => {
      console.error('[realtime] Failed to persist event:', err);
    });
  }

  function sendRealtimeToUser(userId: number, payload: Record<string, unknown>) {
    pushAndBroadcastRealtimeEvent({
      targetUserId: userId,
      includeOperators: false,
      userPayload: payload,
    });
  }

  // Rate Limiters
  const loginLimiter = createRateLimiter({
    name: 'auth_login',
    windowMs: 15 * 60 * 1000,
    maxRequests: 15,
    keyGenerator: (req) => `${req.ip || 'ip'}:${String((req.body as { email?: string })?.email || '').toLowerCase()}`,
    message: 'Too many login attempts. Please wait 15 minutes before trying again.',
  });

  const registerLimiter = createRateLimiter({
    name: 'auth_register',
    windowMs: 15 * 60 * 1000,
    maxRequests: 8,
    message: 'Too many registration attempts from this address. Please try again later.',
  });

  const resetLimiter = createRateLimiter({
    name: 'auth_reset',
    windowMs: 15 * 60 * 1000,
    maxRequests: 8,
    keyGenerator: (req) => `${req.ip || 'ip'}:${String((req.body as { email?: string })?.email || '').toLowerCase()}`,
    message: 'Too many password reset attempts. Please wait before trying again.',
  });

  const verifyLimiter = createRateLimiter({
    name: 'auth_verify',
    windowMs: 15 * 60 * 1000,
    maxRequests: 12,
    message: 'Too many verification attempts. Please wait before trying again.',
  });

  const sosLimiter = createRateLimiter({
    name: 'sos_dispatch',
    windowMs: 60 * 1000,
    maxRequests: 15,
    keyGenerator: (req) => String((req as AuthRequest).appUser?.id || req.ip || 'anon'),
    message: 'SOS rate limit reached. Wait briefly or dial local emergency services directly.',
  });

  const mapsLimiter = createRateLimiter({
    name: 'maps_proxy',
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: 'Too many map lookup requests. Please wait a moment.',
  });

  const aiLimiter = createRateLimiter({
    name: 'ai_agents',
    windowMs: 60 * 1000,
    maxRequests: 25,
    keyGenerator: (req) => String((req as AuthRequest).appUser?.id || req.ip || 'anon'),
    message: 'AI agent rate limit reached. Please wait a moment before sending another request.',
  });

  const pulseReportLimiter = createRateLimiter({
    name: 'pulse_reports',
    windowMs: 15 * 60 * 1000,
    maxRequests: 15,
    keyGenerator: (req) => String((req as AuthRequest).appUser?.id || req.ip || 'anon'),
    message: 'Too many community safety reports submitted. Please wait before submitting another.',
  });

  const vitalsLimiter = createRateLimiter({
    name: 'web_vitals',
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many web vitals reports.',
  });

  // ========================
  // HEALTH & NON-SECRET CLIENT CONFIG
  // ========================
  app.get('/api/health', async (_req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.status(dbHealth.ok ? 200 : 503).json({
      status: dbHealth.ok ? 'ok' : 'degraded',
      service: 'LIFE-LINE AI',
      timestamp: new Date().toISOString(),
      database: dbHealth,
      redisActive: cacheQueue.isRedisActive(),
      aiConfigured: isGeminiConfigured(),
      aiModels: GEMINI_MODELS,
      mapsConfigured: Boolean(getServerMapsApiKey() || getPublicClientMapsApiKey()),
      notificationProviders: {
        resendConfigured: Boolean(process.env.RESEND_API_KEY),
        twilioConfigured: Boolean(
          process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
        ),
      },
    });
  });

  app.get('/api/health/db', async (_req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.status(dbHealth.ok ? 200 : 503).json(dbHealth);
  });

  app.get('/api/ready', async (_req, res) => {
    if (isDraining) {
      return res.status(503).json({ ready: false, reason: 'draining' });
    }
    const dbHealth = await checkDatabaseHealth();
    if (!dbHealth.ok) {
      return res.status(503).json({ ready: false, reason: 'database_unavailable', database: dbHealth });
    }
    res.json({
      ready: true,
      dialect: dbHealth.dialect,
      redisActive: cacheQueue.isRedisActive(),
      inFlight: metrics.getInFlight(),
    });
  });

  app.get('/api/config/public', (_req, res) => {
    const fb = firebaseConfig as {
      projectId?: string;
      authDomain?: string;
      appId?: string;
      apiKey?: string;
      oAuthClientId?: string;
    };
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json({
      mapsApiKey: getPublicClientMapsApiKey(),
      appUrl: process.env.APP_URL || '',
      demoSandboxEnabled: isDemoLoginAllowed(),
      developerContactEmail: (process.env.DEVELOPER_CONTACT_EMAIL || '').trim(),
      googleAuth: {
        configured: Boolean(fb.projectId && fb.authDomain && fb.appId && fb.apiKey),
        authDomain: fb.authDomain || '',
        oAuthClientConfigured: Boolean(fb.oAuthClientId && fb.oAuthClientId.includes('.apps.googleusercontent.com')),
      },
    });
  });

  app.post('/api/metrics/vitals', vitalsLimiter, (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      lcpMs?: unknown;
      inpMs?: unknown;
      cls?: unknown;
      ttfbMs?: unknown;
    };
    const sanitizeMetric = (val: unknown, max: number): number | undefined => {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > max) return undefined;
      return val;
    };
    metrics.recordWebVitals({
      lcpMs: sanitizeMetric(body.lcpMs, 60_000),
      inpMs: sanitizeMetric(body.inpMs, 30_000),
      cls: sanitizeMetric(body.cls, 25),
      ttfbMs: sanitizeMetric(body.ttfbMs, 60_000),
    });
    res.status(202).json({ ok: true });
  });

  // ========================
  // AUTHENTICATION & RBAC
  // ========================
  app.post('/api/auth/register', registerLimiter, async (req, res) => {
    try {
      const { email, password, displayName, role } = req.body as {
        email?: unknown;
        password?: unknown;
        displayName?: unknown;
        role?: unknown;
      };

      if (!isValidEmail(email) || !isValidPassword(password)) {
        return res
          .status(400)
          .json({ error: 'Valid email and password (8 to 128 characters) are required.' });
      }

      const normalized = normalizeEmail(email);

      // Force public registration to regular_user ONLY
      if (role !== undefined && role !== 'regular_user') {
        await writeAuditLog({
          actorEmail: normalized,
          actorRole: 'public',
          action: 'BLOCKED_ELEVATED_SELF_REGISTRATION',
          resourceType: 'user',
          details: { attemptedRole: String(role) },
          ipAddress: req.ip,
        });
        return res.status(403).json({
          error:
            'Public self-registration is restricted to Regular User accounts. Operator, Support Organization, and Administrator roles must be assigned by an Administrator.',
        });
      }

      const safeName = sanitizeBoundedString(displayName, 80) || normalized.split('@')[0];
      const { user, verificationCode } = await registerEmailUser({
        email: normalized,
        password,
        displayName: safeName,
      });

      const token = signAppToken(user);
      await writeAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'USER_REGISTERED',
        resourceType: 'user',
        resourceId: String(user.id),
        ipAddress: req.ip,
      });

      res.status(201).json({
        user,
        token,
        verificationCodePreview:
          process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY ? verificationCode : undefined,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body as { email?: unknown; password?: unknown };
      if (!isValidEmail(email) || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Valid email and password are required.' });
      }
      const user = await loginEmailUser(normalizeEmail(email), password);
      const token = signAppToken(user);
      await writeAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'USER_LOGIN',
        resourceType: 'user',
        resourceId: String(user.id),
        ipAddress: req.ip,
      });
      res.json({ user, token });
    } catch (err) {
      const emailStr = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : 'unknown';
      await writeAuditLog({
        actorEmail: emailStr,
        actorRole: 'public',
        action: 'USER_LOGIN_FAILED',
        resourceType: 'user',
        ipAddress: req.ip,
      }).catch(() => {});
      res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid credentials.' });
    }
  });

  app.post('/api/auth/firebase', loginLimiter, async (req, res) => {
    try {
      const { idToken } = req.body as { idToken?: unknown };
      if (typeof idToken !== 'string' || idToken.trim().length < 20) {
        return res.status(400).json({ error: 'A valid Firebase ID token is required.' });
      }
      const user = await verifyAndSyncFirebaseUser(idToken.trim(), options?.firebaseVerifier);
      const token = signAppToken(user);
      await writeAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        action: 'USER_GOOGLE_LOGIN',
        resourceType: 'user',
        resourceId: String(user.id),
        ipAddress: req.ip,
      });
      res.json({ user, token });
    } catch (err) {
      await writeAuditLog({
        actorEmail: 'firebase_oauth',
        actorRole: 'public',
        action: 'USER_GOOGLE_LOGIN_FAILED',
        resourceType: 'user',
        ipAddress: req.ip,
      }).catch(() => {});
      const message = err instanceof Error ? err.message : 'Firebase token verification failed.';
      res.status(401).json({ error: message });
    }
  });

  app.post('/api/auth/verify-email', verifyLimiter, requireAuth, async (req: AuthRequest, res) => {
    try {
      const { code } = req.body as { code?: unknown };
      if (!isValidVerificationCode(code)) {
        return res.status(400).json({ error: 'A valid 6-digit verification code is required.' });
      }
      const updated = await verifyUserEmailCode(req.appUser!.id, code.trim());
      await writeAuditLog({
        actorUserId: updated.id,
        actorEmail: updated.email,
        actorRole: updated.role,
        action: 'EMAIL_VERIFIED',
        resourceType: 'user',
        resourceId: String(updated.id),
        ipAddress: req.ip,
      });
      res.json({ user: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Email verification failed.' });
    }
  });

  app.post('/api/auth/resend-verification', verifyLimiter, requireAuth, async (req: AuthRequest, res) => {
    try {
      const code = await resendVerificationCode(req.appUser!.id);
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'VERIFICATION_CODE_RESENT',
        resourceType: 'user',
        resourceId: String(req.appUser!.id),
        ipAddress: req.ip,
      });
      res.json({
        message: 'A new 6-digit verification code has been issued (expires in 15 minutes).',
        verificationCodePreview:
          process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY ? code : undefined,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to resend verification code.' });
    }
  });

  app.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
    try {
      const { email } = req.body as { email?: unknown };
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Valid email is required.' });
      }
      const result = await initiatePasswordReset(normalizeEmail(email));
      res.json({
        message: 'If an account matches that email, a password reset code has been generated (expires in 15 minutes).',
        resetCodePreview:
          process.env.NODE_ENV !== 'production' && !process.env.RESEND_API_KEY && result
            ? result.resetCode
            : undefined,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not initiate password reset.' });
    }
  });

  app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
    try {
      const { email, code, newPassword } = req.body as {
        email?: unknown;
        code?: unknown;
        newPassword?: unknown;
      };
      if (!isValidEmail(email) || !isValidVerificationCode(code) || !isValidPassword(newPassword)) {
        return res
          .status(400)
          .json({ error: 'Valid email, 6-digit reset code, and password (8 to 128 characters) are required.' });
      }
      const result = await completePasswordReset(normalizeEmail(email), code.trim(), newPassword);
      if (!result.ok) {
        return res.status(400).json({ error: result.reason || 'Invalid or expired reset code.' });
      }
      await writeAuditLog({
        actorEmail: normalizeEmail(email),
        actorRole: 'public',
        action: 'PASSWORD_RESET_COMPLETED',
        resourceType: 'user',
        ipAddress: req.ip,
      });
      res.json({ message: 'Password updated successfully.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Password reset failed.' });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
    const profileData = await getUserProfile(req.appUser!.id);
    res.json({ user: req.appUser, ...profileData });
  });

  app.get('/api/auth/demo-accounts', async (_req, res) => {
    if (!isDemoLoginAllowed()) {
      return res.status(403).json({ error: 'Demo sandbox login is disabled in production.' });
    }
    const accounts = await getDemoAccounts();
    res.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email,
        displayName: a.displayName,
        role: a.role,
        isDemoAccount: true,
      })),
    });
  });

  app.post('/api/auth/demo-login', loginLimiter, async (req, res) => {
    try {
      if (!isDemoLoginAllowed()) {
        return res.status(403).json({ error: 'Demo sandbox login is disabled in production.' });
      }
      const { role } = req.body as { role?: unknown };
      const requestedRole = typeof role === 'string' ? role : 'regular_user';
      if (!(VALID_USER_ROLES as readonly string[]).includes(requestedRole)) {
        return res.status(400).json({ error: 'Invalid demo role requested.' });
      }

      const accounts = await getDemoAccounts();
      const target = accounts.find((a) => a.role === requestedRole);
      if (!target) {
        return res.status(404).json({ error: 'Requested demo sandbox account not found.' });
      }
      const token = signAppToken(target);
      await writeAuditLog({
        actorUserId: target.id,
        actorEmail: target.email,
        actorRole: target.role,
        action: 'DEMO_SANDBOX_LOGIN',
        resourceType: 'user',
        resourceId: String(target.id),
        ipAddress: req.ip,
      });
      res.json({ user: target, token });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Demo login failed.' });
    }
  });

  // ========================
  // PROFILE & ACCOUNT DELETION
  // ========================
  app.get('/api/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      const data = await getUserProfile(req.appUser!.id);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load profile.' });
    }
  });

  app.put('/api/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;

      if (body.safetyStatus !== undefined && !(VALID_SAFETY_STATUSES as readonly string[]).includes(String(body.safetyStatus))) {
        return res.status(400).json({ error: 'Invalid safetyStatus value.' });
      }
      if (body.theme !== undefined && !(VALID_THEMES as readonly string[]).includes(String(body.theme))) {
        return res.status(400).json({ error: 'Theme must be dark or light.' });
      }
      if (
        body.locationConsentMode !== undefined &&
        !(VALID_LOCATION_MODES as readonly string[]).includes(String(body.locationConsentMode))
      ) {
        return res.status(400).json({ error: 'Invalid locationConsentMode value.' });
      }
      if (body.phone !== undefined && !isValidPhone(body.phone)) {
        return res.status(400).json({ error: 'Invalid phone number format.' });
      }
      if (body.lastKnownLat !== undefined || body.lastKnownLng !== undefined) {
        const coordCheck = validateOptionalCoordinates(body.lastKnownLat, body.lastKnownLng);
        if (!coordCheck.valid) {
          return res.status(400).json({ error: coordCheck.error });
        }
      }
      if (
        body.preferredLanguage !== undefined &&
        !(VALID_LANGUAGES as readonly string[]).includes(String(body.preferredLanguage))
      ) {
        return res.status(400).json({ error: 'preferredLanguage must be "en" or "kn".' });
      }
      if (body.dataRetentionDays !== undefined) {
        const days = Number(body.dataRetentionDays);
        if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
          return res.status(400).json({ error: 'dataRetentionDays must be between 1 and 3650.' });
        }
      }

      const sanitizedPayload = {
        fullName: body.fullName !== undefined ? sanitizeBoundedString(body.fullName, 100) : undefined,
        phone: body.phone !== undefined ? sanitizeBoundedString(body.phone, 32) : undefined,
        emergencyNotes: body.emergencyNotes !== undefined ? sanitizeBoundedString(body.emergencyNotes, 1000) : undefined,
        medicalNotes: body.medicalNotes !== undefined ? sanitizeBoundedString(body.medicalNotes, 1000) : undefined,
        bloodType: body.bloodType !== undefined ? sanitizeBoundedString(body.bloodType, 16) : undefined,
        preferredLanguage: body.preferredLanguage !== undefined ? String(body.preferredLanguage) : undefined,
        safetyStatus: body.safetyStatus !== undefined ? String(body.safetyStatus) : undefined,
        lastKnownLat: body.lastKnownLat === null ? null : typeof body.lastKnownLat === 'number' ? body.lastKnownLat : undefined,
        lastKnownLng: body.lastKnownLng === null ? null : typeof body.lastKnownLng === 'number' ? body.lastKnownLng : undefined,
        lastLocationLabel: body.lastLocationLabel !== undefined ? sanitizeBoundedString(body.lastLocationLabel, 240) : undefined,
        locationSharingConsent:
          body.locationSharingConsent !== undefined ? Boolean(body.locationSharingConsent) : undefined,
        theme: body.theme !== undefined ? (body.theme as 'dark' | 'light') : undefined,
        enableEmailAlerts: body.enableEmailAlerts !== undefined ? Boolean(body.enableEmailAlerts) : undefined,
        enableSmsAlerts: body.enableSmsAlerts !== undefined ? Boolean(body.enableSmsAlerts) : undefined,
        enableInAppAlerts: body.enableInAppAlerts !== undefined ? Boolean(body.enableInAppAlerts) : undefined,
        locationConsentMode: body.locationConsentMode !== undefined ? String(body.locationConsentMode) : undefined,
        dataRetentionDays: body.dataRetentionDays !== undefined ? Number(body.dataRetentionDays) : undefined,
        demoModeEnabled: body.demoModeEnabled !== undefined ? Boolean(body.demoModeEnabled) : undefined,
      };

      const updated = await updateUserProfile(req.appUser!.id, sanitizedPayload);
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'PROFILE_UPDATED',
        resourceType: 'user_profile',
        resourceId: String(req.appUser!.id),
        ipAddress: req.ip,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update profile.' });
    }
  });

  app.delete('/api/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      if (req.appUser!.isDemoAccount) {
        return res.status(400).json({ error: 'Shared demo sandbox accounts cannot be deleted.' });
      }
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'ACCOUNT_DELETED',
        resourceType: 'user',
        resourceId: String(req.appUser!.id),
        ipAddress: req.ip,
      });
      await deleteUserAccount(req.appUser!.id);
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete account.' });
    }
  });

  // ========================
  // TRUSTED CONTACTS
  // ========================
  app.get('/api/contacts', requireAuth, async (req: AuthRequest, res) => {
    try {
      const contacts = await listTrustedContacts(req.appUser!.id);
      res.json({ contacts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load contacts.' });
    }
  });

  app.post('/api/contacts', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const name = sanitizeBoundedString(body.name, 80);
      if (!name) {
        return res.status(400).json({ error: 'Contact name is required (1 to 80 characters).' });
      }
      const emailRaw = sanitizeBoundedString(body.email, 254);
      if (emailRaw && !isValidEmail(emailRaw)) {
        return res.status(400).json({ error: 'Contact email address is invalid.' });
      }
      const phoneRaw = sanitizeBoundedString(body.phone, 32);
      if (phoneRaw && !isValidPhone(phoneRaw)) {
        return res.status(400).json({ error: 'Contact phone number format is invalid.' });
      }

      const contact = await addTrustedContact(req.appUser!.id, {
        name,
        relationship: sanitizeBoundedString(body.relationship, 60) || 'Trusted Contact',
        email: emailRaw ? normalizeEmail(emailRaw) : '',
        phone: phoneRaw,
        notifyEmail: body.notifyEmail !== undefined ? Boolean(body.notifyEmail) : Boolean(emailRaw),
        notifySms: body.notifySms !== undefined ? Boolean(body.notifySms) : Boolean(phoneRaw),
        notifyWhatsapp: Boolean(body.notifyWhatsapp),
        priorityOrder:
          typeof body.priorityOrder === 'number' && Number.isSafeInteger(body.priorityOrder)
            ? Math.min(50, Math.max(1, body.priorityOrder))
            : 1,
        source: sanitizeBoundedString(body.source, 32) || 'manual',
      });

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'TRUSTED_CONTACT_ADDED',
        resourceType: 'trusted_contact',
        resourceId: String(contact.id),
        ipAddress: req.ip,
      });
      res.status(201).json({ contact });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add contact.' });
    }
  });

  app.put('/api/contacts/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const contactId = parsePositiveInt(req.params.id);
      if (!contactId) {
        return res.status(400).json({ error: 'Valid contact ID is required.' });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      if (body.email !== undefined && String(body.email).trim() !== '' && !isValidEmail(body.email)) {
        return res.status(400).json({ error: 'Contact email address is invalid.' });
      }
      if (body.phone !== undefined && !isValidPhone(body.phone)) {
        return res.status(400).json({ error: 'Contact phone number format is invalid.' });
      }

      const contacts = await updateTrustedContact(req.appUser!.id, contactId, {
        name: body.name !== undefined ? sanitizeBoundedString(body.name, 80) : undefined,
        relationship: body.relationship !== undefined ? sanitizeBoundedString(body.relationship, 60) : undefined,
        email: body.email !== undefined ? sanitizeBoundedString(body.email, 254) : undefined,
        phone: body.phone !== undefined ? sanitizeBoundedString(body.phone, 32) : undefined,
        notifyEmail: body.notifyEmail !== undefined ? Boolean(body.notifyEmail) : undefined,
        notifySms: body.notifySms !== undefined ? Boolean(body.notifySms) : undefined,
        notifyWhatsapp: body.notifyWhatsapp !== undefined ? Boolean(body.notifyWhatsapp) : undefined,
      });
      res.json({ contacts });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update contact.' });
    }
  });

  app.delete('/api/contacts/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const contactId = parsePositiveInt(req.params.id);
      if (!contactId) {
        return res.status(400).json({ error: 'Valid contact ID is required.' });
      }
      const deleted = await deleteTrustedContact(req.appUser!.id, contactId);
      if (!deleted) {
        return res.status(404).json({ error: 'Trusted contact not found.' });
      }
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'TRUSTED_CONTACT_DELETED',
        resourceType: 'trusted_contact',
        resourceId: String(contactId),
        ipAddress: req.ip,
      });
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to remove contact.' });
    }
  });

  // ========================
  // SOS & INCIDENT MANAGEMENT
  // ========================
  app.post('/api/incidents/sos', requireAuth, sosLimiter, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as {
        idempotencyKey?: unknown;
        clientQueuedAt?: unknown;
        title?: unknown;
        description?: unknown;
        category?: unknown;
        priority?: unknown;
        latitude?: unknown;
        longitude?: unknown;
        locationLabel?: unknown;
        locationAccuracyMeters?: unknown;
        isSimulated?: unknown;
      };

      let cleanIdempotencyKey: string | null = null;
      if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && body.idempotencyKey !== '') {
        if (!isValidIdempotencyKey(body.idempotencyKey)) {
          return res.status(400).json({ error: 'Invalid idempotencyKey format.' });
        }
        cleanIdempotencyKey = body.idempotencyKey.trim();
      }

      let cleanQueuedAt: string | null = null;
      if (body.clientQueuedAt !== undefined && body.clientQueuedAt !== null && body.clientQueuedAt !== '') {
        const parsedDate = new Date(String(body.clientQueuedAt));
        if (Number.isNaN(parsedDate.getTime())) {
          return res.status(400).json({ error: 'Invalid clientQueuedAt timestamp.' });
        }
        cleanQueuedAt = parsedDate.toISOString();
      }

      const coordCheck = validateOptionalCoordinates(body.latitude, body.longitude);
      if (!coordCheck.valid) {
        return res.status(400).json({ error: coordCheck.error });
      }

      const priority = body.priority !== undefined ? String(body.priority) : 'CRITICAL';
      if (!(VALID_PRIORITIES as readonly string[]).includes(priority)) {
        return res.status(400).json({ error: 'Invalid SOS priority level.' });
      }

      let cleanAccuracy: number | null = null;
      if (body.locationAccuracyMeters !== undefined && body.locationAccuracyMeters !== null) {
        const acc = Number(body.locationAccuracyMeters);
        if (!Number.isFinite(acc) || acc < 0 || acc > 100_000) {
          return res.status(400).json({ error: 'locationAccuracyMeters must be a valid non-negative distance.' });
        }
        cleanAccuracy = Math.round(acc);
      }

      const simulatedFlag = Boolean(body.isSimulated || req.appUser!.isDemoAccount);
      const { incident, deduplicated } = await createIncident({
        userId: req.appUser!.id,
        idempotencyKey: cleanIdempotencyKey,
        clientQueuedAt: cleanQueuedAt,
        title:
          sanitizeBoundedString(body.title, 160) ||
          (simulatedFlag ? '[SIMULATED] Emergency SOS Alert' : 'Emergency SOS Alert'),
        description: sanitizeBoundedString(body.description, 2000) || 'User activated LIFE-LINE AI SOS.',
        category: sanitizeBoundedString(body.category, 60) || 'Personal Safety',
        priority,
        latitude: coordCheck.latitude,
        longitude: coordCheck.longitude,
        locationLabel: sanitizeBoundedString(body.locationLabel, 240) || 'Location shared via browser/device',
        locationAccuracyMeters: cleanAccuracy,
        isSimulated: simulatedFlag,
      });

      if (!incident) {
        return res.status(500).json({ error: 'Incident creation failed.' });
      }

      if (deduplicated) {
        const confirmed = incident.deliveryLogs.filter((l) => l.status === 'delivered' || l.status === 'simulated').length;
        const failed = incident.deliveryLogs.filter((l) => l.status === 'failed').length;
        const unconfigured = incident.deliveryLogs.filter((l) => l.status === 'provider_not_configured').length;
        const dedupSummary: DispatchSummary = {
          overallDeliveryState: incident.deliveryStatus,
          operatorRecorded: true,
          externalConfirmedCount: confirmed,
          externalFailedCount: failed,
          externalUnconfiguredCount: unconfigured,
          truthfulMessage: `Duplicate SOS submission prevented via idempotency key; returning existing Incident #${incident.id}.`,
          deliveryResults: incident.deliveryLogs.map((l) => ({
            recipient: l.recipient,
            channel: l.channel,
            status: l.status as DispatchSummary['deliveryResults'][number]['status'],
            provider: l.provider,
            error: l.errorMessage || undefined,
          })),
        };
        metrics.recordSosOutcome({ deduplicated: true, confirmedCount: confirmed, failedCount: failed });
        return res.status(200).json({
          incident: sanitizeIncidentForViewer(incident, req.appUser!.role),
          deliveryResults: dedupSummary.deliveryResults,
          deliverySummary: dedupSummary,
          deduplicated: true,
        });
      }

      const contacts = await listTrustedContacts(req.appUser!.id);
      const operatorIds = await listOperatorUserIds();
      const googleToken = req.headers['x-google-access-token']
        ? String(req.headers['x-google-access-token'])
        : undefined;

      let dispatchSummary: DispatchSummary = {
        overallDeliveryState: 'submitted',
        operatorRecorded: operatorIds.length > 0,
        externalConfirmedCount: 0,
        externalFailedCount: 0,
        externalUnconfiguredCount: 0,
        truthfulMessage: 'Incident submitted to LIFE-LINE AI operator queue.',
        deliveryResults: [],
      };

      try {
        dispatchSummary = await dispatchEmergencyNotifications({
          senderUserId: req.appUser!.id,
          incidentId: incident.id,
          incidentTitle: incident.title,
          locationLabel: incident.locationLabel,
          latitude: incident.latitude,
          longitude: incident.longitude,
          isSimulated: simulatedFlag,
          contacts: contacts.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            notifyEmail: c.notifyEmail,
            notifySms: c.notifySms,
          })),
          googleAccessToken: googleToken,
          operatorUserIds: operatorIds,
          onRealtimeNotify: sendRealtimeToUser,
        });
      } catch (notifyErr) {
        const errMsg = notifyErr instanceof Error ? notifyErr.message : 'Notification dispatch error';
        dispatchSummary = {
          overallDeliveryState: 'failed',
          operatorRecorded: operatorIds.length > 0,
          externalConfirmedCount: 0,
          externalFailedCount: contacts.length || 1,
          externalUnconfiguredCount: 0,
          truthfulMessage: `Incident #${incident.id} recorded, but external notification dispatch failed: ${errMsg}`,
          deliveryResults: [],
        };
      }

      await updateIncidentDeliveryState(incident.id, dispatchSummary.overallDeliveryState);

      const sentIncident = await updateIncidentStatus({
        incidentId: incident.id,
        actorUserId: req.appUser!.id,
        actorRole: req.appUser!.role,
        newStatus: 'Alert Sent',
        note: dispatchSummary.truthfulMessage,
      });

      const finalIncident = sentIncident || incident;

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: simulatedFlag ? 'SIMULATED_SOS_ACTIVATED' : 'SOS_ACTIVATED',
        resourceType: 'emergency_incident',
        resourceId: String(finalIncident.id),
        details: {
          locationLabel: finalIncident.locationLabel,
          deliveryStatus: dispatchSummary.overallDeliveryState,
          externalConfirmedCount: dispatchSummary.externalConfirmedCount,
          externalFailedCount: dispatchSummary.externalFailedCount,
          externalUnconfiguredCount: dispatchSummary.externalUnconfiguredCount,
        },
        ipAddress: req.ip,
      });

      metrics.recordSosOutcome({
        deduplicated: false,
        confirmedCount: dispatchSummary.externalConfirmedCount,
        failedCount: dispatchSummary.externalFailedCount,
      });
      void cacheQueue.invalidateCachePrefix('analytics:');
      void cacheQueue.invalidateCachePrefix('pulse_data:');
      void cacheQueue.invalidateCachePrefix('sos_clusters:');
      void cacheQueue.invalidateCachePrefix('pulse_risk:');

      const sanitizedForReporter = sanitizeIncidentForViewer(finalIncident, 'regular_user');
      pushAndBroadcastRealtimeEvent({
        targetUserId: req.appUser!.id,
        includeOperators: true,
        userPayload: { type: 'incident:created', incident: sanitizedForReporter },
        operatorPayload: { type: 'incident:created', incident: finalIncident },
      });

      res.status(201).json({
        incident: sanitizeIncidentForViewer(finalIncident, req.appUser!.role),
        deliveryResults: dispatchSummary.deliveryResults,
        deliverySummary: dispatchSummary,
        deduplicated: false,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to activate SOS.' });
    }
  });

  app.get('/api/incidents', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>, { limit: 25, maxLimit: 100 });
      const [incidents, total] = await Promise.all([
        listIncidentsForUser(req.appUser!.id, req.appUser!.role, { limit, offset }),
        countIncidentsForUser(req.appUser!.id),
      ]);
      res.json({
        incidents,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load incidents.' });
    }
  });

  app.get(
    '/api/operator/incidents',
    requireAuth,
    requireRole(OPERATOR_ROLES),
    async (req, res) => {
      try {
        const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>, { limit: 50, maxLimit: 100 });
        const [incidents, total] = await Promise.all([
          listAllIncidentsForOperator({ limit, offset }),
          countAllIncidentsForOperator(),
        ]);
        res.json({
          incidents,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load operator queue.' });
      }
    }
  );

  app.get('/api/operator/responders', requireAuth, requireRole(OPERATOR_ROLES), async (_req, res) => {
    try {
      const responders = await listRespondersWithAvailability();
      res.json({ responders });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load responders.' });
    }
  });

  app.patch('/api/operator/availability', requireAuth, requireRole(OPERATOR_ROLES), async (req: AuthRequest, res) => {
    try {
      const { status } = (req.body || {}) as { status?: unknown };
      if (typeof status !== 'string' || !(VALID_RESPONDER_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: 'Responder status must be Available, Responding, or Off Duty.' });
      }
      const updated = await updateResponderAvailability(req.appUser!.id, status as ResponderAvailabilityStatus);
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'RESPONDER_AVAILABILITY_UPDATED',
        resourceType: 'user',
        resourceId: String(req.appUser!.id),
        details: { status },
        ipAddress: req.ip,
      });
      pushAndBroadcastRealtimeEvent({
        includeOperators: true,
        userPayload: { type: 'responder:updated', responder: updated },
        operatorPayload: { type: 'responder:updated', responder: updated },
      });
      res.json({ responder: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update responder status.' });
    }
  });

  app.post('/api/operator/incidents/:id/assign', requireAuth, requireRole(OPERATOR_ROLES), async (req: AuthRequest, res) => {
    try {
      const incidentId = parsePositiveInt(req.params.id);
      const operatorUserId = parsePositiveInt((req.body as { operatorUserId?: unknown })?.operatorUserId);
      if (!incidentId || !operatorUserId) {
        return res.status(400).json({ error: 'Valid incident ID and operatorUserId are required.' });
      }
      const updated = await assignIncidentToOperator({
        incidentId,
        operatorUserId,
        assignedByUserId: req.appUser!.id,
        assignedByRole: req.appUser!.role,
      });
      if (!updated) {
        return res.status(404).json({ error: 'Incident not found.' });
      }

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'INCIDENT_RESPONDER_ASSIGNED',
        resourceType: 'emergency_incident',
        resourceId: String(incidentId),
        details: { operatorUserId },
        ipAddress: req.ip,
      });

      const sanitized = sanitizeIncidentForViewer(updated, 'regular_user');
      pushAndBroadcastRealtimeEvent({
        targetUserId: updated.userId,
        includeOperators: true,
        userPayload: { type: 'incident:updated', incident: sanitized },
        operatorPayload: { type: 'incident:assigned', incident: updated, operatorUserId },
      });

      res.json({ incident: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to assign responder.' });
    }
  });

  app.patch('/api/incidents/:id/status', requireAuth, async (req: AuthRequest, res) => {
    try {
      const incidentId = parsePositiveInt(req.params.id);
      if (!incidentId) {
        return res.status(400).json({ error: 'Valid incident ID is required.' });
      }

      const existing = await getIncidentById(incidentId);
      if (!existing) return res.status(404).json({ error: 'Incident not found.' });

      const { status, note, priority, isInternal } = req.body as {
        status?: unknown;
        note?: unknown;
        priority?: unknown;
        isInternal?: unknown;
      };

      if (typeof status !== 'string' || !(VALID_INCIDENT_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: 'Invalid emergency status.' });
      }
      if (priority !== undefined && !(VALID_PRIORITIES as readonly string[]).includes(String(priority))) {
        return res.status(400).json({ error: 'Invalid priority level.' });
      }

      const isOperator = OPERATOR_ROLES.includes(req.appUser!.role);
      const isOwner = existing.userId === req.appUser!.id;

      if (!isOperator && !isOwner) {
        return res.status(403).json({ error: 'Forbidden: You cannot modify this incident.' });
      }
      if (!isOperator && !['Cancelled', 'Resolved'].includes(status)) {
        return res.status(403).json({ error: 'Only authorized operators can acknowledge or advance responder states.' });
      }

      const updated = await updateIncidentStatus({
        incidentId,
        actorUserId: req.appUser!.id,
        actorRole: req.appUser!.role,
        newStatus: status,
        note: sanitizeBoundedString(note, 1000) || undefined,
        priority: isOperator && priority !== undefined ? String(priority) : undefined,
        isInternal: isOperator ? Boolean(isInternal) : false,
      });

      if (!updated) {
        return res.status(404).json({ error: 'Incident not found after update.' });
      }

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'INCIDENT_STATUS_UPDATED',
        resourceType: 'emergency_incident',
        resourceId: String(incidentId),
        details: { previousStatus: existing.status, newStatus: status, isInternal: isOperator ? Boolean(isInternal) : false },
        ipAddress: req.ip,
      });

      void cacheQueue.invalidateCachePrefix('analytics:');
      void cacheQueue.invalidateCachePrefix('pulse_data:');
      void cacheQueue.invalidateCachePrefix('sos_clusters:');
      void cacheQueue.invalidateCachePrefix('pulse_risk:');

      const sanitizedForReporter = sanitizeIncidentForViewer(updated, 'regular_user');
      pushAndBroadcastRealtimeEvent({
        targetUserId: existing.userId,
        includeOperators: true,
        userPayload: { type: 'incident:updated', incident: sanitizedForReporter },
        operatorPayload: { type: 'incident:updated', incident: updated },
      });

      res.json({ incident: sanitizeIncidentForViewer(updated, req.appUser!.role) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update incident.' });
    }
  });

  // ========================
  // SUPPORT DIRECTORY & GOOGLE MAPS PROXY
  // ========================
  app.get('/api/support-directory', async (req, res) => {
    try {
      const category = req.query.category ? sanitizeBoundedString(req.query.category, 64) : undefined;
      const query = req.query.q ? sanitizeBoundedString(req.query.q, 120) : undefined;
      const resources = await listSupportDirectory(category, query);
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      res.json({ resources });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load support directory.' });
    }
  });

  app.post('/api/maps/nearby-support', mapsLimiter, async (req, res) => {
    const { latitude, longitude, radiusMeters = 5000, includedTypes = ['hospital', 'police', 'pharmacy'] } = req.body as {
      latitude?: unknown;
      longitude?: unknown;
      radiusMeters?: unknown;
      includedTypes?: unknown;
    };

    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
      return res.status(400).json({ error: 'Valid finite latitude (-90..90) and longitude (-180..180) are required.' });
    }

    const radius = typeof radiusMeters === 'number' && Number.isFinite(radiusMeters)
      ? Math.min(Math.max(Math.round(radiusMeters), 500), 25000)
      : 5000;

    const cleanTypes = Array.isArray(includedTypes)
      ? includedTypes.filter((t): t is string => typeof t === 'string' && ALLOWED_MAP_PLACE_TYPES.has(t)).slice(0, 8)
      : ['hospital', 'police', 'pharmacy'];
    if (cleanTypes.length === 0) {
      return res.status(400).json({ error: 'At least one supported place type is required.' });
    }

    const mapsKey = getServerMapsApiKey();
    if (!mapsKey) {
      return res.status(503).json({ error: 'Google Maps Places proxy key is not configured on server.' });
    }

    try {
      const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': mapsKey,
          'X-Goog-Maps-Solution-ID': MAPS_ATTRIBUTION_ID,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.nationalPhoneNumber,places.regularOpeningHours.openNow,places.googleMapsUri',
        },
        body: JSON.stringify({
          includedTypes: cleanTypes,
          maxResultCount: 10,
          locationRestriction: {
            circle: {
              center: { latitude, longitude },
              radius,
            },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        places?: unknown[];
        error?: { status?: string; message?: string };
      };
      if (!resp.ok) {
        if (resp.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
          return res.status(429).json({
            error: { status: 'RESOURCE_EXHAUSTED', message: 'Google Places quota temporarily reached.' },
          });
        }
        return res.status(resp.status >= 400 && resp.status < 500 ? resp.status : 502).json({
          error: data?.error?.message || 'Google Places API returned an error.',
        });
      }
      res.json({ places: data.places || [], source: 'Google Places API (New)', retrievedAt: new Date().toISOString() });
    } catch (err) {
      const isTimeout = err instanceof Error && /timeout|abort/i.test(err.message);
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout ? 'Google Places API request timed out.' : 'Failed to query Google Places API.',
      });
    }
  });

  app.post('/api/maps/search-places', mapsLimiter, async (req, res) => {
    const { textQuery, latitude, longitude } = req.body as {
      textQuery?: unknown;
      latitude?: unknown;
      longitude?: unknown;
    };
    const cleanQuery = sanitizeBoundedString(textQuery, 200);
    if (!cleanQuery) {
      return res.status(400).json({ error: 'Search query (1 to 200 characters) is required.' });
    }

    const coordCheck = validateOptionalCoordinates(latitude, longitude);
    if (!coordCheck.valid) {
      return res.status(400).json({ error: coordCheck.error });
    }

    const mapsKey = getServerMapsApiKey();
    if (!mapsKey) {
      return res.status(503).json({ error: 'Google Maps Places proxy key is not configured on server.' });
    }

    try {
      const body: Record<string, unknown> = {
        textQuery: cleanQuery,
        maxResultCount: 10,
      };
      if (coordCheck.latitude !== null && coordCheck.longitude !== null) {
        body.locationBias = {
          circle: {
            center: { latitude: coordCheck.latitude, longitude: coordCheck.longitude },
            radius: 15000,
          },
        };
      }

      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': mapsKey,
          'X-Goog-Maps-Solution-ID': MAPS_ATTRIBUTION_ID,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.nationalPhoneNumber,places.regularOpeningHours.openNow,places.googleMapsUri',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        places?: unknown[];
        error?: { status?: string; message?: string };
      };
      if (!resp.ok) {
        if (resp.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
          return res.status(429).json({
            error: { status: 'RESOURCE_EXHAUSTED', message: 'Google Places search quota temporarily reached.' },
          });
        }
        return res.status(resp.status >= 400 && resp.status < 500 ? resp.status : 502).json({
          error: data?.error?.message || 'Google Places search failed.',
        });
      }
      res.json({ places: data.places || [], source: 'Google Places API (New)', retrievedAt: new Date().toISOString() });
    } catch (err) {
      const isTimeout = err instanceof Error && /timeout|abort/i.test(err.message);
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout ? 'Places search timed out.' : 'Places search failed.',
      });
    }
  });

  app.get('/api/maps/geocode', mapsLimiter, async (req, res) => {
    const address = req.query.address ? sanitizeBoundedString(req.query.address, 250) : '';
    const latlng = req.query.latlng ? sanitizeBoundedString(req.query.latlng, 64) : '';
    if (!address && !latlng) {
      return res.status(400).json({ error: 'Provide address or latlng parameter.' });
    }
    if (latlng) {
      const parts = latlng.split(',').map((p) => Number(p.trim()));
      if (parts.length !== 2 || !isValidLatitude(parts[0]) || !isValidLongitude(parts[1])) {
        return res.status(400).json({ error: 'latlng must be formatted as "latitude,longitude".' });
      }
    }

    const mapsKey = getServerMapsApiKey();
    if (!mapsKey) {
      return res.status(503).json({ error: 'Geocoding API key is not configured.' });
    }

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      if (address) url.searchParams.set('address', address);
      if (latlng) url.searchParams.set('latlng', latlng);
      url.searchParams.set('key', mapsKey);

      const resp = await fetch(url.toString(), {
        headers: { 'X-Goog-Maps-Solution-ID': MAPS_ATTRIBUTION_ID },
        signal: AbortSignal.timeout(8000),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        status?: string;
        results?: unknown[];
        error_message?: string;
      };
      if (data.status === 'OVER_QUERY_LIMIT') {
        return res.status(429).json({
          error: { status: 'RESOURCE_EXHAUSTED', message: data.error_message || 'Geocoding quota exceeded.' },
        });
      }
      if (!resp.ok) {
        return res.status(502).json({ error: 'Geocoding upstream service error.' });
      }
      res.json({ status: data.status, results: data.results || [] });
    } catch (err) {
      const isTimeout = err instanceof Error && /timeout|abort/i.test(err.message);
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout ? 'Geocoding request timed out.' : 'Geocoding failed.',
      });
    }
  });

  // ========================
  // LIFE-LINE PULSE: PREDICTIVE RISK, SAFEROUTE & JOURNEYS
  // ========================
  const handlePredictiveRisk = async (lat: unknown, lng: unknown, label: unknown, radiusKm: unknown, res: express.Response) => {
    if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
      return res.status(400).json({ error: 'Valid finite latitude (-90..90) and longitude (-180..180) are required.' });
    }
    const cleanRadius =
      typeof radiusKm === 'number' && Number.isFinite(radiusKm)
        ? Math.min(Math.max(radiusKm, 0.5), 25)
        : 3.5;

    const cleanLabel = sanitizeBoundedString(label, 180) || '';
    const cacheKey = `pulse_risk:${lat.toFixed(2)}:${lng.toFixed(2)}:${cleanRadius.toFixed(1)}:${cleanLabel.toLowerCase().slice(0, 48)}`;
    const cached = await cacheQueue.getCachedJson<{ risk: ReturnType<typeof computePredictiveRisk> }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const [weather, incidents, reports, supportHubs] = await Promise.all([
      fetchOpenMeteoWeather(lat, lng),
      listIncidentsForPulse(150),
      listSafetyReportsForPulse(100),
      listSupportDirectory(),
    ]);

    const assessment = computePredictiveRisk({
      latitude: lat,
      longitude: lng,
      locationLabel: cleanLabel || undefined,
      radiusKm: cleanRadius,
      weather,
      incidents,
      reports,
      supportHubs,
    });
    const payload = { risk: assessment };
    await cacheQueue.setCachedJson(cacheKey, payload, 15);
    return res.json(payload);
  };

  app.post('/api/pulse/risk', mapsLimiter, async (req, res) => {
    try {
      const { latitude, longitude, locationLabel, radiusKm } = (req.body || {}) as Record<string, unknown>;
      await handlePredictiveRisk(latitude, longitude, locationLabel, radiusKm, res);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Predictive risk evaluation failed.' });
    }
  });

  app.get('/api/pulse/risk', mapsLimiter, async (req, res) => {
    try {
      const lat = req.query.lat !== undefined ? Number(req.query.lat) : NaN;
      const lng = req.query.lng !== undefined ? Number(req.query.lng) : NaN;
      const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : 3.5;
      await handlePredictiveRisk(lat, lng, req.query.label, radiusKm, res);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Predictive risk evaluation failed.' });
    }
  });

  app.get('/api/pulse/reports', async (_req, res) => {
    try {
      const reports = await listSafetyReportsForPulse(60);
      res.json({ reports });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load safety reports.' });
    }
  });

  app.post('/api/pulse/reports', requireAuth, pulseReportLimiter, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const category = sanitizeBoundedString(body.category, 64);
      const description = sanitizeBoundedString(body.description, 1000);
      const locationLabel = sanitizeBoundedString(body.locationLabel, 200);
      const severity = typeof body.severity === 'string' ? body.severity : 'MODERATE';
      const isAnonymous = body.isAnonymous !== undefined ? Boolean(body.isAnonymous) : true;

      if (!category || !description || !locationLabel) {
        return res.status(400).json({ error: 'category, description, and locationLabel are required.' });
      }
      if (!(VALID_REPORT_SEVERITIES as readonly string[]).includes(severity)) {
        return res.status(400).json({ error: 'Severity must be LOW, MODERATE, or HIGH.' });
      }
      if (!isValidLatitude(body.latitude) || !isValidLongitude(body.longitude)) {
        return res.status(400).json({ error: 'Valid finite latitude and longitude are required.' });
      }

      const report = await createSafetyReport({
        userId: req.appUser!.id,
        category,
        severity: severity as 'LOW' | 'MODERATE' | 'HIGH',
        description,
        latitude: body.latitude,
        longitude: body.longitude,
        locationLabel,
        isAnonymous,
        isSimulated: req.appUser!.isDemoAccount,
      });

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: isAnonymous ? 'anonymous-community-reporter' : req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'SAFETY_REPORT_SUBMITTED',
        resourceType: 'safety_report',
        resourceId: String(report.id),
        details: { category, severity, isAnonymous },
        ipAddress: req.ip,
      });

      void cacheQueue.invalidateCachePrefix('pulse_data:');
      void cacheQueue.invalidateCachePrefix('sos_clusters:');
      void cacheQueue.invalidateCachePrefix('pulse_risk:');

      pushAndBroadcastRealtimeEvent({
        includeOperators: true,
        userPayload: { type: 'pulse:report_created', report },
        operatorPayload: { type: 'pulse:report_created', report },
      });

      res.status(201).json({ report });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit safety report.' });
    }
  });

  // ========================
  // LIVE INCIDENT INTELLIGENCE (NDMA SACHET, IMD CAP, OPEN-METEO, USGS, MYSURU PILOT + MINUTES-TO-SAFETY)
  // ========================
  const VALID_LIVE_VERIFICATION_STATUSES = new Set<LiveIncidentVerificationStatus>([
    'Official Alert',
    'Awaiting Verification',
    'Verified Incident',
    'Resolved Incident',
  ]);

  function resolveFocusCoordinates(query: Record<string, unknown>) {
    const cityRaw = sanitizeBoundedString(query.city, 80);
    const regionRaw = sanitizeBoundedString(query.region, 40).toLowerCase() || 'mysuru';
    const latRaw = query.lat !== undefined ? Number(query.lat) : undefined;
    const lngRaw = query.lng !== undefined ? Number(query.lng) : undefined;

    if (latRaw !== undefined && lngRaw !== undefined && isValidLatitude(latRaw) && isValidLongitude(lngRaw)) {
      return {
        lat: latRaw,
        lng: lngRaw,
        city: cityRaw || 'Custom Locality',
        state: sanitizeBoundedString(query.state, 80) || 'India',
        region: regionRaw,
      };
    }

    if (cityRaw) {
      const resolved = resolveIndiaDistrictCoordinates(cityRaw);
      if (resolved) {
        return {
          lat: resolved.lat,
          lng: resolved.lng,
          city: resolved.districtName || cityRaw,
          state: resolved.stateName || 'India',
          region: regionRaw,
        };
      }
    }

    if (regionRaw === 'karnataka') {
      return { lat: 12.9716, lng: 77.5946, city: 'Bengaluru / Karnataka', state: 'Karnataka', region: 'karnataka' };
    }
    if (regionRaw === 'india' || regionRaw === 'all') {
      return { lat: 12.2958, lng: 76.6394, city: 'Mysuru (National View)', state: 'Karnataka', region: regionRaw };
    }
    return { lat: 12.2958, lng: 76.6394, city: 'Mysuru', state: 'Karnataka', region: 'mysuru' };
  }

  app.get('/api/live-incidents', mapsLimiter, async (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const statusParam = sanitizeBoundedString(q.status, 24).toLowerCase() || 'all';
      const categoryParam = sanitizeBoundedString(q.category, 64) || 'all';
      const focus = resolveFocusCoordinates(q);
      const cacheKey = `live_incidents:feed:${focus.region}:${focus.city.toLowerCase()}:${focus.lat.toFixed(2)}:${focus.lng.toFixed(2)}:${statusParam}:${categoryParam.toLowerCase()}`;

      const cached = await cacheQueue.getCachedJson<Record<string, unknown>>(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
        return res.json(cached);
      }

      const [alerts, allCommunityReports, sources, weather, supportHubs] = await Promise.all([
        listLiveExternalAlerts({
          activeOnly: statusParam === 'active',
          region: focus.region,
          category: categoryParam,
          limit: 120,
        }),
        listSafetyReportsForPulse(80),
        listLiveFeedSyncRuns(),
        fetchMysuruAndCityWeather(focus.lat, focus.lng, focus.city, focus.state),
        listSupportDirectory(),
      ]);

      const filteredAlerts =
        statusParam === 'resolved'
          ? alerts.filter((a) => !a.isActive || a.verificationStatus === 'Resolved Incident')
          : alerts;

      const communityReports = allCommunityReports.filter((r) => !r.isSimulated);
      const activeAlerts = alerts.filter((a) => a.isActive && a.verificationStatus !== 'Resolved Incident');
      const healthySourcesCount = sources.filter((s) => s.status === 'healthy').length;

      const safetyGap = computeSafetyGapScore({
        localityName: focus.city,
        latitude: focus.lat,
        longitude: focus.lng,
        alerts: activeAlerts,
        communityReports,
        weather,
        supportHubs,
        sourcesAvailableCount: healthySourcesCount,
      });

      const hasActiveLocalIncidents = activeAlerts.length > 0;
      const zeroStateMessage = hasActiveLocalIncidents
        ? `${activeAlerts.length} active external/verified alert(s) monitored in ${focus.region.toUpperCase()}.`
        : 'NO VERIFIED ACTIVE INCIDENTS — CONTINUOUS MONITORING ACTIVE.';

      const payload = {
        evaluatedAt: new Date().toISOString(),
        region: focus.region,
        hasActiveLocalIncidents,
        zeroStateMessage,
        alerts: filteredAlerts,
        communityReports,
        sources,
        weather,
        safetyGap,
      };

      await cacheQueue.setCachedJson(cacheKey, payload, 20);
      res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load live incident intelligence.' });
    }
  });

  app.get('/api/live-incidents/sources', async (_req, res) => {
    try {
      const sources = await listLiveFeedSyncRuns();
      res.json({
        evaluatedAt: new Date().toISOString(),
        sources,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to inspect live data sources.' });
    }
  });

  app.get('/api/live-incidents/mysuru-intel', mapsLimiter, async (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const focus = resolveFocusCoordinates({ ...q, region: q.region || 'mysuru' });
      const scenarioRaw = sanitizeBoundedString(q.scenario, 40);
      const blockedHubId = parsePositiveInt(q.blockedHubId) ?? undefined;

      const [alerts, allReports, sources, weather, supportHubs] = await Promise.all([
        listLiveExternalAlerts({ activeOnly: true, region: focus.region, limit: 80 }),
        listSafetyReportsForPulse(60),
        listLiveFeedSyncRuns(),
        fetchMysuruAndCityWeather(focus.lat, focus.lng, focus.city, focus.state),
        listSupportDirectory(),
      ]);

      const communityReports = allReports.filter((r) => !r.isSimulated);
      const baseline = computeSafetyGapScore({
        localityName: focus.city,
        latitude: focus.lat,
        longitude: focus.lng,
        alerts,
        communityReports,
        weather,
        supportHubs,
        sourcesAvailableCount: sources.filter((s) => s.status === 'healthy').length,
      });

      const validScenarios = new Set(['hospital_offline', 'corridor_flooded', 'heatwave_peak', 'multi_locality_surge']);
      const whatIf = validScenarios.has(scenarioRaw)
        ? runDeterministicWhatIfScenario({
            scenarioType: scenarioRaw as 'hospital_offline' | 'corridor_flooded' | 'heatwave_peak' | 'multi_locality_surge',
            baseline,
            localityName: focus.city,
            latitude: focus.lat,
            longitude: focus.lng,
            alerts,
            communityReports,
            weather,
            supportHubs,
            blockedHubId,
          })
        : null;

      res.json({
        evaluatedAt: new Date().toISOString(),
        focus,
        weather,
        safetyGap: baseline,
        whatIf,
        supportHubs: supportHubs.filter((h) => h.region === 'Karnataka' || h.city.toLowerCase().includes(focus.city.toLowerCase())),
        sources,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute Mysuru intelligence.' });
    }
  });

  app.post('/api/live-incidents/sync', requireAuth, requireRole(OPERATOR_ROLES), mapsLimiter, async (req: AuthRequest, res) => {
    try {
      const summary = await pollAllLiveSources({
        force: true,
        onNewAlerts: (newAlerts) => {
          pushAndBroadcastRealtimeEvent({
            includeOperators: true,
            broadcastAll: true,
            userPayload: { type: 'live_incident:sync', alerts: newAlerts },
            operatorPayload: { type: 'live_incident:sync', alerts: newAlerts },
          });
        },
      });

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'LIVE_INCIDENTS_MANUAL_SYNC',
        resourceType: 'live_external_alerts',
        resourceId: 'all',
        details: {
          insertedCount: summary.insertedCount,
          updatedCount: summary.updatedCount,
          resolvedCount: summary.resolvedCount,
        },
        ipAddress: req.ip,
      });

      res.json({ summary });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Live source synchronization failed.' });
    }
  });

  app.patch(
    '/api/live-incidents/:id/status',
    requireAuth,
    requireRole(OPERATOR_ROLES),
    async (req: AuthRequest, res) => {
      try {
        const alertId = parsePositiveInt(req.params.id);
        if (!alertId) {
          return res.status(400).json({ error: 'Valid live alert ID is required.' });
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const verificationStatus = sanitizeBoundedString(body.verificationStatus, 48) as LiveIncidentVerificationStatus;
        if (!VALID_LIVE_VERIFICATION_STATUSES.has(verificationStatus)) {
          return res.status(400).json({
            error: 'verificationStatus must be Official Alert, Awaiting Verification, Verified Incident, or Resolved Incident.',
          });
        }
        const existing = await getLiveExternalAlertById(alertId);
        if (!existing) {
          return res.status(404).json({ error: 'Live alert not found.' });
        }

        const instructionNote = sanitizeBoundedString(body.instructionNote, 600);
        const updated = await updateLiveExternalAlertStatus(alertId, verificationStatus, instructionNote);
        await cacheQueue.invalidateCachePrefix('live_incidents:');

        await writeAuditLog({
          actorUserId: req.appUser!.id,
          actorEmail: req.appUser!.email,
          actorRole: req.appUser!.role,
          action: 'LIVE_INCIDENT_STATUS_UPDATED',
          resourceType: 'live_external_alert',
          resourceId: String(alertId),
          details: {
            previousStatus: existing.verificationStatus,
            newStatus: verificationStatus,
          },
          ipAddress: req.ip,
        });

        if (updated) {
          pushAndBroadcastRealtimeEvent({
            includeOperators: true,
            broadcastAll: true,
            userPayload: { type: 'live_incident:status_updated', alert: updated },
            operatorPayload: { type: 'live_incident:status_updated', alert: updated },
          });
        }

        res.json({ alert: updated });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update live incident status.' });
      }
    }
  );

  app.post('/api/ai/analyze-live-incident', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const focus = resolveFocusCoordinates(body);
      const whatIfQuestion = sanitizeBoundedString(body.whatIfQuestion, 400) || undefined;
      const language = body.language === 'kn' ? 'kn' : 'en';

      const [alerts, allReports, sources, weather, supportHubs] = await Promise.all([
        listLiveExternalAlerts({ activeOnly: true, region: focus.region, limit: 60 }),
        listSafetyReportsForPulse(40),
        listLiveFeedSyncRuns(),
        fetchMysuruAndCityWeather(focus.lat, focus.lng, focus.city, focus.state),
        listSupportDirectory(),
      ]);

      const communityReports = allReports.filter((r) => !r.isSimulated);
      const safetyGap = computeSafetyGapScore({
        localityName: focus.city,
        latitude: focus.lat,
        longitude: focus.lng,
        alerts,
        communityReports,
        weather,
        supportHubs,
        sourcesAvailableCount: sources.filter((s) => s.status === 'healthy').length,
      });

      const weatherSummary = weather.available
        ? `${weather.city}: ${weather.temperatureC ?? '--'}°C (feels ${weather.apparentTemperatureC ?? '--'}°C), ${weather.weatherLabel}, rain ${weather.precipitationMm ?? 0} mm/h, wind ${weather.windSpeedKmh ?? 0} km/h. Forecast: ${weather.horizons.slice(0, 3).map((h) => `${h.horizonLabel} ${h.temperatureC ?? '--'}°C/${h.precipitationMm ?? 0}mm`).join(', ')}`
        : 'Weather telemetry temporarily unreachable';

      const nearestHubSummary = safetyGap.nearestSupportHub
        ? `${safetyGap.nearestSupportHub.name} (${safetyGap.nearestSupportHub.category}, ${safetyGap.nearestSupportHub.distanceKm} km, phone ${safetyGap.nearestSupportHub.phone || '112'})`
        : 'No directory hub in immediate dataset';

      const analysis = await runLiveIncidentIntelligenceAgent({
        localityName: focus.city,
        region: focus.region,
        alerts: alerts.map((a) => ({
          sourceName: a.sourceName,
          category: a.category,
          severity: a.severity,
          verificationStatus: a.verificationStatus,
          title: a.title,
          locationLabel: a.locationLabel,
          firstReportedAt: a.firstReportedAt,
          expiresAt: a.expiresAt,
        })),
        weatherSummary,
        safetyGapScore: safetyGap.safetyGapScore,
        riskBand: safetyGap.riskBand,
        missingResources: safetyGap.missingResources,
        nearestHubSummary,
        whatIfQuestion,
        language,
      });

      res.json({ analysis, safetyGap, weather });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Live incident AI analysis failed.' });
    }
  });

  app.get('/api/maps/sos-clusters', mapsLimiter, async (req, res) => {
    try {
      const latRaw = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
      const lngRaw = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
      if (
        (latRaw !== undefined && !isValidLatitude(latRaw)) ||
        (lngRaw !== undefined && !isValidLongitude(lngRaw))
      ) {
        return res.status(400).json({ error: 'Invalid latitude or longitude query parameters.' });
      }
      const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : 35;
      if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 250) {
        return res.status(400).json({ error: 'radiusKm must be between 1 and 250.' });
      }
      const windowDays = req.query.windowDays !== undefined ? Number(req.query.windowDays) : 30;
      if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 365) {
        return res.status(400).json({ error: 'windowDays must be between 1 and 365.' });
      }
      const includeSimulated = req.query.includeSimulated !== 'false';

      const latBucket = latRaw !== undefined ? latRaw.toFixed(2) : 'all';
      const lngBucket = lngRaw !== undefined ? lngRaw.toFixed(2) : 'all';
      const cacheKey = `sos_clusters:${latBucket}:${lngBucket}:${radiusKm}:${windowDays}:${includeSimulated}`;

      const cached = await cacheQueue.getCachedJson<ReturnType<typeof buildSosIncidentClusters>>(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
        return res.json(cached);
      }

      const [incidents, reports] = await Promise.all([
        listIncidentsForPulse(400),
        listSafetyReportsForPulse(200),
      ]);

      const result = buildSosIncidentClusters({
        incidents,
        reports,
        centerLat: latRaw,
        centerLng: lngRaw,
        radiusKm,
        windowDays,
        includeSimulated,
      });
      await cacheQueue.setCachedJson(cacheKey, result, 20);
      res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute SOS clusters.' });
    }
  });

  app.post('/api/maps/saferoute', mapsLimiter, async (req, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const { originLat, originLng, destinationLat, destinationLng } = body;
      if (
        !isValidLatitude(originLat) ||
        !isValidLongitude(originLng) ||
        !isValidLatitude(destinationLat) ||
        !isValidLongitude(destinationLng)
      ) {
        return res.status(400).json({ error: 'Valid originLat/originLng and destinationLat/destinationLng are required.' });
      }

      const travelMode = typeof body.travelMode === 'string' ? body.travelMode.toUpperCase() : 'WALK';
      if (!(VALID_TRAVEL_MODES as readonly string[]).includes(travelMode)) {
        return res.status(400).json({ error: 'travelMode must be WALK, DRIVE, TRANSIT, or BICYCLE.' });
      }

      const mapsKey = getServerMapsApiKey();
      const [weather, incidents, reports, supportHubs] = await Promise.all([
        fetchOpenMeteoWeather(originLat, originLng),
        listIncidentsForPulse(150),
        listSafetyReportsForPulse(100),
        listSupportDirectory(),
      ]);

      const routePlan = await computeSafeRoutesWithGoogle(
        {
          origin: { lat: originLat, lng: originLng },
          destination: { lat: destinationLat, lng: destinationLng },
          travelMode: travelMode as 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE',
        },
        mapsKey,
        { weather, incidents, reports, supportHubs }
      );

      if (!mapsKey) {
        return res.status(503).json(routePlan);
      }
      res.json(routePlan);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'SafeRoute evaluation failed.' });
    }
  });

  app.get('/api/journeys', requireAuth, async (req: AuthRequest, res) => {
    try {
      const journeys = await listSafetyJourneysForUser(req.appUser!.id, 25);
      res.json({ journeys });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load shared journeys.' });
    }
  });

  app.post('/api/journeys', requireAuth, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const originLabel = sanitizeBoundedString(body.originLabel, 200) || 'Current Location';
      const destinationLabel = sanitizeBoundedString(body.destinationLabel, 200);
      if (!destinationLabel) {
        return res.status(400).json({ error: 'Destination label is required.' });
      }
      if (
        !isValidLatitude(body.originLat) ||
        !isValidLongitude(body.originLng) ||
        !isValidLatitude(body.destinationLat) ||
        !isValidLongitude(body.destinationLng)
      ) {
        return res.status(400).json({ error: 'Valid origin and destination coordinates are required.' });
      }
      const travelMode = typeof body.travelMode === 'string' ? body.travelMode.toUpperCase() : 'WALK';
      if (!(VALID_TRAVEL_MODES as readonly string[]).includes(travelMode)) {
        return res.status(400).json({ error: 'Invalid travel mode.' });
      }
      const intervalMin = parsePositiveInt(body.checkInIntervalMinutes) ?? 15;
      const expectedMin = parsePositiveInt(body.expectedDurationMinutes) ?? Math.max(20, intervalMin * 2);

      const contacts = await listTrustedContacts(req.appUser!.id);
      const selectedIds = Array.isArray(body.contactIds)
        ? new Set(body.contactIds.map((id) => Number(id)).filter((n) => Number.isSafeInteger(n)))
        : null;
      const chosenContacts = (selectedIds && selectedIds.size > 0
        ? contacts.filter((c) => selectedIds.has(c.id))
        : contacts
      ).map((c) => ({ id: c.id, name: c.name, email: c.email }));

      const journey = await createSafetyJourney({
        userId: req.appUser!.id,
        originLabel,
        originLat: body.originLat,
        originLng: body.originLng,
        destinationLabel,
        destinationLat: body.destinationLat,
        destinationLng: body.destinationLng,
        travelMode,
        selectedRouteSummary: sanitizeBoundedString(body.selectedRouteSummary, 300) || `${travelMode} SafeRoute`,
        routeRiskLevel: sanitizeBoundedString(body.routeRiskLevel, 32) || 'LOW',
        sharedWithContacts: chosenContacts,
        checkInIntervalMinutes: intervalMin,
        expectedDurationMinutes: expectedMin,
        isSimulated: req.appUser!.isDemoAccount,
      });

      await createNotification({
        userId: req.appUser!.id,
        channel: 'in_app',
        category: 'journey',
        title: 'PULSE SafeRoute Journey Active',
        message: `Sharing ${travelMode} journey to ${destinationLabel} (${chosenContacts.length} trusted contact(s) listed). Next check-in every ${journey.checkInIntervalMinutes} min.`,
        isSimulated: req.appUser!.isDemoAccount,
      });

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'SAFETY_JOURNEY_STARTED',
        resourceType: 'safety_journey',
        resourceId: String(journey.id),
        details: { destinationLabel, travelMode, checkInIntervalMinutes: journey.checkInIntervalMinutes },
        ipAddress: req.ip,
      });

      sendRealtimeToUser(req.appUser!.id, { type: 'journey:updated', journey });
      res.status(201).json({ journey });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start shared journey.' });
    }
  });

  app.post('/api/journeys/:id/checkin', requireAuth, async (req: AuthRequest, res) => {
    try {
      const journeyId = parsePositiveInt(req.params.id);
      if (!journeyId) return res.status(400).json({ error: 'Valid journey ID is required.' });
      const existing = await getSafetyJourneyById(journeyId);
      if (!existing) return res.status(404).json({ error: 'Journey not found.' });
      if (existing.userId !== req.appUser!.id) return res.status(403).json({ error: 'Forbidden.' });

      const updated = await checkInSafetyJourney(req.appUser!.id, journeyId);
      if (updated) {
        sendRealtimeToUser(req.appUser!.id, { type: 'journey:updated', journey: updated });
      }
      res.json({ journey: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Journey check-in failed.' });
    }
  });

  app.post('/api/journeys/:id/arrive', requireAuth, async (req: AuthRequest, res) => {
    try {
      const journeyId = parsePositiveInt(req.params.id);
      if (!journeyId) return res.status(400).json({ error: 'Valid journey ID is required.' });
      const existing = await getSafetyJourneyById(journeyId);
      if (!existing) return res.status(404).json({ error: 'Journey not found.' });
      if (existing.userId !== req.appUser!.id) return res.status(403).json({ error: 'Forbidden.' });

      const updated = await updateSafetyJourneyState(req.appUser!.id, journeyId, 'Arrived Safe');
      await createNotification({
        userId: req.appUser!.id,
        channel: 'in_app',
        category: 'journey',
        title: 'Safe Arrival Confirmed',
        message: `You marked safe arrival at ${existing.destinationLabel}. Journey tracking closed cleanly.`,
        isSimulated: req.appUser!.isDemoAccount,
      });
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'SAFETY_JOURNEY_ARRIVED_SAFE',
        resourceType: 'safety_journey',
        resourceId: String(journeyId),
        ipAddress: req.ip,
      });
      if (updated) {
        sendRealtimeToUser(req.appUser!.id, { type: 'journey:updated', journey: updated });
      }
      res.json({ journey: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not confirm safe arrival.' });
    }
  });

  app.post('/api/journeys/:id/escalate', requireAuth, async (req: AuthRequest, res) => {
    try {
      const journeyId = parsePositiveInt(req.params.id);
      if (!journeyId) return res.status(400).json({ error: 'Valid journey ID is required.' });
      const existing = await getSafetyJourneyById(journeyId);
      if (!existing) return res.status(404).json({ error: 'Journey not found.' });
      if (existing.userId !== req.appUser!.id) return res.status(403).json({ error: 'Forbidden.' });

      const updated = await updateSafetyJourneyState(req.appUser!.id, journeyId, 'Escalated');
      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'SAFETY_JOURNEY_ESCALATED',
        resourceType: 'safety_journey',
        resourceId: String(journeyId),
        ipAddress: req.ip,
      });
      if (updated) {
        pushAndBroadcastRealtimeEvent({
          targetUserId: req.appUser!.id,
          includeOperators: true,
          userPayload: { type: 'journey:updated', journey: updated },
          operatorPayload: { type: 'journey:updated', journey: updated },
        });
      }
      res.json({ journey: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not escalate journey.' });
    }
  });

  app.post('/api/journeys/:id/refresh', requireAuth, mapsLimiter, async (req: AuthRequest, res) => {
    try {
      const journeyId = parsePositiveInt(req.params.id);
      if (!journeyId) return res.status(400).json({ error: 'Valid journey ID is required.' });
      const existing = await getSafetyJourneyById(journeyId);
      if (!existing) return res.status(404).json({ error: 'Journey not found.' });
      if (existing.userId !== req.appUser!.id) return res.status(403).json({ error: 'Forbidden.' });

      const [weather, incidents, reports, supportHubs] = await Promise.all([
        fetchOpenMeteoWeather(existing.destinationLat, existing.destinationLng),
        listIncidentsForPulse(150),
        listSafetyReportsForPulse(100),
        listSupportDirectory(),
      ]);
      const risk = computePredictiveRisk({
        latitude: existing.destinationLat,
        longitude: existing.destinationLng,
        locationLabel: existing.destinationLabel,
        weather,
        incidents,
        reports,
        supportHubs,
      });
      const updated = await refreshSafetyJourneyRisk(
        req.appUser!.id,
        journeyId,
        `${existing.selectedRouteSummary.split(' · Refreshed')[0]} · Refreshed (${risk.riskLevel})`,
        risk.riskLevel
      );
      if (updated) {
        sendRealtimeToUser(req.appUser!.id, { type: 'journey:updated', journey: updated });
      }
      res.json({ journey: updated, risk });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to refresh route conditions.' });
    }
  });

  // ========================
  // AGENTIC AI ENGINE (6 AGENTS + SUPPORT CHAT + TRANSCRIBE + TTS)
  // ========================
  app.post('/api/ai/assess-emergency', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { description, locationLabel, incidentId, imageBase64, imageMimeType } = req.body as {
        description?: unknown;
        locationLabel?: unknown;
        incidentId?: unknown;
        imageBase64?: unknown;
        imageMimeType?: unknown;
      };
      const cleanDesc = sanitizeBoundedString(description, 4000);
      if (!cleanDesc) {
        return res.status(400).json({ error: 'Please describe the situation for emergency assessment.' });
      }

      let verifiedIncidentId: number | null = null;
      if (incidentId !== undefined && incidentId !== null) {
        const parsedId = parsePositiveInt(incidentId);
        if (!parsedId) return res.status(400).json({ error: 'Invalid incidentId.' });
        const inc = await getIncidentById(parsedId);
        if (!inc) return res.status(404).json({ error: 'Referenced incident not found.' });
        if (inc.userId !== req.appUser!.id && !OPERATOR_ROLES.includes(req.appUser!.role)) {
          return res.status(403).json({ error: 'Forbidden: Cannot attach assessment to this incident.' });
        }
        verifiedIncidentId = parsedId;
      }

      const assessment = await runEmergencyAssessmentAgent({
        description: cleanDesc,
        locationLabel: sanitizeBoundedString(locationLabel, 240) || undefined,
        imageBase64: typeof imageBase64 === 'string' && imageBase64.length <= 8_000_000 ? imageBase64 : undefined,
        imageMimeType: typeof imageMimeType === 'string' ? sanitizeBoundedString(imageMimeType, 64) : undefined,
      });

      await saveAiAssessment({
        incidentId: verifiedIncidentId,
        userId: req.appUser!.id,
        agentName: 'Emergency Assessment Agent',
        modelUsed: assessment.modelUsed,
        inputSummary: cleanDesc,
        urgencyLevel: String(assessment.urgencyLevel || 'HIGH'),
        classification: String(assessment.classification || 'Safety Concern'),
        assignedPriority: String(assessment.recommendedPriority || 'HIGH'),
        confidenceScore: Number(assessment.confidenceScore ?? 0.7),
        rationale: String(assessment.rationale || ''),
        missingInfoQuestions: Array.isArray(assessment.missingInfoQuestions) ? assessment.missingInfoQuestions : [],
        uncertaintyNotes: String(assessment.uncertaintyNotes || ''),
        escalateToHuman: Boolean(assessment.escalateToHumanOperator),
        rawStructuredOutput: assessment as unknown as Record<string, unknown>,
        recommendations: (Array.isArray(assessment.immediateSteps) ? assessment.immediateSteps : []).map(
          (step: string, idx: number) => ({
            title: `Immediate Step ${idx + 1}`,
            text: step,
            category: 'Emergency Triage',
            sourceCitation: `${assessment.modelUsed} (${assessment.verificationStatus})`,
          })
        ),
      });

      res.json({ assessment });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Emergency assessment failed.' });
    }
  });

  app.post('/api/ai/safety-intelligence', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { concern, areaLabel, timeContext, useSearchGrounding } = req.body as {
        concern?: unknown;
        areaLabel?: unknown;
        timeContext?: unknown;
        useSearchGrounding?: unknown;
      };
      const cleanConcern = sanitizeBoundedString(concern, 2000);
      if (!cleanConcern) {
        return res.status(400).json({ error: 'Please provide a safety concern or route question.' });
      }
      const intelligence = await runSafetyIntelligenceAgent({
        concern: cleanConcern,
        areaLabel: sanitizeBoundedString(areaLabel, 200) || undefined,
        timeContext: sanitizeBoundedString(timeContext, 100) || undefined,
        useSearchGrounding: Boolean(useSearchGrounding),
      });

      await saveAiAssessment({
        userId: req.appUser!.id,
        agentName: 'Safety Intelligence Agent',
        modelUsed: intelligence.modelUsed,
        inputSummary: cleanConcern,
        urgencyLevel: 'ADVISORY',
        classification: 'Contextual Safety Guidance',
        assignedPriority: 'MEDIUM',
        confidenceScore: 0.78,
        rationale: String(intelligence.summary || ''),
        missingInfoQuestions: [],
        uncertaintyNotes: String(intelligence.uncertaintyDisclosure || ''),
        escalateToHuman: false,
        rawStructuredOutput: intelligence as unknown as Record<string, unknown>,
        recommendations: (Array.isArray(intelligence.recommendations) ? intelligence.recommendations : []).map(
          (rec: { title: string; detail: string }) => ({
            title: rec.title,
            text: rec.detail,
            category: 'Safety Intelligence',
            sourceCitation: `${intelligence.modelUsed} (${intelligence.verificationStatus})`,
          })
        ),
      });

      res.json({ intelligence });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Safety intelligence analysis failed.' });
    }
  });

  app.post('/api/ai/discover-resources', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { query, latitude, longitude } = req.body as {
        query?: unknown;
        latitude?: unknown;
        longitude?: unknown;
      };
      const cleanQuery = sanitizeBoundedString(query, 300);
      if (!cleanQuery) {
        return res.status(400).json({ error: 'Search query is required for resource discovery.' });
      }
      const coordCheck = validateOptionalCoordinates(latitude, longitude);
      if (!coordCheck.valid) {
        return res.status(400).json({ error: coordCheck.error });
      }

      const discovery = await runResourceDiscoveryAgent({
        query: cleanQuery,
        latitude: coordCheck.latitude ?? undefined,
        longitude: coordCheck.longitude ?? undefined,
      });
      res.json({ discovery });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Resource discovery agent failed.' });
    }
  });

  app.post('/api/ai/coordinate', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { incidentTitle, incidentDescription, incidentStatus, locationLabel } = req.body as {
        incidentTitle?: unknown;
        incidentDescription?: unknown;
        incidentStatus?: unknown;
        locationLabel?: unknown;
      };
      const contacts = await listTrustedContacts(req.appUser!.id);
      const coordination = await runEmergencyCoordinationAgent({
        incidentTitle: sanitizeBoundedString(incidentTitle, 160) || 'Active Safety Check-In',
        incidentDescription: sanitizeBoundedString(incidentDescription, 2000) || 'Preparing coordinated emergency workflow.',
        incidentStatus: sanitizeBoundedString(incidentStatus, 60) || 'SOS Activated',
        locationLabel: sanitizeBoundedString(locationLabel, 200) || 'Current location',
        trustedContactsCount: contacts.length,
      });
      res.json({ coordination });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Coordination agent failed.' });
    }
  });

  app.post('/api/ai/assistant', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { history, message, fastMode, language } = req.body as {
        history?: unknown;
        message?: unknown;
        fastMode?: unknown;
        language?: unknown;
      };
      const cleanMessage = sanitizeBoundedString(message, 2000);
      if (!cleanMessage) {
        return res.status(400).json({ error: 'Message is required.' });
      }
      const cleanHistory = Array.isArray(history)
        ? history
            .filter(
              (h): h is { role: 'user' | 'model'; text: string } =>
                Boolean(h) &&
                (h.role === 'user' || h.role === 'model') &&
                typeof h.text === 'string' &&
                h.text.trim().length > 0
            )
            .slice(-20)
            .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }))
        : [];
      const reply = await runSupportAssistantChat({
        history: cleanHistory,
        message: cleanMessage,
        fastMode: Boolean(fastMode),
        language: language === 'kn' ? 'kn' : 'en',
      });
      res.json(reply);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Assistant request failed.' });
    }
  });

  app.post('/api/ai/saferoute', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const routesRaw = Array.isArray(body.routes) ? body.routes : [];
      if (routesRaw.length === 0) {
        return res.status(400).json({ error: 'At least one candidate route is required for SafeRoute Agent analysis.' });
      }
      const routes = routesRaw.slice(0, 6).map((r: unknown, idx: number) => {
        const obj = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        return {
          routeIndex: typeof obj.routeIndex === 'number' ? obj.routeIndex : idx,
          summary: sanitizeBoundedString(obj.summary, 160) || `Option ${idx + 1}`,
          durationLabel: sanitizeBoundedString(obj.durationLabel, 40) || 'Unknown',
          distanceMeters: Number.isFinite(Number(obj.distanceMeters)) ? Number(obj.distanceMeters) : 0,
          safetyScore: Number.isFinite(Number(obj.safetyScore)) ? Number(obj.safetyScore) : 70,
          riskLevel: sanitizeBoundedString(obj.riskLevel, 24) || 'MODERATE',
          nearbyIncidentsCount: Number.isFinite(Number(obj.nearbyIncidentsCount)) ? Number(obj.nearbyIncidentsCount) : 0,
          nearbySupportHubsCount: Number.isFinite(Number(obj.nearbySupportHubsCount)) ? Number(obj.nearbySupportHubsCount) : 0,
          reasons: Array.isArray(obj.reasons)
            ? obj.reasons.filter((x): x is string => typeof x === 'string').slice(0, 5)
            : [],
        };
      });

      const saferoute = await runSafeRouteAgent({
        originLabel: sanitizeBoundedString(body.originLabel, 180) || 'Origin',
        destinationLabel: sanitizeBoundedString(body.destinationLabel, 180) || 'Destination',
        travelMode: sanitizeBoundedString(body.travelMode, 24) || 'WALK',
        weatherSummary: sanitizeBoundedString(body.weatherSummary, 240) || 'Unavailable',
        routes,
      });

      await saveAiAssessment({
        userId: req.appUser!.id,
        agentName: 'SafeRoute Agent',
        modelUsed: saferoute.modelUsed,
        inputSummary: `${sanitizeBoundedString(body.originLabel, 80)} -> ${sanitizeBoundedString(body.destinationLabel, 80)}`,
        urgencyLevel: 'ADVISORY',
        classification: 'SafeRoute Comparison',
        assignedPriority: 'LOW',
        confidenceScore: saferoute.confidenceScore,
        rationale: saferoute.safetyReasoning,
        missingInfoQuestions: [],
        uncertaintyNotes: saferoute.uncertaintyNotes,
        escalateToHuman: false,
        rawStructuredOutput: saferoute as unknown as Record<string, unknown>,
        recommendations: saferoute.cautionNotes.map((c: string, i: number) => ({
          title: `Route Caution ${i + 1}`,
          text: c,
          category: 'SafeRoute Intelligence',
          sourceCitation: saferoute.modelUsed,
        })),
      });

      res.json({ saferoute });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'SafeRoute Agent failed.' });
    }
  });

  app.post('/api/ai/follow-up', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const incidentTitle = sanitizeBoundedString(body.incidentTitle, 160);
      if (!incidentTitle) {
        return res.status(400).json({ error: 'incidentTitle is required for post-incident follow-up.' });
      }
      const followUp = await runIncidentFollowUpAgent({
        incidentTitle,
        incidentStatus: sanitizeBoundedString(body.incidentStatus, 60) || 'Resolved',
        incidentCategory: sanitizeBoundedString(body.incidentCategory, 60) || 'Personal Safety',
        locationLabel: sanitizeBoundedString(body.locationLabel, 200) || 'Not specified',
        resolutionNotes: sanitizeBoundedString(body.resolutionNotes, 1000) || undefined,
        language: body.language === 'kn' ? 'kn' : 'en',
      });

      await saveAiAssessment({
        userId: req.appUser!.id,
        agentName: 'Incident Follow-up Agent',
        modelUsed: followUp.modelUsed,
        inputSummary: incidentTitle,
        urgencyLevel: 'LOW',
        classification: 'Post-Incident Follow-up',
        assignedPriority: 'LOW',
        confidenceScore: 0.85,
        rationale: followUp.summary,
        missingInfoQuestions: [],
        uncertaintyNotes: followUp.supportFollowUpWindow,
        escalateToHuman: false,
        rawStructuredOutput: followUp as unknown as Record<string, unknown>,
        recommendations: followUp.immediateWellbeingSteps.map((step: string, idx: number) => ({
          title: `Wellbeing Follow-up ${idx + 1}`,
          text: step,
          category: 'Incident Follow-up',
          sourceCitation: followUp.modelUsed,
          actionRequiredAuth: true,
        })),
      });

      res.json({ followUp });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Incident Follow-up Agent failed.' });
    }
  });

  app.post('/api/ai/transcribe', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { audioBase64, mimeType } = req.body as { audioBase64?: unknown; mimeType?: unknown };
      if (
        typeof audioBase64 !== 'string' ||
        !audioBase64 ||
        audioBase64.length > 10_000_000 ||
        typeof mimeType !== 'string' ||
        !mimeType
      ) {
        return res.status(400).json({ error: 'Valid audio payload and mimeType are required.' });
      }
      const result = await transcribeAudioNote(audioBase64, sanitizeBoundedString(mimeType, 64));
      res.json(result);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Audio transcription failed.' });
    }
  });

  app.post('/api/ai/tts', requireAuth, aiLimiter, async (req: AuthRequest, res) => {
    try {
      const { text, voiceName } = req.body as { text?: unknown; voiceName?: unknown };
      const cleanText = sanitizeBoundedString(text, 1000);
      if (!cleanText) {
        return res.status(400).json({ error: 'Text is required for speech synthesis.' });
      }
      const audio = await synthesizeSafetyGuidanceSpeech(cleanText, sanitizeBoundedString(voiceName, 32) || 'Kore');
      res.json(audio);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        return res.status(err.statusCode).json({ error: err.message, reason: err.reason });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Voice readout failed.' });
    }
  });

  app.get('/api/ai/recommendations', requireAuth, async (req: AuthRequest, res) => {
    const recommendations = await listAiRecommendationsForUser(req.appUser!.id);
    res.json({ recommendations });
  });

  // ========================
  // NOTIFICATIONS, ANALYTICS & ADMIN
  // ========================
  app.get('/api/notifications', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>, { limit: 30, maxLimit: 100 });
      const [items, total] = await Promise.all([
        listNotificationsForUser(req.appUser!.id, { limit, offset }),
        countNotificationsForUser(req.appUser!.id),
      ]);
      res.json({
        notifications: items,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load notifications.' });
    }
  });

  app.patch('/api/notifications/read-all', requireAuth, async (req: AuthRequest, res) => {
    try {
      const count = await markAllNotificationsRead(req.appUser!.id);
      res.json({ ok: true, updatedCount: count });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to mark notifications read.' });
    }
  });

  app.patch('/api/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
    try {
      const notifId = parsePositiveInt(req.params.id);
      if (!notifId) {
        return res.status(400).json({ error: 'Valid notification ID is required.' });
      }
      const updated = await markNotificationRead(req.appUser!.id, notifId);
      if (!updated) {
        return res.status(404).json({ error: 'Notification not found.' });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update notification.' });
    }
  });

  app.get('/api/analytics', requireAuth, requireRole(OPERATOR_ROLES), async (_req, res) => {
    try {
      const analytics = await getOperationalAnalytics();
      res.json(analytics);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load analytics.' });
    }
  });

  app.get(
    '/api/admin/audit-logs',
    requireAuth,
    requireRole(['administrator', 'emergency_operator']),
    async (req, res) => {
      const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>, { limit: 50, maxLimit: 100 });
      const [logs, total] = await Promise.all([listAuditLogs(limit, offset), countAuditLogs()]);
      res.json({
        logs,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      });
    }
  );

  app.get('/api/admin/users', requireAuth, requireRole(['administrator']), async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query as Record<string, unknown>, { limit: 50, maxLimit: 100 });
    const [users, total] = await Promise.all([
      listUsersForAdminPaginated(limit, offset),
      countAllUsers(),
    ]);
    res.json({
      users,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  app.patch('/api/admin/users/:id/role', requireAuth, requireRole(['administrator']), async (req: AuthRequest, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (!targetId) {
        return res.status(400).json({ error: 'Valid target user ID is required.' });
      }
      const { role } = req.body as { role?: unknown };
      if (typeof role !== 'string' || !(VALID_USER_ROLES as readonly string[]).includes(role)) {
        return res.status(400).json({ error: 'Invalid role.' });
      }
      const updated = await updateUserRole(targetId, role as UserRole);
      if (!updated) return res.status(404).json({ error: 'User not found.' });

      await writeAuditLog({
        actorUserId: req.appUser!.id,
        actorEmail: req.appUser!.email,
        actorRole: req.appUser!.role,
        action: 'USER_ROLE_CHANGED',
        resourceType: 'user',
        resourceId: String(targetId),
        details: { newRole: role },
        ipAddress: req.ip,
      });
      res.json({ user: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update user role.' });
    }
  });

  app.get(
    '/api/admin/monitoring',
    requireAuth,
    requireRole(['administrator', 'emergency_operator']),
    async (_req, res) => {
      try {
        const dbHealth = await checkDatabaseHealth();
        const cacheStats = cacheQueue.getStats();
        const aiRuntime = getAiRuntimeStatus();
        const snapshot = metrics.buildSnapshot({
          database: {
            dialect: dbHealth.dialect,
            ok: dbHealth.ok,
            healthLatencyMs: dbHealth.latencyMs,
            avgQueryLatencyMs: 0,
            p95QueryLatencyMs: 0,
            pool:
              dbHealth.dialect === 'postgres'
                ? getPoolStats()
                : { totalCount: 1, idleCount: 1, waitingCount: 0, maxConnections: 1 },
          },
          websockets: {
            realtimeActive: realtimeClients.size,
            liveVoiceActive: liveClients.size,
            maxRealtimeCapacity: MAX_REALTIME_TOTAL,
            maxLiveCapacity: MAX_LIVE_TOTAL,
            pubsubMode: cacheQueue.isRedisActive() ? 'redis' : 'local',
          },
          cacheAndQueue: cacheStats,
          aiRuntime,
        });
        res.json(snapshot);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to collect monitoring snapshot.' });
      }
    }
  );

  app.use('/api', errorHandlerMiddleware);

  // ========================
  // HTTP SERVER + VITE / STATIC + HARDENED WEBSOCKETS
  // ========================
  const httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.requestTimeout = 30_000;

  const wssRealtime = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const wssLive = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  wssRealtime.on('connection', async (ws, req) => {
    const token = extractWsToken(req);
    const resolvedUser = await resolveUserFromToken(token);

    if (!resolvedUser) {
      ws.close(1008, 'Authentication required');
      return;
    }

    if (realtimeClients.size >= MAX_REALTIME_TOTAL) {
      ws.close(1013, 'Realtime server capacity reached');
      return;
    }
    let userSocketCount = 0;
    for (const c of realtimeClients) {
      if (c.userId === resolvedUser.id) userSocketCount++;
    }
    if (userSocketCount >= MAX_REALTIME_PER_USER) {
      ws.close(1008, 'Per-user realtime connection limit exceeded');
      return;
    }

    const clientEntry: RealtimeClient = {
      ws,
      userId: resolvedUser.id,
      role: resolvedUser.role,
      isAlive: true,
      msgWindowStart: Date.now(),
      msgCount: 0,
    };
    realtimeClients.add(clientEntry);

    ws.on('pong', () => {
      clientEntry.isAlive = true;
    });

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - clientEntry.msgWindowStart > 10_000) {
        clientEntry.msgWindowStart = now;
        clientEntry.msgCount = 0;
      }
      clientEntry.msgCount++;
      if (clientEntry.msgCount > 30) {
        metrics.recordWsRateLimited();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', error: 'WebSocket message rate limit exceeded.' }));
        }
        return;
      }

      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'ping') {
          clientEntry.isAlive = true;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.send(
      JSON.stringify({
        type: 'realtime:connected',
        role: resolvedUser.role,
        latestSeq: currentEventSeq,
      })
    );

    // Missed-event recovery combining durable DB event history + local buffer via ?since=<seq>
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sinceParam = url.searchParams.get('since');
    if (sinceParam && /^\d+$/.test(sinceParam)) {
      const sinceSeq = Number(sinceParam);
      const isOperator = OPERATOR_ROLES.includes(resolvedUser.role);
      const deliveredSeqs = new Set<number>();

      try {
        const persisted = await listRealtimeEventsSince(sinceSeq, resolvedUser.id, isOperator, 200);
        for (const item of persisted) {
          if (ws.readyState !== WebSocket.OPEN) break;
          deliveredSeqs.add(item.seq);
          ws.send(JSON.stringify(item.payload));
        }
      } catch {
        // fall through to local replay buffer
      }

      for (const ev of eventReplayBuffer) {
        if (ev.seq <= sinceSeq || deliveredSeqs.has(ev.seq)) continue;
        if (ws.readyState !== WebSocket.OPEN) break;
        if (ev.includeOperators && isOperator) {
          ws.send(JSON.stringify(ev.operatorPayload));
        } else if (ev.targetUserId === resolvedUser.id) {
          ws.send(JSON.stringify(ev.userPayload));
        }
      }
    }

    ws.on('close', () => {
      realtimeClients.delete(clientEntry);
    });
  });

  wssLive.on('connection', async (clientWs, req) => {
    const token = extractWsToken(req);
    const resolvedUser = await resolveUserFromToken(token);
    if (!resolvedUser) {
      clientWs.close(1008, 'Authentication required');
      return;
    }

    if (liveClients.size >= MAX_LIVE_TOTAL) {
      clientWs.close(1013, 'Voice companion capacity reached');
      return;
    }
    let userLiveCount = 0;
    for (const c of liveClients) {
      if (c.userId === resolvedUser.id) userLiveCount++;
    }
    if (userLiveCount >= MAX_LIVE_PER_USER) {
      clientWs.close(1008, 'Per-user live voice session limit exceeded');
      return;
    }

    const liveEntry = {
      ws: clientWs,
      userId: resolvedUser.id,
      isAlive: true,
      msgWindowStart: Date.now(),
      msgCount: 0,
    };
    liveClients.add(liveEntry);
    clientWs.on('pong', () => {
      liveEntry.isAlive = true;
    });

    if (!isGeminiConfigured()) {
      clientWs.send(JSON.stringify({ error: 'Gemini Live API key is not configured on the server.' }));
      liveClients.delete(liveEntry);
      clientWs.close(1008, 'Gemini API key unavailable');
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
    try {
      session = await ai.live.connect({
        model: GEMINI_MODELS.live,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction:
            'You are the LIFE-LINE AI Voice Safety Companion. Speak calmly, concisely, and reassuringly. Help the user assess their surroundings, stay in populated well-lit spaces, or trigger SOS on their screen. Remind them to dial local emergency services (911/112/999) if in immediate physical danger.',
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              clientWs.send(JSON.stringify({ inputTranscript: content.inputTranscription.text }));
            }
            if (content?.outputTranscription?.text) {
              clientWs.send(JSON.stringify({ outputTranscript: content.outputTranscription.text }));
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
            if (content?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onerror: (e) => {
            console.error('Gemini Live error:', e);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ error: 'Live audio stream interrupted.' }));
            }
          },
        },
      });
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ ready: true }));
      }
    } catch (err) {
      console.error('Failed to connect Gemini Live:', err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ error: 'Unable to open Gemini Live voice session.' }));
      }
      liveClients.delete(liveEntry);
      clientWs.close();
      return;
    }

    clientWs.on('message', (raw) => {
      if (!session) return;
      const now = Date.now();
      if (now - liveEntry.msgWindowStart > 10_000) {
        liveEntry.msgWindowStart = now;
        liveEntry.msgCount = 0;
      }
      liveEntry.msgCount++;
      if (liveEntry.msgCount > 200) {
        metrics.recordWsRateLimited();
        return;
      }
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string; audio?: string; text?: string };
        if (payload.type === 'ping') {
          liveEntry.isAlive = true;
          return;
        }
        if (payload.audio && payload.audio.length <= 2_000_000) {
          session.sendRealtimeInput({
            audio: { data: payload.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (payload.text) {
          session.sendRealtimeInput({ text: payload.text.slice(0, 1000) });
        }
      } catch {
        // ignore invalid live frame
      }
    });

    clientWs.on('close', () => {
      liveClients.delete(liveEntry);
      try {
        session?.close();
      } catch {
        // ignore close error
      }
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const client of realtimeClients) {
      if (!client.isAlive) {
        realtimeClients.delete(client);
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
    for (const client of liveClients) {
      if (!client.isAlive) {
        liveClients.delete(client);
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    if (pathname === '/ws/realtime') {
      wssRealtime.handleUpgrade(request, socket, head, (ws) => {
        wssRealtime.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/live') {
      wssLive.handleUpgrade(request, socket, head, (ws) => {
        wssLive.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const enableVite = options?.enableVite ?? process.env.NODE_ENV !== 'production';
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (enableVite) {
    viteServer = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });

    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await viteServer!.transformRequest('/@vite/client');
        if (!result) return next();
        const patched = result.code.replace(
          /const transport = normalizeModuleRunnerTransport\(\(\(\) => \{[\s\S]*?\}\)\(\)\);/,
          'const transport = normalizeModuleRunnerTransport({ connect() {}, disconnect() {}, send() {} });'
        );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(patched);
      } catch (err) {
        next(err);
      }
    });

    app.use(viteServer.middlewares);
  } else if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        maxAge: '365d',
        immutable: true,
      })
    );
    app.use(express.static(distDir, { maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  startLiveFeedPolling({
    intervalMs: 180_000,
    onNewAlerts: (newAlerts) => {
      pushAndBroadcastRealtimeEvent({
        includeOperators: true,
        broadcastAll: true,
        userPayload: { type: 'live_incident:sync', alerts: newAlerts },
        operatorPayload: { type: 'live_incident:sync', alerts: newAlerts },
      });
    },
  });

  const shutdown = async () => {
    isDraining = true;
    stopLiveFeedPolling();
    clearInterval(heartbeatInterval);
    for (const c of realtimeClients) {
      try {
        c.ws.close(1012, 'Server restarting');
      } catch {
        // ignore
      }
    }
    for (const c of liveClients) {
      try {
        c.ws.close(1012, 'Server restarting');
      } catch {
        // ignore
      }
    }
    wssRealtime.close();
    wssLive.close();
    if (viteServer) await viteServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await cacheQueue.close().catch(() => {});
    await closePool().catch(() => {});
  };

  return { app, httpServer, wssRealtime, wssLive, shutdown };
}

async function startServer() {
  const PORT = Number(process.env.PORT || 3000);
  const { httpServer, shutdown } = await createAppServer();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`LIFE-LINE AI server listening on http://0.0.0.0:${PORT}`);
  });

  let shuttingDown = false;
  const handleSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] Received ${signal}, initiating graceful shutdown...`);
    void shutdown().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
  });
}

const isMainEntry =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainEntry && process.env.LIFELINE_NO_AUTOSTART !== 'true') {
  startServer().catch((err) => {
    console.error('Fatal server startup error:', err);
    process.exit(1);
  });
}
