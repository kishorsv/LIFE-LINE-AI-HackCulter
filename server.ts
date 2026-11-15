import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  addTrustedContact,
  completePasswordReset,
  createIncident,
  deleteTrustedContact,
  deleteUserAccount,
  getDemoAccounts,
  getIncidentById,
  getOperationalAnalytics,
  getOrCreateUserByFirebase,
  getUserById,
  getUserProfile,
  initiatePasswordReset,
  listAllIncidentsForOperator,
  listAllUsersForAdmin,
  listAiRecommendationsForUser,
  listAuditLogs,
  listIncidentsForUser,
  listNotificationsForUser,
  listOperatorUserIds,
  listSupportDirectory,
  listTrustedContacts,
  loginEmailUser,
  markNotificationRead,
  registerEmailUser,
  saveAiAssessment,
  updateIncidentStatus,
  updateTrustedContact,
  updateUserProfile,
  updateUserRole,
  UserRole,
  verifyUserEmailCode,
  writeAuditLog,
} from './src/db/repository.ts';
import { AuthRequest, requireAuth, requireRole, signAppToken, verifyAppToken } from './src/middleware/auth.ts';
import { adminAuth } from './src/lib/firebase-admin.ts';
import {
  runEmergencyAssessmentAgent,
  runEmergencyCoordinationAgent,
  runResourceDiscoveryAgent,
  runSafetyIntelligenceAgent,
  runSupportAssistantChat,
  synthesizeSafetyGuidanceSpeech,
  transcribeAudioNote,
} from './src/services/gemini.ts';
import { dispatchEmergencyNotifications } from './src/services/notifications.ts';

const PORT = Number(process.env.PORT || 3000);
const MAPS_ATTRIBUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';

const app = express();
app.use(express.json({ limit: '15mb' }));

// Track authenticated realtime WebSocket clients
interface RealtimeClient {
  ws: WebSocket;
  userId: number;
  role: UserRole;
}
const realtimeClients = new Set<RealtimeClient>();

function broadcastRealtimeEvent(
  eventPayload: Record<string, unknown>,
  targetUserId?: number,
  includeOperators = false
) {
  const serialized = JSON.stringify(eventPayload);
  for (const client of realtimeClients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    const isTargetUser = targetUserId !== undefined && client.userId === targetUserId;
    const isAuthorizedOperator =
      includeOperators && ['emergency_operator', 'support_organization', 'administrator'].includes(client.role);
    if (isTargetUser || isAuthorizedOperator) {
      client.ws.send(serialized);
    }
  }
}

function sendRealtimeToUser(userId: number, payload: Record<string, unknown>) {
  const serialized = JSON.stringify(payload);
  for (const client of realtimeClients) {
    if (client.ws.readyState === WebSocket.OPEN && client.userId === userId) {
      client.ws.send(serialized);
    }
  }
}

// Health & non-secret client config
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'LIFE-LINE AI',
    timestamp: new Date().toISOString(),
    aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
  });
});

app.get('/api/config/public', (_req, res) => {
  res.json({
    mapsApiKey: process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
    appUrl: process.env.APP_URL || '',
  });
});

// ========================
// AUTHENTICATION & RBAC
// ========================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, displayName, role } = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
      role?: string;
    };

    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Valid email and password (minimum 8 characters) are required.' });
    }

    // Strictly forbid public self-registration as administrator
    if (role === 'administrator') {
      await writeAuditLog({
        actorEmail: email,
        actorRole: 'public',
        action: 'BLOCKED_ADMIN_SELF_REGISTRATION',
        resourceType: 'user',
        ipAddress: req.ip,
      });
      return res.status(403).json({
        error: 'Public self-registration as administrator is prohibited. Administrators must be provisioned internally.',
      });
    }

    const allowedPublicRoles = new Set(['regular_user', 'emergency_operator', 'support_organization']);
    const chosenRole = allowedPublicRoles.has(role || '') ? (role as 'regular_user' | 'emergency_operator' | 'support_organization') : 'regular_user';

    const { user, verificationCode } = await registerEmailUser({
      email,
      password,
      displayName: displayName || email.split('@')[0],
      role: chosenRole,
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
      // Provided when external SMTP is unconfigured so local/demo email verification works cleanly
      verificationCodePreview: process.env.RESEND_API_KEY ? undefined : verificationCode,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const user = await loginEmailUser(email, password);
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
    res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid credentials.' });
  }
});

