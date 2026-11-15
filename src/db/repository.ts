import crypto from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from './index.ts';
import {
  users,
  userProfiles,
  userPreferences,
  trustedContacts,
  emergencyIncidents,
  incidentUpdates,
  supportOrganizations,
  supportLocations,
  notifications,
  notificationDeliveryLogs,
  aiAssessments,
  aiRecommendations,
  auditLogs,
} from './schema.ts';
import { sqlite, hashPassword, verifyPassword } from './local-store.ts';

export type UserRole =
  | 'regular_user'
  | 'emergency_operator'
  | 'support_organization'
  | 'administrator';

export interface AppUser {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  emailVerified: boolean;
  isDemoAccount: boolean;
  createdAt: string;
}

function isPgUnavailable(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const msg =
      current instanceof Error
        ? `${current.message} ${(current as { code?: string }).code ?? ''}`
        : String(current);
    if (
      msg.includes('ENOENT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('Connection terminated') ||
      msg.includes('connect E') ||
      msg.includes('timeout') ||
      msg.includes('does not exist')
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export async function getOrCreateUserByFirebase(
  uid: string,
  email: string,
  displayName = '',
  emailVerified = false
): Promise<AppUser> {
  try {
    const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (existing.length > 0) {
      const u = existing[0];
      return {
        id: u.id,
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        role: u.role as UserRole,
        emailVerified: u.emailVerified,
        isDemoAccount: u.isDemoAccount,
        createdAt: u.createdAt.toISOString(),
      };
    }

    const inserted = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName: displayName || email.split('@')[0],
        role: 'regular_user',
        emailVerified,
        isDemoAccount: false,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: { email, displayName: displayName || email.split('@')[0], emailVerified, updatedAt: new Date() },
      })
      .returning();

    const u = inserted[0];
    await db
      .insert(userProfiles)
      .values({ userId: u.id, fullName: u.displayName })
      .onConflictDoNothing();
    await db.insert(userPreferences).values({ userId: u.id }).onConflictDoNothing();

    return {
      id: u.id,
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      role: u.role as UserRole,
      emailVerified: u.emailVerified,
      isDemoAccount: u.isDemoAccount,
      createdAt: u.createdAt.toISOString(),
    };
  } catch (err) {
    if (!isPgUnavailable(err)) {
      console.error('Database error in getOrCreateUserByFirebase:', err);
      throw new Error('Unable to load user account.', { cause: err });
    }
    const row = sqlite.prepare('SELECT * FROM users WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
    if (row) {
      return mapSqliteUser(row);
    }
    const byEmail = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
    if (byEmail) {
      sqlite
        .prepare("UPDATE users SET uid = ?, display_name = COALESCE(NULLIF(?, ''), display_name), email_verified = ?, updated_at = datetime('now') WHERE id = ?")
        .run(uid, displayName, emailVerified ? 1 : 0, Number(byEmail.id));
      const updated = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(Number(byEmail.id)) as Record<string, unknown>;
      return mapSqliteUser(updated);
    }
    const res = sqlite
      .prepare('INSERT INTO users (uid, email, display_name, role, email_verified, is_demo_account) VALUES (?, ?, ?, ?, ?, 0)')
      .run(uid, email, displayName || email.split('@')[0], 'regular_user', emailVerified ? 1 : 0);
    const newId = Number(res.lastInsertRowid);
    sqlite.prepare('INSERT OR IGNORE INTO user_profiles (user_id, full_name) VALUES (?, ?)').run(newId, displayName || email.split('@')[0]);
    sqlite.prepare('INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)').run(newId);
    const created = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(newId) as Record<string, unknown>;
    return mapSqliteUser(created);
  }
}

function mapSqliteUser(row: Record<string, unknown>): AppUser {
  return {
    id: Number(row.id),
    uid: String(row.uid),
    email: String(row.email),
    displayName: String(row.display_name || ''),
    role: (row.role as UserRole) || 'regular_user',
    emailVerified: Boolean(row.email_verified),
    isDemoAccount: Boolean(row.is_demo_account),
    createdAt: String(row.created_at),
  };
}

export async function registerEmailUser(input: {
  email: string;
  password: string;
  displayName: string;
  role: 'regular_user' | 'emergency_operator' | 'support_organization';
}): Promise<{ user: AppUser; verificationCode: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  if (existing) {
    throw new Error('An account with this email already exists.');
  }
  const uid = `local_${crypto.randomUUID()}`;
  const passwordHash = hashPassword(input.password);
  const verificationCode = String(crypto.randomInt(100000, 999999));

  const res = sqlite
    .prepare(
      'INSERT INTO users (uid, email, display_name, role, password_hash, email_verified, verification_code, is_demo_account) VALUES (?, ?, ?, ?, ?, 0, ?, 0)'
    )
    .run(uid, email, input.displayName.trim(), input.role, passwordHash, verificationCode);

  const userId = Number(res.lastInsertRowid);
  sqlite.prepare('INSERT INTO user_profiles (user_id, full_name) VALUES (?, ?)').run(userId, input.displayName.trim());
  sqlite.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(userId);

  const created = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  return { user: mapSqliteUser(created), verificationCode };
}

export async function loginEmailUser(email: string, password: string): Promise<AppUser> {
  const row = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as
    | Record<string, unknown>
    | undefined;
  if (!row || !row.password_hash || !verifyPassword(password, String(row.password_hash))) {
    throw new Error('Invalid email or password.');
  }
  return mapSqliteUser(row);
}

export async function verifyUserEmailCode(userId: number, code: string): Promise<AppUser> {
  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Account not found.');
  if (String(row.verification_code) !== code.trim()) {
    throw new Error('Invalid verification code.');
  }
  sqlite.prepare("UPDATE users SET email_verified = 1, verification_code = '', updated_at = datetime('now') WHERE id = ?").run(userId);
  const updated = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  return mapSqliteUser(updated);
}

export async function initiatePasswordReset(email: string): Promise<{ resetCode: string } | null> {
  const row = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: number } | undefined;
  if (!row) return null;
  const resetCode = String(crypto.randomInt(100000, 999999));
  sqlite.prepare("UPDATE users SET reset_code = ?, updated_at = datetime('now') WHERE id = ?").run(resetCode, row.id);
  return { resetCode };
}

export async function completePasswordReset(email: string, code: string, newPassword: string): Promise<boolean> {
  const row = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as
    | Record<string, unknown>
    | undefined;
  if (!row || !row.reset_code || String(row.reset_code) !== code.trim()) {
    return false;
  }
  const hash = hashPassword(newPassword);
  sqlite
    .prepare("UPDATE users SET password_hash = ?, reset_code = '', updated_at = datetime('now') WHERE id = ?")
    .run(hash, Number(row.id));
  return true;
}

export async function getUserById(userId: number): Promise<AppUser | null> {
  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  return row ? mapSqliteUser(row) : null;
}

export async function getDemoAccounts(): Promise<AppUser[]> {
  const rows = sqlite.prepare('SELECT * FROM users WHERE is_demo_account = 1 ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map(mapSqliteUser);
}

export async function listOperatorUserIds(): Promise<number[]> {
  const rows = sqlite
    .prepare("SELECT id FROM users WHERE role IN ('emergency_operator', 'support_organization', 'administrator')")
    .all() as { id: number }[];
  return rows.map((r) => Number(r.id));
}

export async function listAllUsersForAdmin(): Promise<AppUser[]> {
  const rows = sqlite.prepare('SELECT * FROM users ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map(mapSqliteUser);
}

export async function updateUserRole(targetUserId: number, role: UserRole): Promise<AppUser | null> {
  sqlite.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, targetUserId);
  return getUserById(targetUserId);
}

export async function getUserProfile(userId: number) {
  try {
    const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    if (rows[0]) return rows[0];
  } catch (err) {
    if (!isPgUnavailable(err)) throw new Error('Failed to load profile.', { cause: err });
  }
  const profile = sqlite.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
  const prefs = sqlite.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
  return {
    profile: profile
      ? {
          id: Number(profile.id),
          userId: Number(profile.user_id),
          fullName: String(profile.full_name || ''),
          phone: String(profile.phone || ''),
          avatarUrl: String(profile.avatar_url || ''),
          emergencyNotes: String(profile.emergency_notes || ''),
          medicalNotes: String(profile.medical_notes || ''),
          bloodType: String(profile.blood_type || ''),
          preferredLanguage: String(profile.preferred_language || 'en'),
          safetyStatus: String(profile.safety_status || 'Safe'),
          lastKnownLat: profile.last_known_lat != null ? Number(profile.last_known_lat) : null,
          lastKnownLng: profile.last_known_lng != null ? Number(profile.last_known_lng) : null,
          lastLocationLabel: String(profile.last_location_label || ''),
          locationSharingConsent: Boolean(profile.location_sharing_consent),
        }
      : null,
    preferences: prefs
      ? {
          theme: String(prefs.theme || 'dark'),
          enableEmailAlerts: Boolean(prefs.enable_email_alerts),
          enableSmsAlerts: Boolean(prefs.enable_sms_alerts),
          enableInAppAlerts: Boolean(prefs.enable_in_app_alerts),
          locationConsentMode: String(prefs.location_consent_mode || 'sos_only'),
          dataRetentionDays: Number(prefs.data_retention_days || 90),
          demoModeEnabled: Boolean(prefs.demo_mode_enabled),
        }
      : null,
  };
}

export async function updateUserProfile(
  userId: number,
  data: {
    fullName?: string;
    phone?: string;
    emergencyNotes?: string;
    medicalNotes?: string;
    bloodType?: string;
    preferredLanguage?: string;
    safetyStatus?: string;
    lastKnownLat?: number | null;
    lastKnownLng?: number | null;
    lastLocationLabel?: string;
    locationSharingConsent?: boolean;
    theme?: 'dark' | 'light';
    enableEmailAlerts?: boolean;
    enableSmsAlerts?: boolean;
    enableInAppAlerts?: boolean;
    locationConsentMode?: string;
    dataRetentionDays?: number;
  }
) {
  sqlite
    .prepare(
      `UPDATE user_profiles SET
        full_name = COALESCE(?, full_name),
        phone = COALESCE(?, phone),
        emergency_notes = COALESCE(?, emergency_notes),
        medical_notes = COALESCE(?, medical_notes),
        blood_type = COALESCE(?, blood_type),
        preferred_language = COALESCE(?, preferred_language),
        safety_status = COALESCE(?, safety_status),
        last_known_lat = COALESCE(?, last_known_lat),
        last_known_lng = COALESCE(?, last_known_lng),
        last_location_label = COALESCE(?, last_location_label),
        location_sharing_consent = COALESCE(?, location_sharing_consent),
        updated_at = datetime('now')
      WHERE user_id = ?`
    )
    .run(
      data.fullName ?? null,
      data.phone ?? null,
      data.emergencyNotes ?? null,
      data.medicalNotes ?? null,
      data.bloodType ?? null,
      data.preferredLanguage ?? null,
      data.safetyStatus ?? null,
      data.lastKnownLat ?? null,
      data.lastKnownLng ?? null,
      data.lastLocationLabel ?? null,
      data.locationSharingConsent !== undefined ? (data.locationSharingConsent ? 1 : 0) : null,
      userId
    );

  sqlite
    .prepare(
      `UPDATE user_preferences SET
        theme = COALESCE(?, theme),
        enable_email_alerts = COALESCE(?, enable_email_alerts),
        enable_sms_alerts = COALESCE(?, enable_sms_alerts),
        enable_in_app_alerts = COALESCE(?, enable_in_app_alerts),
        location_consent_mode = COALESCE(?, location_consent_mode),
        data_retention_days = COALESCE(?, data_retention_days),
        updated_at = datetime('now')
      WHERE user_id = ?`
    )
    .run(
      data.theme ?? null,
      data.enableEmailAlerts !== undefined ? (data.enableEmailAlerts ? 1 : 0) : null,
      data.enableSmsAlerts !== undefined ? (data.enableSmsAlerts ? 1 : 0) : null,
      data.enableInAppAlerts !== undefined ? (data.enableInAppAlerts ? 1 : 0) : null,
      data.locationConsentMode ?? null,
      data.dataRetentionDays ?? null,
      userId
    );

  if (data.fullName) {
    sqlite.prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(data.fullName, userId);
  }
  return getUserProfile(userId);
}

export async function deleteUserAccount(userId: number) {
  sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Trusted Contacts
export async function listTrustedContacts(userId: number) {
  try {
    return await db
      .select()
      .from(trustedContacts)
      .where(eq(trustedContacts.userId, userId))
      .orderBy(trustedContacts.priorityOrder);
  } catch (err) {
    if (!isPgUnavailable(err)) throw new Error('Failed to load trusted contacts.', { cause: err });
  }
  const rows = sqlite
    .prepare('SELECT * FROM trusted_contacts WHERE user_id = ? ORDER BY priority_order ASC, id ASC')
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    userId: Number(r.user_id),
    name: String(r.name),
    relationship: String(r.relationship),
    email: String(r.email),
    phone: String(r.phone),
    notifyEmail: Boolean(r.notify_email),
    notifySms: Boolean(r.notify_sms),
    notifyWhatsapp: Boolean(r.notify_whatsapp),
    priorityOrder: Number(r.priority_order),
    isVerified: Boolean(r.is_verified),
    source: String(r.source),
    createdAt: String(r.created_at),
  }));
}