app.post('/api/auth/verify-email', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });
    const updated = await verifyUserEmailCode(req.appUser!.id, code);
    await writeAuditLog({
      actorUserId: updated.id,
      actorEmail: updated.email,
      actorRole: updated.role,
      action: 'EMAIL_VERIFIED',
      resourceType: 'user',
      resourceId: String(updated.id),
    });
    res.json({ user: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Email verification failed.' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const result = await initiatePasswordReset(email);
    res.json({
      message: 'If an account matches that email, a password reset code has been generated.',
      resetCodePreview: !process.env.RESEND_API_KEY && result ? result.resetCode : undefined,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not initiate password reset.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body as { email?: string; code?: string; newPassword?: string };
    if (!email || !code || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Valid email, reset code, and password (8+ characters) are required.' });
    }
    const ok = await completePasswordReset(email, code, newPassword);
    if (!ok) return res.status(400).json({ error: 'Invalid or expired reset code.' });
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

app.post('/api/auth/demo-login', async (req, res) => {
  try {
    const { role } = req.body as { role?: UserRole };
    const accounts = await getDemoAccounts();
    const target = accounts.find((a) => a.role === (role || 'regular_user'));
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
    const updated = await updateUserProfile(req.appUser!.id, req.body);
    await writeAuditLog({
      actorUserId: req.appUser!.id,
      actorEmail: req.appUser!.email,
      actorRole: req.appUser!.role,
      action: 'PROFILE_UPDATED',
      resourceType: 'user_profile',
      resourceId: String(req.appUser!.id),
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
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contact name is required.' });
    }
    const contact = await addTrustedContact(req.appUser!.id, req.body);
    await writeAuditLog({
      actorUserId: req.appUser!.id,
      actorEmail: req.appUser!.email,
      actorRole: req.appUser!.role,
      action: 'TRUSTED_CONTACT_ADDED',
      resourceType: 'trusted_contact',
      resourceId: String(contact.id),
    });
    res.status(201).json({ contact });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add contact.' });
  }
});

app.put('/api/contacts/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const contactId = Number(req.params.id);
    const contacts = await updateTrustedContact(req.appUser!.id, contactId, req.body);
    res.json({ contacts });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update contact.' });
  }
});

app.delete('/api/contacts/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const contactId = Number(req.params.id);
    await deleteTrustedContact(req.appUser!.id, contactId);
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to remove contact.' });
  }
});

// ========================
// SOS & INCIDENT MANAGEMENT
// ========================
app.post('/api/incidents/sos', requireAuth, async (req: AuthRequest, res) => {
  try {
    const {
      title,
      description,
      category,
      priority,
      latitude,
      longitude,
      locationLabel,
      locationAccuracyMeters,
      isSimulated,
    } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      priority?: string;
      latitude?: number | null;
      longitude?: number | null;
      locationLabel?: string;
      locationAccuracyMeters?: number | null;
      isSimulated?: boolean;
    };

    const simulatedFlag = Boolean(isSimulated || req.appUser!.isDemoAccount);
    const incident = await createIncident({
      userId: req.appUser!.id,
      title: title?.trim() || (simulatedFlag ? '[SIMULATED] Emergency SOS Alert' : 'Emergency SOS Alert'),
      description: description?.trim() || 'User activated LIFE-LINE AI SOS.',
      category: category || 'Personal Safety',
      priority: priority || 'CRITICAL',
      latitude: typeof latitude === 'number' ? latitude : null,
      longitude: typeof longitude === 'number' ? longitude : null,
      locationLabel: locationLabel || 'Location shared via browser/device',
      locationAccuracyMeters: typeof locationAccuracyMeters === 'number' ? locationAccuracyMeters : null,
      isSimulated: simulatedFlag,
    });

    if (!incident) {
      return res.status(500).json({ error: 'Incident creation failed.' });
    }

    const contacts = await listTrustedContacts(req.appUser!.id);
    const operatorIds = await listOperatorUserIds();
    const googleToken = req.headers['x-google-access-token'] ? String(req.headers['x-google-access-token']) : undefined;

    let deliveryResults: Array<{ recipient: string; channel: string; status: string; provider: string }> = [];
    try {
      deliveryResults = await dispatchEmergencyNotifications({
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
      console.error('Notification dispatch notice:', notifyErr);
    }

    const sentIncident = await updateIncidentStatus({
      incidentId: incident.id,
      actorUserId: req.appUser!.id,
      actorRole: req.appUser!.role,
      newStatus: 'Alert Sent',
      note:
        contacts.length > 0
          ? `Alert dispatched to ${contacts.length} trusted contact(s) and active LIFE-LINE AI operators.`
          : 'Alert routed to active LIFE-LINE AI operators. No trusted contacts configured yet.',
    });

    await writeAuditLog({
      actorUserId: req.appUser!.id,
      actorEmail: req.appUser!.email,
      actorRole: req.appUser!.role,
      action: simulatedFlag ? 'SIMULATED_SOS_ACTIVATED' : 'SOS_ACTIVATED',
      resourceType: 'emergency_incident',
      resourceId: String(incident.id),
      details: { locationLabel: incident.locationLabel, contactsNotified: contacts.length },
      ipAddress: req.ip,
    });

    broadcastRealtimeEvent(
      { type: 'incident:created', incident: sentIncident },
      req.appUser!.id,
      true
    );

    res.status(201).json({ incident: sentIncident, deliveryResults });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to activate SOS.' });
  }
});

app.get('/api/incidents', requireAuth, async (req: AuthRequest, res) => {
  try {
    const incidents = await listIncidentsForUser(req.appUser!.id);
    res.json({ incidents });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load incidents.' });
  }
});

app.get(
  '/api/operator/incidents',
  requireAuth,
  requireRole(['emergency_operator', 'support_organization', 'administrator']),
  async (_req, res) => {
    try {
      const incidents = await listAllIncidentsForOperator();
      res.json({ incidents });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load operator queue.' });
    }
  }
);

app.patch('/api/incidents/:id/status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const incidentId = Number(req.params.id);
    const existing = await getIncidentById(incidentId);
    if (!existing) return res.status(404).json({ error: 'Incident not found.' });

    const { status, note, priority, isInternal } = req.body as {
      status?: string;
      note?: string;
      priority?: string;
      isInternal?: boolean;
    };

    const validStatuses = ['SOS Activated', 'Alert Sent', 'Acknowledged', 'Assistance in Progress', 'Resolved', 'Cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid emergency status.' });
    }

    const isOperator = ['emergency_operator', 'support_organization', 'administrator'].includes(req.appUser!.role);
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
      note,
      priority: isOperator ? priority : undefined,
      isInternal: isOperator ? Boolean(isInternal) : false,
    });

    await writeAuditLog({
      actorUserId: req.appUser!.id,
      actorEmail: req.appUser!.email,
      actorRole: req.appUser!.role,
      action: 'INCIDENT_STATUS_UPDATED',
      resourceType: 'emergency_incident',
      resourceId: String(incidentId),
      details: { previousStatus: existing.status, newStatus: status },
      ipAddress: req.ip,
    });

    broadcastRealtimeEvent(
      { type: 'incident:updated', incident: updated },
      existing.userId,
      true
    );

    res.json({ incident: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update incident.' });
  }
});

// ========================
// SUPPORT DIRECTORY & GOOGLE MAPS PROXY
// ========================
app.get('/api/support-directory', async (req, res) => {
  try {
    const category = req.query.category ? String(req.query.category) : undefined;
    const query = req.query.q ? String(req.query.q) : undefined;
    const resources = await listSupportDirectory(category, query);
    res.json({ resources });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load support directory.' });
  }
});

app.post('/api/maps/nearby-support', async (req, res) => {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    return res.status(503).json({ error: 'Google Maps Places proxy key not configured on server.' });
  }
  const { latitude, longitude, radiusMeters = 5000, includedTypes = ['hospital', 'police', 'pharmacy'] } = req.body as {
    latitude?: number;
    longitude?: number;
    radiusMeters?: number;
    includedTypes?: string[];
  };

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
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
        includedTypes,
        maxResultCount: 10,
        locationRestriction: {
          circle: {
            center: { latitude, longitude },
            radius: Math.min(Math.max(radiusMeters, 500), 25000),
          },
        },
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json(data);
    }
    res.json({ places: data.places || [], source: 'Google Places API (New)', retrievedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to query Places API.' });
  }
});

app.post('/api/maps/search-places', async (req, res) => {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    return res.status(503).json({ error: 'Google Maps Places proxy key not configured on server.' });
  }
  const { textQuery, latitude, longitude } = req.body as {
    textQuery?: string;
    latitude?: number;
    longitude?: number;
  };
  if (!textQuery || !textQuery.trim()) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  try {
    const body: Record<string, unknown> = {
      textQuery: textQuery.trim(),
      maxResultCount: 10,
    };
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      body.locationBias = {
        circle: {
          center: { latitude, longitude },
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
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json({ places: data.places || [], source: 'Google Places API (New)', retrievedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Places search failed.' });
  }
});

app.get('/api/maps/geocode', async (req, res) => {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!mapsKey) {
    return res.status(503).json({ error: 'Geocoding API key not configured.' });
  }
  const address = req.query.address ? String(req.query.address) : '';
  const latlng = req.query.latlng ? String(req.query.latlng) : '';
  if (!address && !latlng) {
    return res.status(400).json({ error: 'Provide address or latlng parameter.' });
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    if (address) url.searchParams.set('address', address);
    if (latlng) url.searchParams.set('latlng', latlng);
    url.searchParams.set('key', mapsKey);

    const resp = await fetch(url.toString(), {
      headers: { 'X-Goog-Maps-Solution-ID': MAPS_ATTRIBUTION_ID },
    });
    const data = (await resp.json()) as { status?: string; results?: unknown[]; error_message?: string };
    if (data.status === 'OVER_QUERY_LIMIT') {
      return res.status(429).json({ error: { status: 'RESOURCE_EXHAUSTED', message: data.error_message || 'Geocoding quota exceeded' } });
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Geocoding failed.' });
  }
});

// ========================
// AGENTIC AI ENGINE (5 AGENTS + TRANSCRIBE + TTS)
// ========================
app.post('/api/ai/assess-emergency', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { description, locationLabel, incidentId, imageBase64, imageMimeType } = req.body as {
      description?: string;
      locationLabel?: string;
      incidentId?: number;
      imageBase64?: string;
      imageMimeType?: string;
    };
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Please describe the situation for emergency assessment.' });
    }
    const assessment = await runEmergencyAssessmentAgent({
      description: description.trim(),
      locationLabel,
      imageBase64,
      imageMimeType,
    });

    await saveAiAssessment({
      incidentId: incidentId ?? null,
      userId: req.appUser!.id,
      agentName: 'Emergency Assessment Agent',
      modelUsed: assessment.modelUsed,
      inputSummary: description.trim(),
      urgencyLevel: String(assessment.urgencyLevel || 'HIGH'),
      classification: String(assessment.classification || 'Safety Concern'),
      assignedPriority: String(assessment.recommendedPriority || 'HIGH'),
      confidenceScore: Number(assessment.confidenceScore ?? 0.7),
      rationale: String(assessment.rationale || ''),
      missingInfoQuestions: Array.isArray(assessment.missingInfoQuestions) ? assessment.missingInfoQuestions : [],
      uncertaintyNotes: String(assessment.uncertaintyNotes || ''),
      escalateToHuman: Boolean(assessment.escalateToHumanOperator),
      rawStructuredOutput: assessment as unknown as Record<string, unknown>,
      recommendations: (Array.isArray(assessment.immediateSteps) ? assessment.immediateSteps : []).map((step: string, idx: number) => ({
        title: `Immediate Step ${idx + 1}`,
        text: step,
        category: 'Emergency Triage',
        sourceCitation: assessment.modelUsed,
      })),
    });

    res.json({ assessment });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Emergency assessment failed.' });
  }
});