export async function addTrustedContact(
  userId: number,
  input: {
    name: string;
    relationship?: string;
    email?: string;
    phone?: string;
    notifyEmail?: boolean;
    notifySms?: boolean;
    notifyWhatsapp?: boolean;
    priorityOrder?: number;
    source?: string;
  }
) {
  const res = sqlite
    .prepare(
      `INSERT INTO trusted_contacts (user_id, name, relationship, email, phone, notify_email, notify_sms, notify_whatsapp, priority_order, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.name.trim(),
      input.relationship?.trim() || 'Trusted Contact',
      input.email?.trim() || '',
      input.phone?.trim() || '',
      input.notifyEmail !== false ? 1 : 0,
      input.notifySms ? 1 : 0,
      input.notifyWhatsapp ? 1 : 0,
      input.priorityOrder ?? 1,
      input.source || 'manual'
    );
  const created = sqlite.prepare('SELECT * FROM trusted_contacts WHERE id = ?').get(Number(res.lastInsertRowid)) as Record<string, unknown>;
  return {
    id: Number(created.id),
    userId: Number(created.user_id),
    name: String(created.name),
    relationship: String(created.relationship),
    email: String(created.email),
    phone: String(created.phone),
    notifyEmail: Boolean(created.notify_email),
    notifySms: Boolean(created.notify_sms),
    notifyWhatsapp: Boolean(created.notify_whatsapp),
    priorityOrder: Number(created.priority_order),
    isVerified: Boolean(created.is_verified),
    source: String(created.source),
  };
}

export async function updateTrustedContact(
  userId: number,
  contactId: number,
  input: {
    name?: string;
    relationship?: string;
    email?: string;
    phone?: string;
    notifyEmail?: boolean;
    notifySms?: boolean;
    notifyWhatsapp?: boolean;
  }
) {
  const existing = sqlite
    .prepare('SELECT * FROM trusted_contacts WHERE id = ? AND user_id = ?')
    .get(contactId, userId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Trusted contact not found.');

  sqlite
    .prepare(
      `UPDATE trusted_contacts SET
        name = COALESCE(?, name),
        relationship = COALESCE(?, relationship),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        notify_email = COALESCE(?, notify_email),
        notify_sms = COALESCE(?, notify_sms),
        notify_whatsapp = COALESCE(?, notify_whatsapp),
        updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
    .run(
      input.name ?? null,
      input.relationship ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.notifyEmail !== undefined ? (input.notifyEmail ? 1 : 0) : null,
      input.notifySms !== undefined ? (input.notifySms ? 1 : 0) : null,
      input.notifyWhatsapp !== undefined ? (input.notifyWhatsapp ? 1 : 0) : null,
      contactId,
      userId
    );
  return listTrustedContacts(userId);
}

export async function deleteTrustedContact(userId: number, contactId: number) {
  sqlite.prepare('DELETE FROM trusted_contacts WHERE id = ? AND user_id = ?').run(contactId, userId);
}

// Emergency Incidents
export async function createIncident(input: {
  userId: number;
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  latitude?: number | null;
  longitude?: number | null;
  locationLabel?: string;
  locationAccuracyMeters?: number | null;
  isSimulated?: boolean;
}) {
  const res = sqlite
    .prepare(
      `INSERT INTO emergency_incidents (user_id, title, description, category, status, priority, latitude, longitude, location_label, location_accuracy_meters, is_simulated)
       VALUES (?, ?, ?, ?, 'SOS Activated', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.userId,
      input.title,
      input.description || '',
      input.category || 'Personal Safety',
      input.priority || 'CRITICAL',
      input.latitude ?? null,
      input.longitude ?? null,
      input.locationLabel || 'Location pending',
      input.locationAccuracyMeters ?? null,
      input.isSimulated ? 1 : 0
    );
  const incidentId = Number(res.lastInsertRowid);
  sqlite
    .prepare(
      `INSERT INTO incident_updates (incident_id, author_user_id, author_role, previous_status, new_status, note)
       VALUES (?, ?, 'regular_user', '', 'SOS Activated', ?)`
    )
    .run(incidentId, input.userId, input.isSimulated ? 'Simulated SOS triggered in demo sandbox.' : 'SOS Emergency Activated by user.');

  return getIncidentById(incidentId);
}

export async function getIncidentById(incidentId: number) {
  const r = sqlite
    .prepare(
      `SELECT i.*, u.email as reporter_email, u.display_name as reporter_name,
              op.display_name as operator_name, op.email as operator_email
       FROM emergency_incidents i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN users op ON op.id = i.acknowledged_by_user_id
       WHERE i.id = ?`
    )
    .get(incidentId) as Record<string, unknown> | undefined;
  if (!r) return null;

  const updates = sqlite
    .prepare(
      `SELECT iu.*, u.display_name as author_name
       FROM incident_updates iu
       LEFT JOIN users u ON u.id = iu.author_user_id
       WHERE iu.incident_id = ?
       ORDER BY iu.created_at ASC, iu.id ASC`
    )
    .all(incidentId) as Record<string, unknown>[];

  const deliveryLogs = sqlite
    .prepare('SELECT * FROM notification_delivery_logs WHERE incident_id = ? ORDER BY id DESC')
    .all(incidentId) as Record<string, unknown>[];

  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    reporterName: String(r.reporter_name || r.reporter_email),
    reporterEmail: String(r.reporter_email),
    title: String(r.title),
    description: String(r.description || ''),
    category: String(r.category),
    status: String(r.status),
    priority: String(r.priority),
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
    locationLabel: String(r.location_label || ''),
    locationAccuracyMeters: r.location_accuracy_meters != null ? Number(r.location_accuracy_meters) : null,
    isSimulated: Boolean(r.is_simulated),
    acknowledgedByUserId: r.acknowledged_by_user_id != null ? Number(r.acknowledged_by_user_id) : null,
    operatorName: r.operator_name ? String(r.operator_name) : null,
    acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : null,
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    updates: updates.map((u) => ({
      id: Number(u.id),
      authorRole: String(u.author_role),
      authorName: u.author_name ? String(u.author_name) : 'System',
      previousStatus: String(u.previous_status),
      newStatus: String(u.new_status),
      note: String(u.note),
      createdAt: String(u.created_at),
    })),
    deliveryLogs: deliveryLogs.map((l) => ({
      id: Number(l.id),
      recipient: String(l.recipient),
      channel: String(l.channel),
      provider: String(l.provider),
      status: String(l.status),
      attemptCount: Number(l.attempt_count),
      errorMessage: String(l.error_message || ''),
      sentAt: l.sent_at ? String(l.sent_at) : null,
      createdAt: String(l.created_at),
    })),
  };
}

export async function listIncidentsForUser(userId: number) {
  try {
    const check = await db.select().from(emergencyIncidents).where(eq(emergencyIncidents.userId, userId)).orderBy(desc(emergencyIncidents.createdAt)).limit(1);
    void check;
  } catch (err) {
    if (!isPgUnavailable(err)) throw new Error('Failed to load incidents.', { cause: err });
  }
  const rows = sqlite
    .prepare('SELECT id FROM emergency_incidents WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50')
    .all(userId) as { id: number }[];
  const results = [];
  for (const row of rows) {
    const full = await getIncidentById(row.id);
    if (full) results.push(full);
  }
  return results;
}

export async function listAllIncidentsForOperator() {
  const rows = sqlite
    .prepare('SELECT id FROM emergency_incidents ORDER BY created_at DESC, id DESC LIMIT 100')
    .all() as { id: number }[];
  const results = [];
  for (const row of rows) {
    const full = await getIncidentById(row.id);
    if (full) results.push(full);
  }
  return results;
}

export async function updateIncidentStatus(input: {
  incidentId: number;
  actorUserId: number;
  actorRole: string;
  newStatus: string;
  note?: string;
  priority?: string;
  isInternal?: boolean;
}) {
  const existing = sqlite
    .prepare('SELECT * FROM emergency_incidents WHERE id = ?')
    .get(input.incidentId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Incident not found.');

  const prevStatus = String(existing.status);
  const ackTimestamp: string | null =
    input.newStatus === 'Acknowledged' && !existing.acknowledged_at
      ? new Date().toISOString()
      : existing.acknowledged_at
        ? String(existing.acknowledged_at)
        : null;
  const resolvedTimestamp: string | null =
    input.newStatus === 'Resolved'
      ? new Date().toISOString()
      : existing.resolved_at
        ? String(existing.resolved_at)
        : null;
  const ackUser: number | null =
    input.newStatus === 'Acknowledged' || input.newStatus === 'Assistance in Progress'
      ? existing.acknowledged_by_user_id != null
        ? Number(existing.acknowledged_by_user_id)
        : input.actorUserId
      : existing.acknowledged_by_user_id != null
        ? Number(existing.acknowledged_by_user_id)
        : null;

  sqlite
    .prepare(
      `UPDATE emergency_incidents SET
        status = ?,
        priority = COALESCE(?, priority),
        acknowledged_by_user_id = ?,
        acknowledged_at = ?,
        resolved_at = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(input.newStatus, input.priority ?? null, ackUser, ackTimestamp, resolvedTimestamp, input.incidentId);

  sqlite
    .prepare(
      `INSERT INTO incident_updates (incident_id, author_user_id, author_role, previous_status, new_status, note, is_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.incidentId,
      input.actorUserId,
      input.actorRole,
      prevStatus,
      input.newStatus,
      input.note || `Status updated to ${input.newStatus}`,
      input.isInternal ? 1 : 0
    );

  if (input.newStatus === 'Acknowledged' && ['emergency_operator', 'administrator', 'support_organization'].includes(input.actorRole)) {
    sqlite
      .prepare(
        `INSERT INTO incident_assignments (incident_id, operator_user_id, assigned_by_user_id, status)
         VALUES (?, ?, ?, 'active')`
      )
      .run(input.incidentId, input.actorUserId, input.actorUserId);
  }

  return getIncidentById(input.incidentId);
}

// Support Directory
export async function listSupportDirectory(category?: string, query?: string) {
  try {
    const check = await db.select().from(supportOrganizations).limit(1);
    void check;
    const locCheck = await db.select().from(supportLocations).limit(1);
    void locCheck;
  } catch (err) {
    if (!isPgUnavailable(err)) throw new Error('Failed to load support directory.', { cause: err });
  }
  const rows = sqlite
    .prepare(
      `SELECT o.*, l.address, l.city, l.region, l.latitude, l.longitude, l.operating_hours, l.is_24_hours, l.availability_note, l.last_updated_at
       FROM support_organizations o
       JOIN support_locations l ON l.organization_id = o.id
       ORDER BY o.id ASC`
    )
    .all() as Record<string, unknown>[];

  return rows
    .filter((r) => {
      if (category && category !== 'All' && String(r.category) !== category) return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          String(r.name).toLowerCase().includes(q) ||
          String(r.address).toLowerCase().includes(q) ||
          String(r.category).toLowerCase().includes(q)
        );
      }
      return true;
    })
    .map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      category: String(r.category),
      phone: String(r.phone),
      website: String(r.website),
      email: String(r.email),
      verificationStatus: String(r.verification_status),
      source: String(r.source),
      isSampleData: Boolean(r.is_sample_data),
      address: String(r.address),
      city: String(r.city),
      region: String(r.region),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      operatingHours: String(r.operating_hours),
      is24Hours: Boolean(r.is_24_hours),
      availabilityNote: String(r.availability_note),
      lastUpdatedAt: String(r.last_updated_at),
    }));
}

// Notifications & Delivery Logs
export async function createNotification(input: {
  userId: number;
  incidentId?: number | null;
  channel?: string;
  title: string;
  message: string;
  category?: string;
  isSimulated?: boolean;
}) {
  const res = sqlite
    .prepare(
      `INSERT INTO notifications (user_id, incident_id, channel, title, message, category, is_simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.userId,
      input.incidentId ?? null,
      input.channel || 'in_app',
      input.title,
      input.message,
      input.category || 'safety',
      input.isSimulated ? 1 : 0
    );
  return Number(res.lastInsertRowid);
}

export async function listNotificationsForUser(userId: number) {
  try {
    const check = await db.select().from(notifications).where(eq(notifications.userId, userId)).limit(1);
    void check;
  } catch (err) {
    if (!isPgUnavailable(err)) throw new Error('Failed to load notifications.', { cause: err });
  }
  const rows = sqlite
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 40')
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    incidentId: r.incident_id != null ? Number(r.incident_id) : null,
    channel: String(r.channel),
    title: String(r.title),
    message: String(r.message),
    category: String(r.category),
    isRead: Boolean(r.is_read),
    isSimulated: Boolean(r.is_simulated),
    createdAt: String(r.created_at),
  }));
}