app.post('/api/ai/safety-intelligence', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { concern, areaLabel, timeContext, useSearchGrounding } = req.body as {
      concern?: string;
      areaLabel?: string;
      timeContext?: string;
      useSearchGrounding?: boolean;
    };
    if (!concern || !concern.trim()) {
      return res.status(400).json({ error: 'Please provide a safety concern or route question.' });
    }
    const intelligence = await runSafetyIntelligenceAgent({
      concern: concern.trim(),
      areaLabel,
      timeContext,
      useSearchGrounding: Boolean(useSearchGrounding),
    });

    await saveAiAssessment({
      userId: req.appUser!.id,
      agentName: 'Safety Intelligence Agent',
      modelUsed: intelligence.modelUsed,
      inputSummary: concern.trim(),
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
          sourceCitation: intelligence.modelUsed,
        })
      ),
    });

    res.json({ intelligence });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Safety intelligence analysis failed.' });
  }
});

app.post('/api/ai/discover-resources', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { query, latitude, longitude } = req.body as {
      query?: string;
      latitude?: number;
      longitude?: number;
    };
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Search query is required for resource discovery.' });
    }
    const discovery = await runResourceDiscoveryAgent({
      query: query.trim(),
      latitude,
      longitude,
    });
    res.json({ discovery });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Resource discovery agent failed.' });
  }
});

app.post('/api/ai/coordinate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { incidentTitle, incidentDescription, incidentStatus, locationLabel } = req.body as {
      incidentTitle?: string;
      incidentDescription?: string;
      incidentStatus?: string;
      locationLabel?: string;
    };
    const contacts = await listTrustedContacts(req.appUser!.id);
    const coordination = await runEmergencyCoordinationAgent({
      incidentTitle: incidentTitle || 'Active Safety Check-In',
      incidentDescription: incidentDescription || 'Preparing coordinated emergency workflow.',
      incidentStatus: incidentStatus || 'SOS Activated',
      locationLabel: locationLabel || 'Current location',
      trustedContactsCount: contacts.length,
    });
    res.json({ coordination });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Coordination agent failed.' });
  }
});

app.post('/api/ai/assistant', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { history, message, fastMode } = req.body as {
      history?: Array<{ role: 'user' | 'model'; text: string }>;
      message?: string;
      fastMode?: boolean;
    };
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    const reply = await runSupportAssistantChat({
      history: Array.isArray(history) ? history : [],
      message: message.trim(),
      fastMode: Boolean(fastMode),
    });
    res.json(reply);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Assistant request failed.' });
  }
});

app.post('/api/ai/transcribe', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { audioBase64, mimeType } = req.body as { audioBase64?: string; mimeType?: string };
    if (!audioBase64 || !mimeType) {
      return res.status(400).json({ error: 'Audio payload and mimeType are required.' });
    }
    const result = await transcribeAudioNote(audioBase64, mimeType);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Audio transcription failed.' });
  }
});

app.post('/api/ai/tts', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { text, voiceName } = req.body as { text?: string; voiceName?: string };
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required for speech synthesis.' });
    }
    const audio = await synthesizeSafetyGuidanceSpeech(text.trim(), voiceName || 'Kore');
    res.json(audio);
  } catch (err) {
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
    const items = await listNotificationsForUser(req.appUser!.id);
    res.json({ notifications: items });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load notifications.' });
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
  try {
    await markNotificationRead(req.appUser!.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update notification.' });
  }
});