export async function markNotificationRead(userId: number, notificationId: number) {
  sqlite.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notificationId, userId);
}

export async function logDeliveryAttempt(input: {
  notificationId?: number | null;
  incidentId?: number | null;
  recipient: string;
  channel: string;
  provider: string;
  status: string;
  attemptCount: number;
  errorMessage?: string;
  externalMessageId?: string;
}) {
  try {
    void notificationDeliveryLogs;
  } catch {
    // ignore
  }
  sqlite
    .prepare(
      `INSERT INTO notification_delivery_logs (notification_id, incident_id, recipient, channel, provider, status, attempt_count, error_message, external_message_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.notificationId ?? null,
      input.incidentId ?? null,
      input.recipient,
      input.channel,
      input.provider,
      input.status,
      input.attemptCount,
      input.errorMessage || '',
      input.externalMessageId || '',
      input.status === 'sent' || input.status === 'simulated' ? new Date().toISOString() : null
    );
}

// AI Assessments & Recommendations
export async function saveAiAssessment(input: {
  incidentId?: number | null;
  userId: number;
  agentName: string;
  modelUsed: string;
  inputSummary: string;
  urgencyLevel: string;
  classification: string;
  assignedPriority: string;
  confidenceScore: number;
  rationale: string;
  missingInfoQuestions: string[];
  uncertaintyNotes: string;
  escalateToHuman: boolean;
  rawStructuredOutput: Record<string, unknown>;
  recommendations: { title: string; text: string; category: string; sourceCitation: string; actionRequiredAuth?: boolean }[];
}) {
  try {
    void aiAssessments;
    void aiRecommendations;
  } catch {
    // ignore
  }
  const res = sqlite
    .prepare(
      `INSERT INTO ai_assessments (incident_id, user_id, agent_name, model_used, input_summary, urgency_level, classification, assigned_priority, confidence_score, rationale, missing_info_questions, uncertainty_notes, escalate_to_human, raw_structured_output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.incidentId ?? null,
      input.userId,
      input.agentName,
      input.modelUsed,
      input.inputSummary.slice(0, 500),
      input.urgencyLevel,
      input.classification,
      input.assignedPriority,
      input.confidenceScore,
      input.rationale,
      JSON.stringify(input.missingInfoQuestions),
      input.uncertaintyNotes,
      input.escalateToHuman ? 1 : 0,
      JSON.stringify(input.rawStructuredOutput)
    );
  const assessmentId = Number(res.lastInsertRowid);

  const insertRec = sqlite.prepare(
    `INSERT INTO ai_recommendations (assessment_id, user_id, incident_id, agent_name, title, recommendation_text, category, confidence, source_citation, action_required_auth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const rec of input.recommendations) {
    insertRec.run(
      assessmentId,
      input.userId,
      input.incidentId ?? null,
      input.agentName,
      rec.title,
      rec.text,
      rec.category,
      input.confidenceScore,
      rec.sourceCitation,
      rec.actionRequiredAuth ? 1 : 0
    );
  }
  return assessmentId;
}

export async function listAiRecommendationsForUser(userId: number) {
  const rows = sqlite
    .prepare('SELECT * FROM ai_recommendations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 25')
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    agentName: String(r.agent_name),
    title: String(r.title),
    recommendationText: String(r.recommendation_text),
    category: String(r.category),
    confidence: Number(r.confidence),
    sourceCitation: String(r.source_citation),
    actionRequiredAuth: Boolean(r.action_required_auth),
    isCompleted: Boolean(r.is_completed),
    createdAt: String(r.created_at),
  }));
}

// Audit Logging
export async function writeAuditLog(input: {
  actorUserId?: number | null;
  actorEmail?: string;
  actorRole?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}) {
  try {
    void auditLogs;
  } catch {
    // ignore
  }
  sqlite
    .prepare(
      `INSERT INTO audit_logs (actor_user_id, actor_email, actor_role, action, resource_type, resource_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.actorUserId ?? null,
      input.actorEmail || 'system',
      input.actorRole || 'system',
      input.action,
      input.resourceType,
      input.resourceId || '',
      JSON.stringify(input.details || {}),
      input.ipAddress || ''
    );
}

export async function listAuditLogs(limit = 50) {
  const rows = sqlite
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    actorEmail: String(r.actor_email),
    actorRole: String(r.actor_role),
    action: String(r.action),
    resourceType: String(r.resource_type),
    resourceId: String(r.resource_id),
    details: JSON.parse(String(r.details || '{}')),
    createdAt: String(r.created_at),
  }));
}