app.get('/api/analytics', requireAuth, async (_req, res) => {
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
  async (_req, res) => {
    const logs = await listAuditLogs(80);
    res.json({ logs });
  }
);

app.get(
  '/api/admin/users',
  requireAuth,
  requireRole(['administrator']),
  async (_req, res) => {
    const users = await listAllUsersForAdmin();
    res.json({ users });
  }
);

app.patch(
  '/api/admin/users/:id/role',
  requireAuth,
  requireRole(['administrator']),
  async (req: AuthRequest, res) => {
    const targetId = Number(req.params.id);
    const { role } = req.body as { role?: UserRole };
    const validRoles: UserRole[] = ['regular_user', 'emergency_operator', 'support_organization', 'administrator'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    const updated = await updateUserRole(targetId, role);
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    await writeAuditLog({
      actorUserId: req.appUser!.id,
      actorEmail: req.appUser!.email,
      actorRole: req.appUser!.role,
      action: 'USER_ROLE_CHANGED',
      resourceType: 'user',
      resourceId: String(targetId),
      details: { newRole: role },
    });
    res.json({ user: updated });
  }
);

// ========================
// HTTP SERVER + VITE / STATIC + WEBSOCKETS
// ========================
async function startServer() {
  const httpServer = http.createServer(app);
  const wssRealtime = new WebSocketServer({ noServer: true });
  const wssLive = new WebSocketServer({ noServer: true });

  wssRealtime.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || '';
    let resolvedUser: { id: number; role: UserRole } | null = null;

    if (token.startsWith('ll_')) {
      const decoded = verifyAppToken(token);
      if (decoded) {
        const u = await getUserById(decoded.userId);
        if (u) resolvedUser = { id: u.id, role: u.role };
      }
    } else if (token) {
      try {
        const decodedFirebase = await adminAuth.verifyIdToken(token);
        const u = await getOrCreateUserByFirebase(
          decodedFirebase.uid,
          decodedFirebase.email || `${decodedFirebase.uid}@firebase.user`,
          decodedFirebase.name || '',
          Boolean(decodedFirebase.email_verified)
        );
        resolvedUser = { id: u.id, role: u.role };
      } catch {
        resolvedUser = null;
      }
    }

    if (!resolvedUser) {
      ws.close(1008, 'Authentication required');
      return;
    }

    const clientEntry: RealtimeClient = {
      ws,
      userId: resolvedUser.id,
      role: resolvedUser.role,
    };
    realtimeClients.add(clientEntry);
    ws.send(JSON.stringify({ type: 'realtime:connected', role: resolvedUser.role }));

    ws.on('close', () => {
      realtimeClients.delete(clientEntry);
    });
  });

  wssLive.on('connection', async (clientWs) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      clientWs.send(JSON.stringify({ error: 'Gemini Live API key is not configured on the server.' }));
      clientWs.close();
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
    try {
      session = await ai.live.connect({
        model: 'gemini-3.8-live',
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
      clientWs.send(JSON.stringify({ ready: true }));
    } catch (err) {
      console.error('Failed to connect Gemini Live:', err);
      clientWs.send(JSON.stringify({ error: 'Unable to open Gemini Live voice session.' }));
      clientWs.close();
      return;
    }

    clientWs.on('message', (raw) => {
      if (!session) return;
      try {
        const payload = JSON.parse(raw.toString()) as { audio?: string; text?: string };
        if (payload.audio) {
          session.sendRealtimeInput({
            audio: { data: payload.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (payload.text) {
          session.sendRealtimeInput({ text: payload.text });
        }
      } catch (e) {
        console.error('Invalid live message:', e);
      }
    });

    clientWs.on('close', () => {
      try {
        session?.close();
      } catch {
        // ignore close error
      }
    });
  });

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

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });

    // Vite 8's /@vite/client unconditionally opens an HMR WebSocket (defaulting to port 24678
    // in middlewareMode) even when hmr: false and ws: false. Replace its WebSocket transport
    // with a synchronous no-op transport so transport.connect() marks it connected without
    // opening a socket and import.meta.hot.send() (e.g. vite-plugin-pwa) never throws.
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
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

    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`LIFE-LINE AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