// Analytics (explicitly separates real live incidents from simulated/demo incidents)
export async function getOperationalAnalytics() {
  const allIncidents = sqlite
    .prepare('SELECT status, category, priority, is_simulated, acknowledged_at, created_at FROM emergency_incidents')
    .all() as Record<string, unknown>[];

  const liveIncidents = allIncidents.filter((i) => !i.is_simulated);
  const simulatedIncidents = allIncidents.filter((i) => Boolean(i.is_simulated));

  const summarize = (list: Record<string, unknown>[]) => {
    const activeStatuses = new Set(['SOS Activated', 'Alert Sent', 'Acknowledged', 'Assistance in Progress']);
    const active = list.filter((i) => activeStatuses.has(String(i.status))).length;
    const resolved = list.filter((i) => String(i.status) === 'Resolved').length;
    const ackTimesSec: number[] = [];
    for (const item of list) {
      if (item.acknowledged_at && item.created_at) {
        const diff = (new Date(String(item.acknowledged_at)).getTime() - new Date(String(item.created_at)).getTime()) / 1000;
        if (!Number.isNaN(diff) && diff >= 0) ackTimesSec.push(diff);
      }
    }
    const avgAckSeconds = ackTimesSec.length
      ? Math.round(ackTimesSec.reduce((a, b) => a + b, 0) / ackTimesSec.length)
      : null;

    const categoryMap: Record<string, number> = {};
    for (const item of list) {
      const cat = String(item.category || 'Other');
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    }

    return {
      total: list.length,
      active,
      resolved,
      avgAckSeconds,
      byCategory: Object.entries(categoryMap).map(([name, count]) => ({ name, count })),
    };
  };

  const orgRows = sqlite
    .prepare('SELECT category, COUNT(*) as count FROM support_organizations GROUP BY category')
    .all() as { category: string; count: number }[];

  return {
    liveStats: summarize(liveIncidents),
    demoStats: summarize(simulatedIncidents),
    resourceDistribution: orgRows.map((r) => ({ category: r.category, count: Number(r.count) })),
  };
}
