import crypto from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, hasPostgresConfig, pool, queryWithRetry } from './index.ts';
import {
  aiAssessments,
  aiRecommendations,
  auditLogs,
  emergencyIncidents,
  incidentAssignments,
  incidentUpdates,
  notificationDeliveryLogs,
  notifications,
  safetyJourneys,
  safetyReports,
  supportLocations,
  supportOrganizations,
  trustedContacts,
  userPreferences,
  userProfiles,
  users,
} from './schema.ts';
import {
  hashOneTimeCode,
  hashPasswordAsync,
  runSqliteMigrations,
  runSqliteTransaction,
  seedSqliteInitialData,
  sqlite,
  verifyOneTimeCode,
  verifyPasswordAsync,
} from './local-store.ts';
import { cacheQueue } from '../services/cacheQueue.ts';
import { metrics } from '../services/metrics.ts';

export type UserRole =
  | 'regular_user'
  | 'emergency_operator'
  | 'support_organization'
  | 'administrator';

export type DatabaseDialect = 'postgres' | 'sqlite';

export type DeliveryState = 'queued' | 'submitted' | 'delivered' | 'failed';

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

export interface DatabaseHealthReport {
  ok: boolean;
  dialect: DatabaseDialect;
  migrationVersion: string;
  latencyMs: number;
  tablesVerified: number;
  error?: string;
}

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const REQUIRED_TABLES = [
  'users',
  'user_profiles',
  'user_preferences',
  'trusted_contacts',
  'emergency_incidents',
  'incident_updates',
  'notifications',
  'notification_delivery_logs',
  'audit_logs',
  'support_organizations',
  'support_locations',
  'safety_journeys',
  'safety_reports',
];

let activeDialect: DatabaseDialect | null = null;
let initPromise: Promise<DatabaseDialect> | null = null;

async function runPostgresMigrations(): Promise<string> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRes = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r: { version: string }) => r.version));

  if (!applied.has('v1_initial_schema')) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        uid TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'regular_user',
        password_hash TEXT NOT NULL DEFAULT '',
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        verification_code_hash TEXT NOT NULL DEFAULT '',
        verification_code_expires_at TIMESTAMPTZ,
        verification_attempts INTEGER NOT NULL DEFAULT 0,
        reset_code_hash TEXT NOT NULL DEFAULT '',
        reset_code_expires_at TIMESTAMPTZ,
        reset_attempts INTEGER NOT NULL DEFAULT 0,
        is_demo_account BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

      CREATE TABLE IF NOT EXISTS user_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        emergency_notes TEXT NOT NULL DEFAULT '',
        medical_notes TEXT NOT NULL DEFAULT '',
        blood_type TEXT NOT NULL DEFAULT '',
        preferred_language TEXT NOT NULL DEFAULT 'en',
        safety_status TEXT NOT NULL DEFAULT 'Safe',
        last_known_lat DOUBLE PRECISION,
        last_known_lng DOUBLE PRECISION,
        last_location_label TEXT NOT NULL DEFAULT '',
        location_sharing_consent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trusted_contacts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'Trusted Contact',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notify_email BOOLEAN NOT NULL DEFAULT TRUE,
        notify_sms BOOLEAN NOT NULL DEFAULT FALSE,
        notify_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
        priority_order INTEGER NOT NULL DEFAULT 1,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS trusted_contacts_user_idx ON trusted_contacts(user_id);

      CREATE TABLE IF NOT EXISTS emergency_incidents (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT,
        client_queued_at TIMESTAMPTZ,
        delivery_status TEXT NOT NULL DEFAULT 'submitted',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Personal Safety',
        status TEXT NOT NULL DEFAULT 'SOS Activated',
        priority TEXT NOT NULL DEFAULT 'HIGH',
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        location_label TEXT NOT NULL DEFAULT 'Location pending',
        location_accuracy_meters INTEGER,
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        acknowledged_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        acknowledged_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS incidents_user_idx ON emergency_incidents(user_id);
      CREATE INDEX IF NOT EXISTS incidents_status_idx ON emergency_incidents(status);
      CREATE INDEX IF NOT EXISTS incidents_created_idx ON emergency_incidents(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_user_idempotency_idx ON emergency_incidents(user_id, idempotency_key);

      CREATE TABLE IF NOT EXISTS incident_updates (
        id SERIAL PRIMARY KEY,
        incident_id INTEGER NOT NULL REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_role TEXT NOT NULL DEFAULT 'system',
        previous_status TEXT NOT NULL DEFAULT '',
        new_status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        is_internal BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS incident_updates_incident_idx ON incident_updates(incident_id);

      CREATE TABLE IF NOT EXISTS incident_assignments (
        id SERIAL PRIMARY KEY,
        incident_id INTEGER NOT NULL REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        operator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active',
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS support_organizations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        website TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        verification_status TEXT NOT NULL DEFAULT 'Sample Directory',
        source TEXT NOT NULL DEFAULT 'LIFE-LINE Verified Demo Registry',
        is_sample_data BOOLEAN NOT NULL DEFAULT TRUE,
        last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS support_locations (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES support_organizations(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        operating_hours TEXT NOT NULL DEFAULT '24/7',
        is_24_hours BOOLEAN NOT NULL DEFAULT TRUE,
        availability_note TEXT NOT NULL DEFAULT 'Confirm availability by phone',
        google_place_id TEXT NOT NULL DEFAULT '',
        last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE SET NULL,
        channel TEXT NOT NULL DEFAULT 'in_app',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'safety',
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);

      CREATE TABLE IF NOT EXISTS notification_delivery_logs (
        id SERIAL PRIMARY KEY,
        notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        channel TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'internal',
        status TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        error_message TEXT NOT NULL DEFAULT '',
        external_message_id TEXT NOT NULL DEFAULT '',
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_assessments (
        id SERIAL PRIMARY KEY,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        model_used TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
        input_summary TEXT NOT NULL,
        urgency_level TEXT NOT NULL DEFAULT 'MEDIUM',
        classification TEXT NOT NULL DEFAULT 'General Safety',
        assigned_priority TEXT NOT NULL DEFAULT 'MEDIUM',
        confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0.75,
        rationale TEXT NOT NULL,
        missing_info_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        uncertainty_notes TEXT NOT NULL DEFAULT '',
        escalate_to_human BOOLEAN NOT NULL DEFAULT FALSE,
        raw_structured_output JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_recommendations (
        id SERIAL PRIMARY KEY,
        assessment_id INTEGER REFERENCES ai_assessments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE SET NULL,
        agent_name TEXT NOT NULL,
        title TEXT NOT NULL,
        recommendation_text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Practical Safety',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
        source_citation TEXT NOT NULL DEFAULT 'LIFE-LINE Safety Protocol',
        action_required_auth BOOLEAN NOT NULL DEFAULT FALSE,
        is_completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_email TEXT NOT NULL DEFAULT 'system',
        actor_role TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '',
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'dark',
        enable_email_alerts BOOLEAN NOT NULL DEFAULT TRUE,
        enable_sms_alerts BOOLEAN NOT NULL DEFAULT FALSE,
        enable_in_app_alerts BOOLEAN NOT NULL DEFAULT TRUE,
        location_consent_mode TEXT NOT NULL DEFAULT 'sos_only',
        data_retention_days INTEGER NOT NULL DEFAULT 90,
        demo_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ('v1_initial_schema') ON CONFLICT DO NOTHING");
  }

  if (!applied.has('v2_auth_code_security_columns')) {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_attempts INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ('v2_auth_code_security_columns') ON CONFLICT DO NOTHING");
  }

  if (!applied.has('v3_sos_idempotency_and_delivery')) {
    await pool.query(`
      ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS client_queued_at TIMESTAMPTZ;
      ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'submitted';
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_user_idempotency_idx ON emergency_incidents(user_id, idempotency_key);
    `);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ('v3_sos_idempotency_and_delivery') ON CONFLICT DO NOTHING");
  }

  if (!applied.has('v4_pulse_journeys_reports_responders')) {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS responder_status TEXT NOT NULL DEFAULT 'Available';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS responder_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      CREATE TABLE IF NOT EXISTS safety_journeys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        origin_label TEXT NOT NULL,
        origin_lat DOUBLE PRECISION NOT NULL,
        origin_lng DOUBLE PRECISION NOT NULL,
        destination_label TEXT NOT NULL,
        destination_lat DOUBLE PRECISION NOT NULL,
        destination_lng DOUBLE PRECISION NOT NULL,
        travel_mode TEXT NOT NULL DEFAULT 'WALK',
        selected_route_summary TEXT NOT NULL DEFAULT '',
        route_risk_level TEXT NOT NULL DEFAULT 'LOW',
        share_token TEXT NOT NULL,
        shared_with_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
        check_in_interval_minutes INTEGER NOT NULL DEFAULT 15,
        expected_arrival_at TIMESTAMPTZ NOT NULL,
        next_check_in_due_at TIMESTAMPTZ NOT NULL,
        last_check_in_at TIMESTAMPTZ,
        arrived_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'Active',
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS safety_journeys_user_idx ON safety_journeys(user_id);
      CREATE INDEX IF NOT EXISTS safety_journeys_status_idx ON safety_journeys(status);

      CREATE TABLE IF NOT EXISTS safety_reports (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'MODERATE',
        description TEXT NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        location_label TEXT NOT NULL,
        is_anonymous BOOLEAN NOT NULL DEFAULT TRUE,
        verification_status TEXT NOT NULL DEFAULT 'User Submitted',
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS safety_reports_created_idx ON safety_reports(created_at);
      CREATE INDEX IF NOT EXISTS safety_reports_coords_idx ON safety_reports(latitude, longitude);
    `);
    await pool.query("INSERT INTO schema_migrations (version) VALUES ('v4_pulse_journeys_reports_responders') ON CONFLICT DO NOTHING");
  }

  if (!applied.has('v5_scalability_indexes')) {
    await queryWithRetry(`
      CREATE INDEX IF NOT EXISTS incidents_user_created_idx ON emergency_incidents(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS incidents_sim_status_created_idx ON emergency_incidents(is_simulated, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS notifications_user_read_created_idx ON notifications(user_id, is_read, created_at DESC);
      CREATE INDEX IF NOT EXISTS safety_reports_sim_created_idx ON safety_reports(is_simulated, created_at DESC);

      CREATE TABLE IF NOT EXISTS system_runtime_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS realtime_events (
        id SERIAL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        target_user_id INTEGER,
        include_operators BOOLEAN NOT NULL DEFAULT FALSE,
        user_payload JSONB NOT NULL,
        operator_payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS realtime_events_target_idx ON realtime_events(target_user_id, id);
    `);
    await queryWithRetry("INSERT INTO schema_migrations (version) VALUES ('v5_scalability_indexes') ON CONFLICT DO NOTHING");
  }

  // Seed directory & demo accounts if PG database is newly provisioned
  const orgCnt = await queryWithRetry<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM support_organizations');
  if (orgCnt.rows[0]?.cnt === 0) {
    const seedOrgs = [
      ['National Domestic Violence Hotline (Sample Reference)', 'Government Helpline', '1-800-799-7233', 'https://www.thehotline.org', 'support@example-hotline.org', 'Public Directory (Sample)', 'Sample Safety Helpline Registry', 'National Toll-Free Helpline · Text START to 88788', 'San Francisco', 'CA', 37.7749, -122.4194, '24/7 Confidential Support', true, 'Sample reference listing — verify local emergency numbers (911/112) in crisis.'],
      ['Zuckerberg SF General Emergency Center (Sample)', 'Hospital', '(628) 206-8000', 'https://zuckerbergsanfranciscogeneral.org', 'emergency-info@example-hospital.org', 'Sample Directory', 'Sample Public Hospital Dataset', '1001 Potrero Ave, San Francisco, CA 94110', 'San Francisco', 'CA', 37.7555, -122.4045, '24/7 Emergency Department', true, 'Use live Google Maps search for real-time hospital status near your exact GPS location.'],
      ['Bay Area Women & Youth Safe Haven (Demo)', 'Womens Support', '(415) 555-0142', 'https://example-safehaven.org', 'intake@example-safehaven.org', 'Demo Partner', 'LIFE-LINE Hackathon Demo Registry', '445 Valencia St, San Francisco, CA 94103', 'San Francisco', 'CA', 37.7656, -122.4218, 'Mon-Sun 08:00 - 22:00 (24/7 Crisis Line)', false, 'Demo support shelter entry for hackathon walkthroughs.'],
      ['Larkin Street Youth Support Hub (Sample)', 'Youth Support', '(800) 669-6196', 'https://example-youthhub.org', 'youth@example-youthhub.org', 'Sample Directory', 'LIFE-LINE Hackathon Demo Registry', '134 Golden Gate Ave, San Francisco, CA 94102', 'San Francisco', 'CA', 37.7819, -122.4126, '24/7 Youth Drop-In & Counselling', true, 'Sample youth safe space entry; confirm live hours via Google Maps search.'],
      ['Civic Crisis Response & Counselling Center (Demo)', 'Counselling', '988 (Crisis Lifeline)', 'https://988lifeline.org', 'counselling@example-crisis.org', 'Public Directory (Sample)', 'Sample Crisis Counselling Registry', '870 Market St, Suite 400, San Francisco, CA 94102', 'San Francisco', 'CA', 37.7848, -122.4071, '24/7 Multilingual Counselling', true, 'Dial or text 988 in the US/Canada for immediate crisis counselling.'],
      ['Mission District Community Safe Refuge (Demo)', 'Shelter', '(415) 555-0198', 'https://example-refuge.org', 'shelter@example-refuge.org', 'Demo Partner', 'LIFE-LINE Hackathon Demo Registry', '2190 Mission St, San Francisco, CA 94110', 'San Francisco', 'CA', 37.7618, -122.4193, '24/7 Intake Desk', true, 'Simulated shelter capacity data for hackathon evaluation.'],
    ] as const;

    for (const o of seedOrgs) {
      const ins = await pool.query(
        `INSERT INTO support_organizations (name, category, phone, website, email, verification_status, source, is_sample_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id`,
        [o[0], o[1], o[2], o[3], o[4], o[5], o[6]]
      );
      await pool.query(
        `INSERT INTO support_locations (organization_id, address, city, region, latitude, longitude, operating_hours, is_24_hours, availability_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ins.rows[0].id, o[7], o[8], o[9], o[10], o[11], o[12], o[13], o[14]]
      );
    }
  }

  const userCnt = await queryWithRetry<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users');
  if (userCnt.rows[0]?.cnt === 0) {
    const demoPass = await hashPasswordAsync('LifelineDemo2026!');
    const demoAccounts = [
      ['demo-user-maya', 'maya.demo@lifeline-ai.demo', 'Maya Lin (Demo User)', 'regular_user', '+1-415-555-0101', 'Allergic to penicillin. Prefers silent text check-ins during late commute.'],
      ['demo-operator-elena', 'operator.demo@lifeline-ai.demo', 'Elena Vance (Demo Operator)', 'emergency_operator', '+1-415-555-0190', 'Shift Lead — Youth & Women Rapid Safety Desk'],
      ['demo-org-safehaven', 'partner.demo@lifeline-ai.demo', 'Safe Haven Coordinator (Demo Org)', 'support_organization', '+1-415-555-0142', 'Verified Partner Intake Desk'],
      ['demo-admin-console', 'admin.demo@lifeline-ai.demo', 'System Governance Admin (Demo)', 'administrator', '+1-415-555-0199', 'Audit & RBAC Governance Account'],
    ] as const;

    let mayaId = 1;
    for (const acc of demoAccounts) {
      const uRes = await pool.query(
        `INSERT INTO users (uid, email, display_name, role, password_hash, email_verified, is_demo_account)
         VALUES ($1,$2,$3,$4,$5,TRUE,TRUE) RETURNING id`,
        [acc[0], acc[1], acc[2], acc[3], demoPass]
      );
      const userId = uRes.rows[0].id;
      if (acc[0] === 'demo-user-maya') mayaId = userId;
      await pool.query(
        `INSERT INTO user_profiles (user_id, full_name, phone, emergency_notes, preferred_language, safety_status, last_known_lat, last_known_lng, last_location_label, location_sharing_consent)
         VALUES ($1,$2,$3,$4,'en','Safe',37.7749,-122.4194,'San Francisco, CA (Demo Default)',TRUE)`,
        [userId, acc[2], acc[4], acc[5]]
      );
      await pool.query(`INSERT INTO user_preferences (user_id, theme, demo_mode_enabled) VALUES ($1,'dark',TRUE)`, [userId]);
    }

    await pool.query(
      `INSERT INTO trusted_contacts (user_id, name, relationship, email, phone, notify_email, notify_sms, priority_order, is_verified, source)
       VALUES ($1,'Priya Sharma (Demo Contact)','Sister','priya.demo@example.com','+1-415-555-0112',TRUE,TRUE,1,TRUE,'demo_seed'),
              ($1,'Campus Security Desk (Demo)','University Escort','campus.safety@example.edu','+1-415-555-0188',TRUE,TRUE,2,TRUE,'demo_seed')`,
      [mayaId]
    );
  }

  const latest = await pool.query('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1');
  return latest.rows[0]?.version || 'v3_sos_idempotency_and_delivery';
}

export async function initializeDatabase(): Promise<DatabaseDialect> {
  if (activeDialect) return activeDialect;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const requestedDriver = (process.env.DB_DRIVER || 'auto').toLowerCase();
    const isProd = process.env.NODE_ENV === 'production';

    if (requestedDriver === 'sqlite') {
      runSqliteMigrations();
      seedSqliteInitialData();
      activeDialect = 'sqlite';
      return activeDialect;
    }

    const pgConfigured = hasPostgresConfig();
    if (requestedDriver === 'postgres' || pgConfigured) {
      try {
        await pool.query('SELECT 1');
        await runPostgresMigrations();
        activeDialect = 'postgres';
        console.log('[db] Authoritative PostgreSQL database connected and verified.');
        return activeDialect;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (requestedDriver === 'postgres' || (isProd && requestedDriver !== 'sqlite')) {
          throw new Error(
            `FATAL DATABASE ERROR: PostgreSQL is required (${requestedDriver}, NODE_ENV=${process.env.NODE_ENV}) but unreachable: ${msg}`
          );
        }
        console.warn(`[db] PostgreSQL unreachable in dev/auto mode (${msg}); locking authoritative SQLite store.`);
      }
    }

    runSqliteMigrations();
    seedSqliteInitialData();
    activeDialect = 'sqlite';
    return activeDialect;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export function getActiveDatabaseDialect(): DatabaseDialect {
  return activeDialect || 'sqlite';
}

export function resetDatabaseStateForTests() {
  activeDialect = null;
  initPromise = null;
}

async function ensureDialect(): Promise<DatabaseDialect> {
  return activeDialect || initializeDatabase();
}

export async function checkDatabaseHealth(): Promise<DatabaseHealthReport> {
  const started = Date.now();
  try {
    const dialect = await ensureDialect();
    if (dialect === 'postgres') {
      await pool.query('SELECT 1');
      const tablesRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      const present = new Set(tablesRes.rows.map((r: { table_name: string }) => r.table_name));
      const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
      const migRes = await pool.query(
        'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1'
      );
      return {
        ok: missing.length === 0,
        dialect: 'postgres',
        migrationVersion: migRes.rows[0]?.version || 'unknown',
        latencyMs: Date.now() - started,
        tablesVerified: REQUIRED_TABLES.length - missing.length,
        error: missing.length > 0 ? `Missing tables: ${missing.join(', ')}` : undefined,
      };
    }

    sqlite.prepare('SELECT 1').get();
    const tableRows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const present = new Set(tableRows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    const mig = sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
      .get() as { version: string } | undefined;

    return {
      ok: missing.length === 0,
      dialect: 'sqlite',
      migrationVersion: mig?.version || 'unknown',
      latencyMs: Date.now() - started,
      tablesVerified: REQUIRED_TABLES.length - missing.length,
      error: missing.length > 0 ? `Missing tables: ${missing.join(', ')}` : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      dialect: getActiveDatabaseDialect(),
      migrationVersion: 'unknown',
      latencyMs: Date.now() - started,
      tablesVerified: 0,
      error: err instanceof Error ? err.message : String(err),
    };
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

function mapPgUser(u: typeof users.$inferSelect): AppUser {
  return {
    id: u.id,
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    role: (u.role as UserRole) || 'regular_user',
    emailVerified: u.emailVerified,
    isDemoAccount: u.isDemoAccount,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function getOrCreateUserByFirebase(
  uid: string,
  email: string,
  displayName = '',
  emailVerified = false
): Promise<AppUser> {
  const dialect = await ensureDialect();
  const normalizedEmail = email.trim().toLowerCase();

  if (dialect === 'postgres') {
    const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (existing[0]) return mapPgUser(existing[0]);

    const byEmail = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (byEmail[0]) {
      if (!emailVerified) {
        throw new Error('Google account email must be verified before linking to an existing LIFE-LINE AI account.');
      }
      const updated = await db
        .update(users)
        .set({
          uid,
          displayName: displayName || byEmail[0].displayName,
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, byEmail[0].id))
        .returning();
      return mapPgUser(updated[0]);
    }

    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          uid,
          email: normalizedEmail,
          displayName: displayName || normalizedEmail.split('@')[0],
          role: 'regular_user',
          emailVerified,
          isDemoAccount: false,
        })
        .returning();
      const u = inserted[0];
      await tx.insert(userProfiles).values({ userId: u.id, fullName: u.displayName }).onConflictDoNothing();
      await tx.insert(userPreferences).values({ userId: u.id }).onConflictDoNothing();
      return mapPgUser(u);
    });
  }

  const row = sqlite.prepare('SELECT * FROM users WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (row) return mapSqliteUser(row);

  const byEmail = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as
    | Record<string, unknown>
    | undefined;
  if (byEmail) {
    if (!emailVerified) {
      throw new Error('Google account email must be verified before linking to an existing LIFE-LINE AI account.');
    }
    sqlite
      .prepare(
        "UPDATE users SET uid = ?, display_name = COALESCE(NULLIF(?, ''), display_name), email_verified = 1, updated_at = datetime('now') WHERE id = ?"
      )
      .run(uid, displayName, Number(byEmail.id));
    const updated = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(Number(byEmail.id)) as Record<string, unknown>;
    return mapSqliteUser(updated);
  }

  return runSqliteTransaction(() => {
    const res = sqlite
      .prepare('INSERT INTO users (uid, email, display_name, role, email_verified, is_demo_account) VALUES (?, ?, ?, ?, ?, 0)')
      .run(uid, normalizedEmail, displayName || normalizedEmail.split('@')[0], 'regular_user', emailVerified ? 1 : 0);
    const newId = Number(res.lastInsertRowid);
    sqlite.prepare('INSERT OR IGNORE INTO user_profiles (user_id, full_name) VALUES (?, ?)').run(newId, displayName || normalizedEmail.split('@')[0]);
    sqlite.prepare('INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)').run(newId);
    const created = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(newId) as Record<string, unknown>;
    return mapSqliteUser(created);
  });
}

// Public registration ALWAYS creates regular_user accounts only.
export async function registerEmailUser(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ user: AppUser; verificationCode: string }> {
  const dialect = await ensureDialect();
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim() || email.split('@')[0];
  const uid = `local_${crypto.randomUUID()}`;
  const passwordHash = await hashPasswordAsync(input.password);
  const verificationCode = String(crypto.randomInt(100000, 999999));
  const codeHash = hashOneTimeCode(verificationCode);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  if (dialect === 'postgres') {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw new Error('An account with this email already exists.');

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          uid,
          email,
          displayName,
          role: 'regular_user',
          passwordHash,
          emailVerified: false,
          verificationCodeHash: codeHash,
          verificationCodeExpiresAt: expiresAt,
          verificationAttempts: 0,
          isDemoAccount: false,
        })
        .returning();
      const u = inserted[0];
      await tx.insert(userProfiles).values({ userId: u.id, fullName: displayName });
      await tx.insert(userPreferences).values({ userId: u.id });
      return mapPgUser(u);
    });
    return { user: created, verificationCode };
  }

  const existing = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  if (existing) throw new Error('An account with this email already exists.');

  const user = runSqliteTransaction(() => {
    const res = sqlite
      .prepare(
        `INSERT INTO users (uid, email, display_name, role, password_hash, email_verified, verification_code_hash, verification_code_expires_at, verification_attempts, is_demo_account)
         VALUES (?, ?, ?, 'regular_user', ?, 0, ?, ?, 0, 0)`
      )
      .run(uid, email, displayName, passwordHash, codeHash, expiresAt.toISOString());
    const userId = Number(res.lastInsertRowid);
    sqlite.prepare('INSERT INTO user_profiles (user_id, full_name) VALUES (?, ?)').run(userId, displayName);
    sqlite.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(userId);
    const created = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
    return mapSqliteUser(created);
  });

  return { user, verificationCode };
}

export async function loginEmailUser(email: string, password: string): Promise<AppUser> {
  const dialect = await ensureDialect();
  const normalizedEmail = email.trim().toLowerCase();

  if (dialect === 'postgres') {
    const t0 = performance.now();
    const rows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    metrics.recordDbQuery(performance.now() - t0);
    const row = rows[0];
    if (!row || !row.passwordHash || !(await verifyPasswordAsync(password, row.passwordHash))) {
      throw new Error('Invalid email or password.');
    }
    return mapPgUser(row);
  }

  const t0 = performance.now();
  const row = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as
    | Record<string, unknown>
    | undefined;
  metrics.recordDbQuery(performance.now() - t0);
  if (!row || !row.password_hash || !(await verifyPasswordAsync(password, String(row.password_hash)))) {
    throw new Error('Invalid email or password.');
  }
  return mapSqliteUser(row);
}

export async function resendVerificationCode(userId: number): Promise<string> {
  const dialect = await ensureDialect();
  const code = String(crypto.randomInt(100000, 999999));
  const codeHash = hashOneTimeCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  if (dialect === 'postgres') {
    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!existing[0]) throw new Error('Account not found.');
    if (existing[0].emailVerified) throw new Error('Email is already verified.');
    await db
      .update(users)
      .set({
        verificationCodeHash: codeHash,
        verificationCodeExpiresAt: expiresAt,
        verificationAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return code;
  }

  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Account not found.');
  if (row.email_verified) throw new Error('Email is already verified.');
  sqlite
    .prepare(
      "UPDATE users SET verification_code_hash = ?, verification_code_expires_at = ?, verification_attempts = 0, updated_at = datetime('now') WHERE id = ?"
    )
    .run(codeHash, expiresAt.toISOString(), userId);
  return code;
}

export async function verifyUserEmailCode(userId: number, code: string): Promise<AppUser> {
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('Account not found.');
    if (row.emailVerified) return mapPgUser(row);
    if (!row.verificationCodeHash || !row.verificationCodeExpiresAt) {
      throw new Error('No active verification code. Request a new code.');
    }
    if (row.verificationCodeExpiresAt.getTime() < Date.now()) {
      await db
        .update(users)
        .set({ verificationCodeHash: '', verificationCodeExpiresAt: null, verificationAttempts: 0 })
        .where(eq(users.id, userId));
      throw new Error('Verification code expired. Please request a new code.');
    }
    if (row.verificationAttempts >= MAX_CODE_ATTEMPTS) {
      throw new Error('Too many invalid verification attempts. Please request a new code.');
    }
    if (!verifyOneTimeCode(code, row.verificationCodeHash)) {
      const nextAttempts = row.verificationAttempts + 1;
      await db
        .update(users)
        .set({
          verificationAttempts: nextAttempts,
          ...(nextAttempts >= MAX_CODE_ATTEMPTS
            ? { verificationCodeHash: '', verificationCodeExpiresAt: null }
            : {}),
        })
        .where(eq(users.id, userId));
      throw new Error(
        nextAttempts >= MAX_CODE_ATTEMPTS
          ? 'Verification code invalidated after maximum attempts. Please request a new code.'
          : 'Invalid verification code.'
      );
    }

    const updated = await db
      .update(users)
      .set({
        emailVerified: true,
        verificationCodeHash: '',
        verificationCodeExpiresAt: null,
        verificationAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return mapPgUser(updated[0]);
  }

  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Account not found.');
  if (row.email_verified) return mapSqliteUser(row);

  const hash = String(row.verification_code_hash || '');
  const expiresRaw = row.verification_code_expires_at ? String(row.verification_code_expires_at) : '';
  const attempts = Number(row.verification_attempts || 0);

  if (!hash || !expiresRaw) {
    throw new Error('No active verification code. Request a new code.');
  }
  if (new Date(expiresRaw).getTime() < Date.now()) {
    sqlite
      .prepare("UPDATE users SET verification_code_hash = '', verification_code_expires_at = NULL, verification_attempts = 0 WHERE id = ?")
      .run(userId);
    throw new Error('Verification code expired. Please request a new code.');
  }
  if (attempts >= MAX_CODE_ATTEMPTS) {
    throw new Error('Too many invalid verification attempts. Please request a new code.');
  }
  if (!verifyOneTimeCode(code, hash)) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= MAX_CODE_ATTEMPTS) {
      sqlite
        .prepare("UPDATE users SET verification_attempts = ?, verification_code_hash = '', verification_code_expires_at = NULL WHERE id = ?")
        .run(nextAttempts, userId);
      throw new Error('Verification code invalidated after maximum attempts. Please request a new code.');
    }
    sqlite.prepare('UPDATE users SET verification_attempts = ? WHERE id = ?').run(nextAttempts, userId);
    throw new Error('Invalid verification code.');
  }

  sqlite
    .prepare(
      "UPDATE users SET email_verified = 1, verification_code_hash = '', verification_code_expires_at = NULL, verification_attempts = 0, updated_at = datetime('now') WHERE id = ?"
    )
    .run(userId);
  const updated = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  return mapSqliteUser(updated);
}

export async function initiatePasswordReset(
  email: string,
  ttlMs = CODE_TTL_MS
): Promise<{ resetCode: string; expiresAt: string } | null> {
  const dialect = await ensureDialect();
  const normalizedEmail = email.trim().toLowerCase();
  const resetCode = String(crypto.randomInt(100000, 999999));
  const resetHash = hashOneTimeCode(resetCode);
  const expiresAt = new Date(Date.now() + ttlMs);

  if (dialect === 'postgres') {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (!rows[0]) return null;
    await db
      .update(users)
      .set({
        resetCodeHash: resetHash,
        resetCodeExpiresAt: expiresAt,
        resetAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, rows[0].id));
    return { resetCode, expiresAt: expiresAt.toISOString() };
  }

  const row = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail) as { id: number } | undefined;
  if (!row) return null;
  sqlite
    .prepare(
      "UPDATE users SET reset_code_hash = ?, reset_code_expires_at = ?, reset_attempts = 0, updated_at = datetime('now') WHERE id = ?"
    )
    .run(resetHash, expiresAt.toISOString(), row.id);
  return { resetCode, expiresAt: expiresAt.toISOString() };
}

export async function completePasswordReset(
  email: string,
  code: string,
  newPassword: string
): Promise<{ ok: boolean; reason?: string }> {
  const dialect = await ensureDialect();
  const normalizedEmail = email.trim().toLowerCase();

  if (dialect === 'postgres') {
    const rows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    const row = rows[0];
    if (!row || !row.resetCodeHash || !row.resetCodeExpiresAt) {
      return { ok: false, reason: 'Invalid or expired reset code.' };
    }
    if (row.resetCodeExpiresAt.getTime() < Date.now()) {
      await db
        .update(users)
        .set({ resetCodeHash: '', resetCodeExpiresAt: null, resetAttempts: 0 })
        .where(eq(users.id, row.id));
      return { ok: false, reason: 'Reset code has expired. Please request a new code.' };
    }
    if (row.resetAttempts >= MAX_CODE_ATTEMPTS) {
      return { ok: false, reason: 'Maximum reset attempts exceeded. Please request a new code.' };
    }
    if (!verifyOneTimeCode(code, row.resetCodeHash)) {
      const nextAttempts = row.resetAttempts + 1;
      await db
        .update(users)
        .set({
          resetAttempts: nextAttempts,
          ...(nextAttempts >= MAX_CODE_ATTEMPTS ? { resetCodeHash: '', resetCodeExpiresAt: null } : {}),
        })
        .where(eq(users.id, row.id));
      return {
        ok: false,
        reason:
          nextAttempts >= MAX_CODE_ATTEMPTS
            ? 'Reset code invalidated after maximum failed attempts.'
            : 'Invalid reset code.',
      };
    }

    const hash = await hashPasswordAsync(newPassword);
    await db
      .update(users)
      .set({
        passwordHash: hash,
        resetCodeHash: '',
        resetCodeExpiresAt: null,
        resetAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.id));
    return { ok: true };
  }

  const row = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as
    | Record<string, unknown>
    | undefined;
  if (!row || !row.reset_code_hash || !row.reset_code_expires_at) {
    return { ok: false, reason: 'Invalid or expired reset code.' };
  }
  const expiresAtMs = new Date(String(row.reset_code_expires_at)).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs < Date.now()) {
    sqlite
      .prepare("UPDATE users SET reset_code_hash = '', reset_code_expires_at = NULL, reset_attempts = 0 WHERE id = ?")
      .run(Number(row.id));
    return { ok: false, reason: 'Reset code has expired. Please request a new code.' };
  }
  const attempts = Number(row.reset_attempts || 0);
  if (attempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, reason: 'Maximum reset attempts exceeded. Please request a new code.' };
  }
  if (!verifyOneTimeCode(code, String(row.reset_code_hash))) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= MAX_CODE_ATTEMPTS) {
      sqlite
        .prepare("UPDATE users SET reset_attempts = ?, reset_code_hash = '', reset_code_expires_at = NULL WHERE id = ?")
        .run(nextAttempts, Number(row.id));
      return { ok: false, reason: 'Reset code invalidated after maximum failed attempts.' };
    }
    sqlite.prepare('UPDATE users SET reset_attempts = ? WHERE id = ?').run(nextAttempts, Number(row.id));
    return { ok: false, reason: 'Invalid reset code.' };
  }

  const hash = await hashPasswordAsync(newPassword);
  sqlite
    .prepare(
      "UPDATE users SET password_hash = ?, reset_code_hash = '', reset_code_expires_at = NULL, reset_attempts = 0, updated_at = datetime('now') WHERE id = ?"
    )
    .run(hash, Number(row.id));
  return { ok: true };
}

export async function getUserById(userId: number): Promise<AppUser | null> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ? mapPgUser(rows[0]) : null;
  }
  const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
  return row ? mapSqliteUser(row) : null;
}

export async function getDemoAccounts(): Promise<AppUser[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db.select().from(users).where(eq(users.isDemoAccount, true)).orderBy(asc(users.id));
    return rows.map(mapPgUser);
  }
  const rows = sqlite.prepare('SELECT * FROM users WHERE is_demo_account = 1 ORDER BY id ASC').all() as Record<
    string,
    unknown
  >[];
  return rows.map(mapSqliteUser);
}

export async function listOperatorUserIds(): Promise<number[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.role} IN ('emergency_operator', 'support_organization', 'administrator')`);
    return rows.map((r) => r.id);
  }
  const rows = sqlite
    .prepare("SELECT id FROM users WHERE role IN ('emergency_operator', 'support_organization', 'administrator')")
    .all() as { id: number }[];
  return rows.map((r) => Number(r.id));
}

export async function listAllUsersForAdmin(): Promise<AppUser[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db.select().from(users).orderBy(asc(users.id));
    return rows.map(mapPgUser);
  }
  const rows = sqlite.prepare('SELECT * FROM users ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map(mapSqliteUser);
}

export async function countAdministrators(): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, 'administrator'));
    return res[0]?.cnt ?? 0;
  }
  const row = sqlite.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'administrator'").get() as { cnt: number };
  return Number(row?.cnt || 0);
}

export async function updateUserRole(targetUserId: number, role: UserRole): Promise<AppUser | null> {
  const dialect = await ensureDialect();
  const target = await getUserById(targetUserId);
  if (!target) return null;

  if (target.role === 'administrator' && role !== 'administrator') {
    const adminCount = await countAdministrators();
    if (adminCount <= 1) {
      throw new Error('Cannot demote the last remaining administrator.');
    }
  }

  if (dialect === 'postgres') {
    const updated = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, targetUserId))
      .returning();
    return updated[0] ? mapPgUser(updated[0]) : null;
  }

  sqlite.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, targetUserId);
  return getUserById(targetUserId);
}

export async function getUserProfile(userId: number) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const [pRows, prefRows] = await Promise.all([
      db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
      db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
    ]);
    const p = pRows[0];
    const pref = prefRows[0];
    return {
      profile: p
        ? {
            id: p.id,
            userId: p.userId,
            fullName: p.fullName,
            phone: p.phone,
            avatarUrl: p.avatarUrl,
            emergencyNotes: p.emergencyNotes,
            medicalNotes: p.medicalNotes,
            bloodType: p.bloodType,
            preferredLanguage: p.preferredLanguage,
            safetyStatus: p.safetyStatus,
            lastKnownLat: p.lastKnownLat ?? null,
            lastKnownLng: p.lastKnownLng ?? null,
            lastLocationLabel: p.lastLocationLabel,
            locationSharingConsent: p.locationSharingConsent,
          }
        : null,
      preferences: pref
        ? {
            theme: pref.theme,
            enableEmailAlerts: pref.enableEmailAlerts,
            enableSmsAlerts: pref.enableSmsAlerts,
            enableInAppAlerts: pref.enableInAppAlerts,
            locationConsentMode: pref.locationConsentMode,
            dataRetentionDays: pref.dataRetentionDays,
            demoModeEnabled: pref.demoModeEnabled,
          }
        : null,
    };
  }

  const profile = sqlite.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined;
  const prefs = sqlite.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined;
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
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    await db.transaction(async (tx) => {
      const profileSet: Record<string, unknown> = { updatedAt: new Date() };
      if (data.fullName !== undefined) profileSet.fullName = data.fullName;
      if (data.phone !== undefined) profileSet.phone = data.phone;
      if (data.emergencyNotes !== undefined) profileSet.emergencyNotes = data.emergencyNotes;
      if (data.medicalNotes !== undefined) profileSet.medicalNotes = data.medicalNotes;
      if (data.bloodType !== undefined) profileSet.bloodType = data.bloodType;
      if (data.preferredLanguage !== undefined) profileSet.preferredLanguage = data.preferredLanguage;
      if (data.safetyStatus !== undefined) profileSet.safetyStatus = data.safetyStatus;
      if (data.lastKnownLat !== undefined) profileSet.lastKnownLat = data.lastKnownLat;
      if (data.lastKnownLng !== undefined) profileSet.lastKnownLng = data.lastKnownLng;
      if (data.lastLocationLabel !== undefined) profileSet.lastLocationLabel = data.lastLocationLabel;
      if (data.locationSharingConsent !== undefined) profileSet.locationSharingConsent = data.locationSharingConsent;

      await tx.update(userProfiles).set(profileSet).where(eq(userProfiles.userId, userId));

      const prefSet: Record<string, unknown> = { updatedAt: new Date() };
      if (data.theme !== undefined) prefSet.theme = data.theme;
      if (data.enableEmailAlerts !== undefined) prefSet.enableEmailAlerts = data.enableEmailAlerts;
      if (data.enableSmsAlerts !== undefined) prefSet.enableSmsAlerts = data.enableSmsAlerts;
      if (data.enableInAppAlerts !== undefined) prefSet.enableInAppAlerts = data.enableInAppAlerts;
      if (data.locationConsentMode !== undefined) prefSet.locationConsentMode = data.locationConsentMode;
      if (data.dataRetentionDays !== undefined) prefSet.dataRetentionDays = data.dataRetentionDays;

      await tx.update(userPreferences).set(prefSet).where(eq(userPreferences.userId, userId));

      if (data.fullName) {
        await tx.update(users).set({ displayName: data.fullName, updatedAt: new Date() }).where(eq(users.id, userId));
      }
    });
    return getUserProfile(userId);
  }

  runSqliteTransaction(() => {
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
  });
  return getUserProfile(userId);
}

export async function deleteUserAccount(userId: number) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    await db.delete(users).where(eq(users.id, userId));
    return;
  }
  sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Trusted Contacts
export async function listTrustedContacts(userId: number) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(trustedContacts)
      .where(eq(trustedContacts.userId, userId))
      .orderBy(asc(trustedContacts.priorityOrder), asc(trustedContacts.id));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      relationship: r.relationship,
      email: r.email,
      phone: r.phone,
      notifyEmail: r.notifyEmail,
      notifySms: r.notifySms,
      notifyWhatsapp: r.notifyWhatsapp,
      priorityOrder: r.priorityOrder,
      isVerified: r.isVerified,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
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
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const inserted = await db
      .insert(trustedContacts)
      .values({
        userId,
        name: input.name.trim(),
        relationship: input.relationship?.trim() || 'Trusted Contact',
        email: input.email?.trim() || '',
        phone: input.phone?.trim() || '',
        notifyEmail: input.notifyEmail !== false,
        notifySms: Boolean(input.notifySms),
        notifyWhatsapp: Boolean(input.notifyWhatsapp),
        priorityOrder: input.priorityOrder ?? 1,
        source: input.source || 'manual',
      })
      .returning();
    const c = inserted[0];
    return {
      id: c.id,
      userId: c.userId,
      name: c.name,
      relationship: c.relationship,
      email: c.email,
      phone: c.phone,
      notifyEmail: c.notifyEmail,
      notifySms: c.notifySms,
      notifyWhatsapp: c.notifyWhatsapp,
      priorityOrder: c.priorityOrder,
      isVerified: c.isVerified,
      source: c.source,
    };
  }

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
  const created = sqlite
    .prepare('SELECT * FROM trusted_contacts WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
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
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const existing = await db
      .select({ id: trustedContacts.id })
      .from(trustedContacts)
      .where(and(eq(trustedContacts.id, contactId), eq(trustedContacts.userId, userId)))
      .limit(1);
    if (!existing[0]) throw new Error('Trusted contact not found.');

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.relationship !== undefined) patch.relationship = input.relationship.trim();
    if (input.email !== undefined) patch.email = input.email.trim();
    if (input.phone !== undefined) patch.phone = input.phone.trim();
    if (input.notifyEmail !== undefined) patch.notifyEmail = input.notifyEmail;
    if (input.notifySms !== undefined) patch.notifySms = input.notifySms;
    if (input.notifyWhatsapp !== undefined) patch.notifyWhatsapp = input.notifyWhatsapp;

    await db
      .update(trustedContacts)
      .set(patch)
      .where(and(eq(trustedContacts.id, contactId), eq(trustedContacts.userId, userId)));
    return listTrustedContacts(userId);
  }

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

export async function deleteTrustedContact(userId: number, contactId: number): Promise<boolean> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const deleted = await db
      .delete(trustedContacts)
      .where(and(eq(trustedContacts.id, contactId), eq(trustedContacts.userId, userId)))
      .returning({ id: trustedContacts.id });
    return deleted.length > 0;
  }
  const res = sqlite.prepare('DELETE FROM trusted_contacts WHERE id = ? AND user_id = ?').run(contactId, userId);
  return Number(res.changes || 0) > 0;
}

// Emergency Incidents (with idempotency key deduplication & atomic transactions)
export interface IncidentRecord {
  id: number;
  userId: number;
  idempotencyKey: string | null;
  clientQueuedAt: string | null;
  deliveryStatus: DeliveryState;
  reporterName: string;
  reporterEmail: string;
  title: string;
  description: string;
  category: string;
  status: string;
  priority: string;
  latitude: number | null;
  longitude: number | null;
  locationLabel: string;
  locationAccuracyMeters: number | null;
  isSimulated: boolean;
  acknowledgedByUserId: number | null;
  operatorName: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updates: Array<{
    id: number;
    authorRole: string;
    authorName: string;
    previousStatus: string;
    newStatus: string;
    note: string;
    isInternal: boolean;
    createdAt: string;
  }>;
  deliveryLogs: Array<{
    id: number;
    recipient: string;
    channel: string;
    provider: string;
    status: string;
    attemptCount: number;
    errorMessage: string;
    sentAt: string | null;
    createdAt: string;
  }>;
}

export function sanitizeIncidentForViewer(incident: IncidentRecord, viewerRole: UserRole): IncidentRecord {
  const isPrivileged = ['emergency_operator', 'support_organization', 'administrator'].includes(viewerRole);
  if (isPrivileged) return incident;
  return {
    ...incident,
    updates: incident.updates.filter((u) => !u.isInternal),
  };
}

export async function findIncidentByIdempotencyKey(
  userId: number,
  idempotencyKey: string
): Promise<IncidentRecord | null> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select({ id: emergencyIncidents.id })
      .from(emergencyIncidents)
      .where(and(eq(emergencyIncidents.userId, userId), eq(emergencyIncidents.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0] ? getIncidentById(rows[0].id) : null;
  }
  const row = sqlite
    .prepare('SELECT id FROM emergency_incidents WHERE user_id = ? AND idempotency_key = ? LIMIT 1')
    .get(userId, idempotencyKey) as { id: number } | undefined;
  return row ? getIncidentById(Number(row.id)) : null;
}

export async function createIncident(input: {
  userId: number;
  idempotencyKey?: string | null;
  clientQueuedAt?: string | null;
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  latitude?: number | null;
  longitude?: number | null;
  locationLabel?: string;
  locationAccuracyMeters?: number | null;
  isSimulated?: boolean;
}): Promise<{ incident: IncidentRecord | null; deduplicated: boolean }> {
  const dialect = await ensureDialect();
  const cleanKey = input.idempotencyKey?.trim() || null;

  if (cleanKey) {
    const existing = await findIncidentByIdempotencyKey(input.userId, cleanKey);
    if (existing) {
      return { incident: existing, deduplicated: true };
    }
  }

  if (dialect === 'postgres') {
    try {
      const incidentId = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(emergencyIncidents)
          .values({
            userId: input.userId,
            idempotencyKey: cleanKey,
            clientQueuedAt: input.clientQueuedAt ? new Date(input.clientQueuedAt) : null,
            deliveryStatus: 'submitted',
            title: input.title,
            description: input.description || '',
            category: input.category || 'Personal Safety',
            status: 'SOS Activated',
            priority: input.priority || 'CRITICAL',
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            locationLabel: input.locationLabel || 'Location pending',
            locationAccuracyMeters: input.locationAccuracyMeters ?? null,
            isSimulated: Boolean(input.isSimulated),
          })
          .returning({ id: emergencyIncidents.id });
        const id = inserted[0].id;
        await tx.insert(incidentUpdates).values({
          incidentId: id,
          authorUserId: input.userId,
          authorRole: 'regular_user',
          previousStatus: '',
          newStatus: 'SOS Activated',
          note: input.isSimulated
            ? 'Simulated SOS triggered in demo sandbox.'
            : 'SOS Emergency Activated by user.',
        });
        return id;
      });
      return { incident: await getIncidentById(incidentId), deduplicated: false };
    } catch (err) {
      if (cleanKey && String((err as { code?: string }).code) === '23505') {
        const existing = await findIncidentByIdempotencyKey(input.userId, cleanKey);
        if (existing) return { incident: existing, deduplicated: true };
      }
      throw err;
    }
  }

  try {
    const incidentId = runSqliteTransaction(() => {
      const res = sqlite
        .prepare(
          `INSERT INTO emergency_incidents (user_id, idempotency_key, client_queued_at, delivery_status, title, description, category, status, priority, latitude, longitude, location_label, location_accuracy_meters, is_simulated)
           VALUES (?, ?, ?, 'submitted', ?, ?, ?, 'SOS Activated', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.userId,
          cleanKey,
          input.clientQueuedAt || null,
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
      const id = Number(res.lastInsertRowid);
      sqlite
        .prepare(
          `INSERT INTO incident_updates (incident_id, author_user_id, author_role, previous_status, new_status, note)
           VALUES (?, ?, 'regular_user', '', 'SOS Activated', ?)`
        )
        .run(
          id,
          input.userId,
          input.isSimulated ? 'Simulated SOS triggered in demo sandbox.' : 'SOS Emergency Activated by user.'
        );
      return id;
    });
    return { incident: await getIncidentById(incidentId), deduplicated: false };
  } catch (err) {
    if (cleanKey && err instanceof Error && err.message.includes('UNIQUE')) {
      const existing = await findIncidentByIdempotencyKey(input.userId, cleanKey);
      if (existing) return { incident: existing, deduplicated: true };
    }
    throw err;
  }
}

export async function updateIncidentDeliveryState(incidentId: number, deliveryStatus: DeliveryState) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    await db
      .update(emergencyIncidents)
      .set({ deliveryStatus, updatedAt: new Date() })
      .where(eq(emergencyIncidents.id, incidentId));
    return;
  }
  sqlite
    .prepare("UPDATE emergency_incidents SET delivery_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(deliveryStatus, incidentId);
}

export async function getIncidentById(incidentId: number): Promise<IncidentRecord | null> {
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const res = await pool.query(
      `SELECT i.*, u.email AS reporter_email, u.display_name AS reporter_name,
              op.display_name AS operator_name
       FROM emergency_incidents i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN users op ON op.id = i.acknowledged_by_user_id
       WHERE i.id = $1`,
      [incidentId]
    );
    const r = res.rows[0];
    if (!r) return null;

    const updatesRes = await pool.query(
      `SELECT iu.*, u.display_name AS author_name
       FROM incident_updates iu
       LEFT JOIN users u ON u.id = iu.author_user_id
       WHERE iu.incident_id = $1
       ORDER BY iu.created_at ASC, iu.id ASC`,
      [incidentId]
    );

    const logsRes = await pool.query(
      `SELECT * FROM notification_delivery_logs WHERE incident_id = $1 ORDER BY id DESC`,
      [incidentId]
    );

    return {
      id: Number(r.id),
      userId: Number(r.user_id),
      idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null,
      clientQueuedAt: r.client_queued_at ? new Date(r.client_queued_at).toISOString() : null,
      deliveryStatus: (r.delivery_status as DeliveryState) || 'submitted',
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
      acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      updates: updatesRes.rows.map((u: Record<string, unknown>) => ({
        id: Number(u.id),
        authorRole: String(u.author_role),
        authorName: u.author_name ? String(u.author_name) : 'System',
        previousStatus: String(u.previous_status),
        newStatus: String(u.new_status),
        note: String(u.note),
        isInternal: Boolean(u.is_internal),
        createdAt: new Date(String(u.created_at)).toISOString(),
      })),
      deliveryLogs: logsRes.rows.map((l: Record<string, unknown>) => ({
        id: Number(l.id),
        recipient: String(l.recipient),
        channel: String(l.channel),
        provider: String(l.provider),
        status: String(l.status),
        attemptCount: Number(l.attempt_count),
        errorMessage: String(l.error_message || ''),
        sentAt: l.sent_at ? new Date(String(l.sent_at)).toISOString() : null,
        createdAt: new Date(String(l.created_at)).toISOString(),
      })),
    };
  }

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
    idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null,
    clientQueuedAt: r.client_queued_at ? String(r.client_queued_at) : null,
    deliveryStatus: (r.delivery_status as DeliveryState) || 'submitted',
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
      isInternal: Boolean(u.is_internal),
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

export async function listIncidentsForUser(
  userId: number,
  viewerRole: UserRole = 'regular_user',
  options: { limit?: number; offset?: number } = {}
) {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select({ id: emergencyIncidents.id })
      .from(emergencyIncidents)
      .where(eq(emergencyIncidents.userId, userId))
      .orderBy(desc(emergencyIncidents.createdAt), desc(emergencyIncidents.id))
      .limit(limit)
      .offset(offset);
    const results: IncidentRecord[] = [];
    for (const row of rows) {
      const full = await getIncidentById(row.id);
      if (full) results.push(sanitizeIncidentForViewer(full, viewerRole));
    }
    return results;
  }

  const rows = sqlite
    .prepare('SELECT id FROM emergency_incidents WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset) as { id: number }[];
  const results: IncidentRecord[] = [];
  for (const row of rows) {
    const full = await getIncidentById(row.id);
    if (full) results.push(sanitizeIncidentForViewer(full, viewerRole));
  }
  return results;
}

export async function countIncidentsForUser(userId: number): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(emergencyIncidents)
      .where(eq(emergencyIncidents.userId, userId));
    return res[0]?.cnt ?? 0;
  }
  const row = sqlite
    .prepare('SELECT COUNT(*) as cnt FROM emergency_incidents WHERE user_id = ?')
    .get(userId) as { cnt: number };
  return Number(row?.cnt || 0);
}

export async function listAllIncidentsForOperator(options: { limit?: number; offset?: number } = {}) {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select({ id: emergencyIncidents.id })
      .from(emergencyIncidents)
      .orderBy(desc(emergencyIncidents.createdAt), desc(emergencyIncidents.id))
      .limit(limit)
      .offset(offset);
    const results: IncidentRecord[] = [];
    for (const row of rows) {
      const full = await getIncidentById(row.id);
      if (full) results.push(full);
    }
    return results;
  }

  const rows = sqlite
    .prepare('SELECT id FROM emergency_incidents ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as { id: number }[];
  const results: IncidentRecord[] = [];
  for (const row of rows) {
    const full = await getIncidentById(row.id);
    if (full) results.push(full);
  }
  return results;
}

export async function countAllIncidentsForOperator(): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db.select({ cnt: sql<number>`count(*)::int` }).from(emergencyIncidents);
    return res[0]?.cnt ?? 0;
  }
  const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM emergency_incidents').get() as { cnt: number };
  return Number(row?.cnt || 0);
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
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(emergencyIncidents)
        .where(eq(emergencyIncidents.id, input.incidentId))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) throw new Error('Incident not found.');

      const ackAt =
        input.newStatus === 'Acknowledged' && !existing.acknowledgedAt ? new Date() : existing.acknowledgedAt;
      const resolvedAt = input.newStatus === 'Resolved' ? new Date() : existing.resolvedAt;
      const ackUser =
        input.newStatus === 'Acknowledged' || input.newStatus === 'Assistance in Progress'
          ? existing.acknowledgedByUserId ?? input.actorUserId
          : existing.acknowledgedByUserId;

      await tx
        .update(emergencyIncidents)
        .set({
          status: input.newStatus,
          priority: input.priority ?? existing.priority,
          acknowledgedByUserId: ackUser,
          acknowledgedAt: ackAt,
          resolvedAt,
          updatedAt: new Date(),
        })
        .where(eq(emergencyIncidents.id, input.incidentId));

      await tx.insert(incidentUpdates).values({
        incidentId: input.incidentId,
        authorUserId: input.actorUserId,
        authorRole: input.actorRole,
        previousStatus: existing.status,
        newStatus: input.newStatus,
        note: input.note || `Status updated to ${input.newStatus}`,
        isInternal: Boolean(input.isInternal),
      });

      if (
        input.newStatus === 'Acknowledged' &&
        ['emergency_operator', 'administrator', 'support_organization'].includes(input.actorRole)
      ) {
        await tx.insert(incidentAssignments).values({
          incidentId: input.incidentId,
          operatorUserId: input.actorUserId,
          assignedByUserId: input.actorUserId,
          status: 'active',
        });
      }
    });
    return getIncidentById(input.incidentId);
  }

  runSqliteTransaction(() => {
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

    if (
      input.newStatus === 'Acknowledged' &&
      ['emergency_operator', 'administrator', 'support_organization'].includes(input.actorRole)
    ) {
      sqlite
        .prepare(
          `INSERT INTO incident_assignments (incident_id, operator_user_id, assigned_by_user_id, status)
           VALUES (?, ?, ?, 'active')`
        )
        .run(input.incidentId, input.actorUserId, input.actorUserId);
    }
  });

  return getIncidentById(input.incidentId);
}

// Support Directory (cached cleanly for 60s — strictly public non-sensitive registry data)
export async function listSupportDirectory(category?: string, query?: string) {
  const dialect = await ensureDialect();
  const cacheKey = `support_directory:${dialect}:all`;

  type SupportDirectoryRow = {
    id: number;
    name: string;
    category: string;
    phone: string;
    website: string;
    email: string;
    verificationStatus: string;
    source: string;
    isSampleData: boolean;
    address: string;
    city: string;
    region: string;
    latitude: number;
    longitude: number;
    operatingHours: string;
    is24Hours: boolean;
    availabilityNote: string;
    lastUpdatedAt: string;
  };

  let baseList = await cacheQueue.getCachedJson<SupportDirectoryRow[]>(cacheKey);

  if (!baseList) {
    const t0 = performance.now();
    let rows: Record<string, unknown>[];
    if (dialect === 'postgres') {
      const res = await queryWithRetry(
        `SELECT o.*, l.address, l.city, l.region, l.latitude, l.longitude, l.operating_hours, l.is_24_hours, l.availability_note, l.last_updated_at
         FROM support_organizations o
         JOIN support_locations l ON l.organization_id = o.id
         ORDER BY o.id ASC`
      );
      rows = res.rows;
    } else {
      rows = sqlite
        .prepare(
          `SELECT o.*, l.address, l.city, l.region, l.latitude, l.longitude, l.operating_hours, l.is_24_hours, l.availability_note, l.last_updated_at
           FROM support_organizations o
           JOIN support_locations l ON l.organization_id = o.id
           ORDER BY o.id ASC`
        )
        .all() as Record<string, unknown>[];
      metrics.recordDbQuery(performance.now() - t0);
    }

    baseList = rows.map((r) => ({
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
      lastUpdatedAt:
        r.last_updated_at instanceof Date ? r.last_updated_at.toISOString() : String(r.last_updated_at),
    }));

    await cacheQueue.setCachedJson(cacheKey, baseList, 60);
  }

  return baseList.filter((r) => {
    if (category && category !== 'All' && r.category !== category) return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        r.address.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
      );
    }
    return true;
  });
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
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .insert(notifications)
      .values({
        userId: input.userId,
        incidentId: input.incidentId ?? null,
        channel: input.channel || 'in_app',
        title: input.title,
        message: input.message,
        category: input.category || 'safety',
        isSimulated: Boolean(input.isSimulated),
      })
      .returning({ id: notifications.id });
    return res[0].id;
  }

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

export async function listNotificationsForUser(
  userId: number,
  options: { limit?: number; offset?: number } = {}
) {
  const limit = options.limit ?? 40;
  const offset = options.offset ?? 0;
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      incidentId: r.incidentId ?? null,
      channel: r.channel,
      title: r.title,
      message: r.message,
      category: r.category,
      isRead: r.isRead,
      isSimulated: r.isSimulated,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  const rows = sqlite
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset) as Record<string, unknown>[];
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

export async function countNotificationsForUser(userId: number): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.userId, userId));
    return res[0]?.cnt ?? 0;
  }
  const row = sqlite
    .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?')
    .get(userId) as { cnt: number };
  return Number(row?.cnt || 0);
}

export async function markNotificationRead(userId: number, notificationId: number): Promise<boolean> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    return res.length > 0;
  }
  const res = sqlite
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(notificationId, userId);
  return Number(res.changes || 0) > 0;
}

export async function markAllNotificationsRead(userId: number): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)))
      .returning({ id: notifications.id });
    return res.length;
  }
  const res = sqlite
    .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .run(userId);
  return Number(res.changes || 0);
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
  const dialect = await ensureDialect();
  const isConfirmedSent = input.status === 'delivered' || input.status === 'sent' || input.status === 'simulated';

  if (dialect === 'postgres') {
    await db.insert(notificationDeliveryLogs).values({
      notificationId: input.notificationId ?? null,
      incidentId: input.incidentId ?? null,
      recipient: input.recipient,
      channel: input.channel,
      provider: input.provider,
      status: input.status,
      attemptCount: input.attemptCount,
      errorMessage: input.errorMessage || '',
      externalMessageId: input.externalMessageId || '',
      sentAt: isConfirmedSent ? new Date() : null,
    });
    return;
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
      isConfirmedSent ? new Date().toISOString() : null
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
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(aiAssessments)
        .values({
          incidentId: input.incidentId ?? null,
          userId: input.userId,
          agentName: input.agentName,
          modelUsed: input.modelUsed,
          inputSummary: input.inputSummary.slice(0, 500),
          urgencyLevel: input.urgencyLevel,
          classification: input.classification,
          assignedPriority: input.assignedPriority,
          confidenceScore: input.confidenceScore,
          rationale: input.rationale,
          missingInfoQuestions: input.missingInfoQuestions,
          uncertaintyNotes: input.uncertaintyNotes,
          escalateToHuman: input.escalateToHuman,
          rawStructuredOutput: input.rawStructuredOutput,
        })
        .returning({ id: aiAssessments.id });
      const assessmentId = inserted[0].id;
      for (const rec of input.recommendations) {
        await tx.insert(aiRecommendations).values({
          assessmentId,
          userId: input.userId,
          incidentId: input.incidentId ?? null,
          agentName: input.agentName,
          title: rec.title,
          recommendationText: rec.text,
          category: rec.category,
          confidence: input.confidenceScore,
          sourceCitation: rec.sourceCitation,
          actionRequiredAuth: Boolean(rec.actionRequiredAuth),
        });
      }
      return assessmentId;
    });
  }

  return runSqliteTransaction(() => {
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
  });
}

export async function listAiRecommendationsForUser(userId: number) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(aiRecommendations)
      .where(eq(aiRecommendations.userId, userId))
      .orderBy(desc(aiRecommendations.createdAt), desc(aiRecommendations.id))
      .limit(25);
    return rows.map((r) => ({
      id: r.id,
      agentName: r.agentName,
      title: r.title,
      recommendationText: r.recommendationText,
      category: r.category,
      confidence: r.confidence,
      sourceCitation: r.sourceCitation,
      actionRequiredAuth: r.actionRequiredAuth,
      isCompleted: r.isCompleted,
      createdAt: r.createdAt.toISOString(),
    }));
  }

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
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    await db.insert(auditLogs).values({
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail || 'system',
      actorRole: input.actorRole || 'system',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId || '',
      details: input.details || {},
      ipAddress: input.ipAddress || '',
    });
    return;
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

export async function listAuditLogs(limit = 50, offset = 0) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      actorRole: r.actorRole,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  const rows = sqlite
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as Record<string, unknown>[];
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

export async function countAuditLogs(): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await db.select({ cnt: sql<number>`count(*)::int` }).from(auditLogs);
    return res[0]?.cnt ?? 0;
  }
  const row = sqlite.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get() as { cnt: number };
  return Number(row?.cnt || 0);
}

// Analytics (SQL-aggregated O(1) memory queries + 10s cache; explicitly separates live vs simulated incidents)
export async function getOperationalAnalytics() {
  const dialect = await ensureDialect();
  const cacheKey = `analytics:operational:${dialect}`;

  const cached = await cacheQueue.getCachedJson<{
    liveStats: {
      total: number;
      active: number;
      resolved: number;
      avgAckSeconds: number | null;
      avgResolutionSeconds: number | null;
      byCategory: Array<{ name: string; count: number }>;
    };
    demoStats: {
      total: number;
      active: number;
      resolved: number;
      avgAckSeconds: number | null;
      avgResolutionSeconds: number | null;
      byCategory: Array<{ name: string; count: number }>;
    };
    resourceDistribution: Array<{ category: string; count: number }>;
    responders: { available: number; responding: number; offDuty: number };
  }>(cacheKey);
  if (cached) return cached;

  const t0 = performance.now();
  type AggSummaryRow = {
    is_sim: boolean | number;
    total: number;
    active: number;
    resolved: number;
    avg_ack_sec: number | null;
    avg_res_sec: number | null;
  };
  type CatRow = { is_sim: boolean | number; category: string; count: number };

  let summaryRows: AggSummaryRow[];
  let catRows: CatRow[];
  let orgRows: Array<{ category: string; count: number }>;
  let responderRows: Array<{ responder_status: string; count: number }>;

  if (dialect === 'postgres') {
    const [sumRes, catRes, orgRes, respRes] = await Promise.all([
      queryWithRetry<AggSummaryRow>(`
        SELECT
          is_simulated AS is_sim,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN ('SOS Activated', 'Alert Sent', 'Acknowledged', 'Assistance in Progress'))::int AS active,
          COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
          ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at))) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at >= created_at))::int AS avg_ack_sec,
          ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at >= created_at))::int AS avg_res_sec
        FROM emergency_incidents
        GROUP BY is_simulated
      `),
      queryWithRetry<CatRow>(`
        SELECT is_simulated AS is_sim, COALESCE(NULLIF(category, ''), 'Other') AS category, COUNT(*)::int AS count
        FROM emergency_incidents
        GROUP BY is_simulated, COALESCE(NULLIF(category, ''), 'Other')
      `),
      queryWithRetry<{ category: string; count: number }>(
        'SELECT category, COUNT(*)::int AS count FROM support_organizations GROUP BY category'
      ),
      queryWithRetry<{ responder_status: string; count: number }>(
        `SELECT responder_status, COUNT(*)::int AS count FROM users
         WHERE role IN ('emergency_operator', 'support_organization', 'administrator')
         GROUP BY responder_status`
      ),
    ]);
    summaryRows = sumRes.rows;
    catRows = catRes.rows;
    orgRows = orgRes.rows;
    responderRows = respRes.rows;
  } else {
    summaryRows = sqlite
      .prepare(`
        SELECT
          is_simulated AS is_sim,
          COUNT(*) AS total,
          SUM(CASE WHEN status IN ('SOS Activated', 'Alert Sent', 'Acknowledged', 'Assistance in Progress') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
          ROUND(AVG(CASE WHEN acknowledged_at IS NOT NULL AND julianday(acknowledged_at) >= julianday(created_at)
            THEN (julianday(acknowledged_at) - julianday(created_at)) * 86400.0 ELSE NULL END)) AS avg_ack_sec,
          ROUND(AVG(CASE WHEN resolved_at IS NOT NULL AND julianday(resolved_at) >= julianday(created_at)
            THEN (julianday(resolved_at) - julianday(created_at)) * 86400.0 ELSE NULL END)) AS avg_res_sec
        FROM emergency_incidents
        GROUP BY is_simulated
      `)
      .all() as AggSummaryRow[];
    catRows = sqlite
      .prepare(`
        SELECT is_simulated AS is_sim, COALESCE(NULLIF(category, ''), 'Other') AS category, COUNT(*) AS count
        FROM emergency_incidents
        GROUP BY is_simulated, COALESCE(NULLIF(category, ''), 'Other')
      `)
      .all() as CatRow[];
    orgRows = sqlite
      .prepare('SELECT category, COUNT(*) as count FROM support_organizations GROUP BY category')
      .all() as typeof orgRows;
    responderRows = sqlite
      .prepare(
        `SELECT responder_status, COUNT(*) as count FROM users
         WHERE role IN ('emergency_operator', 'support_organization', 'administrator')
         GROUP BY responder_status`
      )
      .all() as typeof responderRows;
    metrics.recordDbQuery(performance.now() - t0);
  }

  const buildBucket = (simFlag: boolean) => {
    const row = summaryRows.find((r) => Boolean(r.is_sim) === simFlag);
    const cats = catRows
      .filter((c) => Boolean(c.is_sim) === simFlag)
      .map((c) => ({ name: String(c.category), count: Number(c.count) }));
    return {
      total: Number(row?.total || 0),
      active: Number(row?.active || 0),
      resolved: Number(row?.resolved || 0),
      avgAckSeconds: row?.avg_ack_sec != null ? Number(row.avg_ack_sec) : null,
      avgResolutionSeconds: row?.avg_res_sec != null ? Number(row.avg_res_sec) : null,
      byCategory: cats,
    };
  };

  const responderMap: Record<string, number> = { Available: 0, Responding: 0, 'Off Duty': 0 };
  for (const r of responderRows) {
    const st = String(r.responder_status || 'Available');
    responderMap[st] = (responderMap[st] || 0) + Number(r.count);
  }

  const payload = {
    liveStats: buildBucket(false),
    demoStats: buildBucket(true),
    resourceDistribution: orgRows.map((r) => ({ category: r.category, count: Number(r.count) })),
    responders: {
      available: responderMap['Available'] || 0,
      responding: responderMap['Responding'] || 0,
      offDuty: responderMap['Off Duty'] || 0,
    },
  };

  await cacheQueue.setCachedJson(cacheKey, payload, 10);
  return payload;
}

// ========================
// RESPONDER AVAILABILITY & ASSIGNMENT
// ========================
export type ResponderAvailabilityStatus = 'Available' | 'Responding' | 'Off Duty';

export interface ResponderRecord {
  id: number;
  displayName: string;
  email: string;
  role: UserRole;
  responderStatus: ResponderAvailabilityStatus;
  responderUpdatedAt: string;
  activeAssignedCount: number;
}

export async function updateResponderAvailability(
  userId: number,
  status: ResponderAvailabilityStatus
): Promise<ResponderRecord | null> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    await db
      .update(users)
      .set({ responderStatus: status, responderUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
  } else {
    sqlite
      .prepare("UPDATE users SET responder_status = ?, responder_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(status, userId);
  }
  const responders = await listRespondersWithAvailability();
  return responders.find((r) => r.id === userId) || null;
}

export async function listRespondersWithAvailability(): Promise<ResponderRecord[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await pool.query(`
      SELECT u.id, u.display_name, u.email, u.role, u.responder_status, u.responder_updated_at,
             COALESCE(a.cnt, 0)::int AS active_assigned_count
      FROM users u
      LEFT JOIN (
        SELECT operator_user_id, COUNT(*)::int AS cnt
        FROM incident_assignments
        WHERE status = 'active'
        GROUP BY operator_user_id
      ) a ON a.operator_user_id = u.id
      WHERE u.role IN ('emergency_operator', 'support_organization', 'administrator')
      ORDER BY u.id ASC
    `);
    return res.rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      displayName: String(r.display_name || r.email),
      email: String(r.email),
      role: r.role as UserRole,
      responderStatus: (String(r.responder_status || 'Available') as ResponderAvailabilityStatus),
      responderUpdatedAt: r.responder_updated_at ? new Date(String(r.responder_updated_at)).toISOString() : new Date().toISOString(),
      activeAssignedCount: Number(r.active_assigned_count || 0),
    }));
  }

  const rows = sqlite
    .prepare(
      `SELECT u.id, u.display_name, u.email, u.role, u.responder_status, u.responder_updated_at,
              COALESCE((SELECT COUNT(*) FROM incident_assignments ia WHERE ia.operator_user_id = u.id AND ia.status = 'active'), 0) AS active_assigned_count
       FROM users u
       WHERE u.role IN ('emergency_operator', 'support_organization', 'administrator')
       ORDER BY u.id ASC`
    )
    .all() as Record<string, unknown>[];

  return rows.map((r) => ({
    id: Number(r.id),
    displayName: String(r.display_name || r.email),
    email: String(r.email),
    role: r.role as UserRole,
    responderStatus: String(r.responder_status || 'Available') as ResponderAvailabilityStatus,
    responderUpdatedAt: String(r.responder_updated_at || new Date().toISOString()),
    activeAssignedCount: Number(r.active_assigned_count || 0),
  }));
}

export async function assignIncidentToOperator(input: {
  incidentId: number;
  operatorUserId: number;
  assignedByUserId: number;
  assignedByRole: UserRole;
}): Promise<IncidentRecord | null> {
  const targetOp = await getUserById(input.operatorUserId);
  if (!targetOp || !['emergency_operator', 'support_organization', 'administrator'].includes(targetOp.role)) {
    throw new Error('Target responder must be an operator, support organization, or administrator.');
  }

  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(emergencyIncidents)
        .where(eq(emergencyIncidents.id, input.incidentId))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) throw new Error('Incident not found.');

      await tx
        .update(incidentAssignments)
        .set({ status: 'reassigned', completedAt: new Date() })
        .where(and(eq(incidentAssignments.incidentId, input.incidentId), eq(incidentAssignments.status, 'active')));

      await tx.insert(incidentAssignments).values({
        incidentId: input.incidentId,
        operatorUserId: input.operatorUserId,
        assignedByUserId: input.assignedByUserId,
        status: 'active',
      });

      const nextStatus = ['SOS Activated', 'Alert Sent'].includes(existing.status) ? 'Acknowledged' : existing.status;
      await tx
        .update(emergencyIncidents)
        .set({
          acknowledgedByUserId: input.operatorUserId,
          acknowledgedAt: existing.acknowledgedAt || new Date(),
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(emergencyIncidents.id, input.incidentId));

      await tx.insert(incidentUpdates).values({
        incidentId: input.incidentId,
        authorUserId: input.assignedByUserId,
        authorRole: input.assignedByRole,
        previousStatus: existing.status,
        newStatus: nextStatus,
        note: `Incident assigned to responder ${targetOp.displayName || targetOp.email}.`,
        isInternal: false,
      });

      await tx
        .update(users)
        .set({ responderStatus: 'Responding', responderUpdatedAt: new Date() })
        .where(eq(users.id, input.operatorUserId));
    });
    return getIncidentById(input.incidentId);
  }

  runSqliteTransaction(() => {
    const existing = sqlite
      .prepare('SELECT * FROM emergency_incidents WHERE id = ?')
      .get(input.incidentId) as Record<string, unknown> | undefined;
    if (!existing) throw new Error('Incident not found.');

    sqlite
      .prepare("UPDATE incident_assignments SET status = 'reassigned', completed_at = datetime('now') WHERE incident_id = ? AND status = 'active'")
      .run(input.incidentId);

    sqlite
      .prepare("INSERT INTO incident_assignments (incident_id, operator_user_id, assigned_by_user_id, status) VALUES (?, ?, ?, 'active')")
      .run(input.incidentId, input.operatorUserId, input.assignedByUserId);

    const prevStatus = String(existing.status);
    const nextStatus = ['SOS Activated', 'Alert Sent'].includes(prevStatus) ? 'Acknowledged' : prevStatus;
    const ackAt = existing.acknowledged_at ? String(existing.acknowledged_at) : new Date().toISOString();

    sqlite
      .prepare("UPDATE emergency_incidents SET acknowledged_by_user_id = ?, acknowledged_at = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(input.operatorUserId, ackAt, nextStatus, input.incidentId);

    sqlite
      .prepare(
        `INSERT INTO incident_updates (incident_id, author_user_id, author_role, previous_status, new_status, note, is_internal)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        input.incidentId,
        input.assignedByUserId,
        input.assignedByRole,
        prevStatus,
        nextStatus,
        `Incident assigned to responder ${targetOp.displayName || targetOp.email}.`
      );

    sqlite
      .prepare("UPDATE users SET responder_status = 'Responding', responder_updated_at = datetime('now') WHERE id = ?")
      .run(input.operatorUserId);
  });

  return getIncidentById(input.incidentId);
}

// ========================
// LIFE-LINE PULSE: SAFETY JOURNEYS & REPORTS
// ========================
export interface SafetyJourneyRecord {
  id: number;
  userId: number;
  originLabel: string;
  originLat: number;
  originLng: number;
  destinationLabel: string;
  destinationLat: number;
  destinationLng: number;
  travelMode: string;
  selectedRouteSummary: string;
  routeRiskLevel: string;
  shareToken: string;
  sharedWithContacts: Array<{ id?: number; name: string; email?: string }>;
  checkInIntervalMinutes: number;
  expectedArrivalAt: string;
  nextCheckInDueAt: string;
  lastCheckInAt: string | null;
  arrivedAt: string | null;
  status: 'Active' | 'Arrived Safe' | 'Escalated' | 'Cancelled';
  isSimulated: boolean;
  createdAt: string;
  updatedAt: string;
}

function mapJourneyRow(r: Record<string, unknown>): SafetyJourneyRecord {
  const toIso = (val: unknown): string => (val instanceof Date ? val.toISOString() : String(val));
  const rawContacts = r.shared_with_contacts ?? r.sharedWithContacts;
  let parsedContacts: Array<{ id?: number; name: string; email?: string }> = [];
  if (Array.isArray(rawContacts)) {
    parsedContacts = rawContacts as Array<{ id?: number; name: string; email?: string }>;
  } else if (typeof rawContacts === 'string') {
    try {
      parsedContacts = JSON.parse(rawContacts);
    } catch {
      parsedContacts = [];
    }
  }
  return {
    id: Number(r.id),
    userId: Number(r.user_id ?? r.userId),
    originLabel: String(r.origin_label ?? r.originLabel),
    originLat: Number(r.origin_lat ?? r.originLat),
    originLng: Number(r.origin_lng ?? r.originLng),
    destinationLabel: String(r.destination_label ?? r.destinationLabel),
    destinationLat: Number(r.destination_lat ?? r.destinationLat),
    destinationLng: Number(r.destination_lng ?? r.destinationLng),
    travelMode: String(r.travel_mode ?? r.travelMode ?? 'WALK'),
    selectedRouteSummary: String(r.selected_route_summary ?? r.selectedRouteSummary ?? ''),
    routeRiskLevel: String(r.route_risk_level ?? r.routeRiskLevel ?? 'LOW'),
    shareToken: String(r.share_token ?? r.shareToken),
    sharedWithContacts: parsedContacts,
    checkInIntervalMinutes: Number(r.check_in_interval_minutes ?? r.checkInIntervalMinutes ?? 15),
    expectedArrivalAt: toIso(r.expected_arrival_at ?? r.expectedArrivalAt),
    nextCheckInDueAt: toIso(r.next_check_in_due_at ?? r.nextCheckInDueAt),
    lastCheckInAt: r.last_check_in_at ?? r.lastCheckInAt ? toIso(r.last_check_in_at ?? r.lastCheckInAt) : null,
    arrivedAt: r.arrived_at ?? r.arrivedAt ? toIso(r.arrived_at ?? r.arrivedAt) : null,
    status: String(r.status) as SafetyJourneyRecord['status'],
    isSimulated: Boolean(r.is_simulated ?? r.isSimulated),
    createdAt: toIso(r.created_at ?? r.createdAt),
    updatedAt: toIso(r.updated_at ?? r.updatedAt),
  };
}

export async function createSafetyJourney(input: {
  userId: number;
  originLabel: string;
  originLat: number;
  originLng: number;
  destinationLabel: string;
  destinationLat: number;
  destinationLng: number;
  travelMode: string;
  selectedRouteSummary: string;
  routeRiskLevel: string;
  sharedWithContacts: Array<{ id?: number; name: string; email?: string }>;
  checkInIntervalMinutes: number;
  expectedDurationMinutes?: number;
  isSimulated?: boolean;
}): Promise<SafetyJourneyRecord> {
  const dialect = await ensureDialect();
  const now = Date.now();
  const checkInMs = Math.max(5, Math.min(120, input.checkInIntervalMinutes)) * 60 * 1000;
  const arrivalMs = Math.max(10, Math.min(480, input.expectedDurationMinutes ?? input.checkInIntervalMinutes * 2)) * 60 * 1000;
  const expectedArrival = new Date(now + arrivalMs);
  const nextCheckInDue = new Date(now + checkInMs);
  const shareToken = crypto.randomBytes(12).toString('hex');

  if (dialect === 'postgres') {
    const inserted = await db
      .insert(safetyJourneys)
      .values({
        userId: input.userId,
        originLabel: input.originLabel,
        originLat: input.originLat,
        originLng: input.originLng,
        destinationLabel: input.destinationLabel,
        destinationLat: input.destinationLat,
        destinationLng: input.destinationLng,
        travelMode: input.travelMode,
        selectedRouteSummary: input.selectedRouteSummary,
        routeRiskLevel: input.routeRiskLevel,
        shareToken,
        sharedWithContacts: input.sharedWithContacts,
        checkInIntervalMinutes: Math.max(5, Math.min(120, input.checkInIntervalMinutes)),
        expectedArrivalAt: expectedArrival,
        nextCheckInDueAt: nextCheckInDue,
        lastCheckInAt: new Date(now),
        status: 'Active',
        isSimulated: Boolean(input.isSimulated),
      })
      .returning();
    return mapJourneyRow(inserted[0] as unknown as Record<string, unknown>);
  }

  const res = sqlite
    .prepare(
      `INSERT INTO safety_journeys (
         user_id, origin_label, origin_lat, origin_lng, destination_label, destination_lat, destination_lng,
         travel_mode, selected_route_summary, route_risk_level, share_token, shared_with_contacts,
         check_in_interval_minutes, expected_arrival_at, next_check_in_due_at, last_check_in_at, status, is_simulated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`
    )
    .run(
      input.userId,
      input.originLabel,
      input.originLat,
      input.originLng,
      input.destinationLabel,
      input.destinationLat,
      input.destinationLng,
      input.travelMode,
      input.selectedRouteSummary,
      input.routeRiskLevel,
      shareToken,
      JSON.stringify(input.sharedWithContacts),
      Math.max(5, Math.min(120, input.checkInIntervalMinutes)),
      expectedArrival.toISOString(),
      nextCheckInDue.toISOString(),
      new Date(now).toISOString(),
      input.isSimulated ? 1 : 0
    );

  const created = sqlite
    .prepare('SELECT * FROM safety_journeys WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
  return mapJourneyRow(created);
}

export async function getSafetyJourneyById(journeyId: number): Promise<SafetyJourneyRecord | null> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db.select().from(safetyJourneys).where(eq(safetyJourneys.id, journeyId)).limit(1);
    return rows[0] ? mapJourneyRow(rows[0] as unknown as Record<string, unknown>) : null;
  }
  const row = sqlite.prepare('SELECT * FROM safety_journeys WHERE id = ?').get(journeyId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapJourneyRow(row) : null;
}

export async function listSafetyJourneysForUser(userId: number, limit = 25): Promise<SafetyJourneyRecord[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(safetyJourneys)
      .where(eq(safetyJourneys.userId, userId))
      .orderBy(desc(safetyJourneys.createdAt), desc(safetyJourneys.id))
      .limit(limit);
    return rows.map((r) => mapJourneyRow(r as unknown as Record<string, unknown>));
  }
  const rows = sqlite
    .prepare('SELECT * FROM safety_journeys WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map(mapJourneyRow);
}

export async function checkInSafetyJourney(userId: number, journeyId: number): Promise<SafetyJourneyRecord | null> {
  const existing = await getSafetyJourneyById(journeyId);
  if (!existing || existing.userId !== userId) return null;
  const now = new Date();
  const nextDue = new Date(now.getTime() + existing.checkInIntervalMinutes * 60 * 1000);
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const updated = await db
      .update(safetyJourneys)
      .set({ lastCheckInAt: now, nextCheckInDueAt: nextDue, updatedAt: now })
      .where(and(eq(safetyJourneys.id, journeyId), eq(safetyJourneys.userId, userId)))
      .returning();
    return updated[0] ? mapJourneyRow(updated[0] as unknown as Record<string, unknown>) : null;
  }

  sqlite
    .prepare("UPDATE safety_journeys SET last_check_in_at = ?, next_check_in_due_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(now.toISOString(), nextDue.toISOString(), journeyId, userId);
  return getSafetyJourneyById(journeyId);
}

export async function updateSafetyJourneyState(
  userId: number,
  journeyId: number,
  status: 'Arrived Safe' | 'Escalated' | 'Cancelled'
): Promise<SafetyJourneyRecord | null> {
  const existing = await getSafetyJourneyById(journeyId);
  if (!existing || existing.userId !== userId) return null;
  const now = new Date();
  const arrivedAt = status === 'Arrived Safe' ? now : existing.arrivedAt ? new Date(existing.arrivedAt) : null;
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const updated = await db
      .update(safetyJourneys)
      .set({ status, arrivedAt, updatedAt: now })
      .where(and(eq(safetyJourneys.id, journeyId), eq(safetyJourneys.userId, userId)))
      .returning();
    return updated[0] ? mapJourneyRow(updated[0] as unknown as Record<string, unknown>) : null;
  }

  sqlite
    .prepare("UPDATE safety_journeys SET status = ?, arrived_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(status, arrivedAt ? arrivedAt.toISOString() : null, journeyId, userId);
  return getSafetyJourneyById(journeyId);
}

export async function refreshSafetyJourneyRisk(
  userId: number,
  journeyId: number,
  routeSummary: string,
  riskLevel: string
): Promise<SafetyJourneyRecord | null> {
  const existing = await getSafetyJourneyById(journeyId);
  if (!existing || existing.userId !== userId) return null;
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const updated = await db
      .update(safetyJourneys)
      .set({ selectedRouteSummary: routeSummary, routeRiskLevel: riskLevel, updatedAt: new Date() })
      .where(and(eq(safetyJourneys.id, journeyId), eq(safetyJourneys.userId, userId)))
      .returning();
    return updated[0] ? mapJourneyRow(updated[0] as unknown as Record<string, unknown>) : null;
  }

  sqlite
    .prepare("UPDATE safety_journeys SET selected_route_summary = ?, route_risk_level = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(routeSummary, riskLevel, journeyId, userId);
  return getSafetyJourneyById(journeyId);
}

export interface SafetyReportRecord {
  id: number;
  category: string;
  severity: 'LOW' | 'MODERATE' | 'HIGH';
  description: string;
  latitude: number;
  longitude: number;
  locationLabel: string;
  isAnonymous: boolean;
  verificationStatus: string;
  isSimulated: boolean;
  createdAt: string;
  reporterLabel: string;
}

function mapReportRow(r: Record<string, unknown>): SafetyReportRecord {
  const isAnon = Boolean(r.is_anonymous ?? r.isAnonymous ?? true);
  return {
    id: Number(r.id),
    category: String(r.category),
    severity: String(r.severity || 'MODERATE') as SafetyReportRecord['severity'],
    description: String(r.description),
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    locationLabel: String(r.location_label ?? r.locationLabel),
    isAnonymous: isAnon,
    verificationStatus: String(r.verification_status ?? r.verificationStatus ?? 'User Submitted'),
    isSimulated: Boolean(r.is_simulated ?? r.isSimulated),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? r.createdAt),
    reporterLabel: isAnon ? 'Anonymous Community Member' : 'Verified Member Report',
  };
}

export async function createSafetyReport(input: {
  userId: number | null;
  category: string;
  severity: 'LOW' | 'MODERATE' | 'HIGH';
  description: string;
  latitude: number;
  longitude: number;
  locationLabel: string;
  isAnonymous: boolean;
  isSimulated?: boolean;
}): Promise<SafetyReportRecord> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const inserted = await db
      .insert(safetyReports)
      .values({
        userId: input.isAnonymous ? null : input.userId,
        category: input.category,
        severity: input.severity,
        description: input.description,
        latitude: input.latitude,
        longitude: input.longitude,
        locationLabel: input.locationLabel,
        isAnonymous: input.isAnonymous,
        verificationStatus: 'User Submitted',
        isSimulated: Boolean(input.isSimulated),
      })
      .returning();
    return mapReportRow(inserted[0] as unknown as Record<string, unknown>);
  }

  const res = sqlite
    .prepare(
      `INSERT INTO safety_reports (user_id, category, severity, description, latitude, longitude, location_label, is_anonymous, verification_status, is_simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'User Submitted', ?)`
    )
    .run(
      input.isAnonymous ? null : input.userId,
      input.category,
      input.severity,
      input.description,
      input.latitude,
      input.longitude,
      input.locationLabel,
      input.isAnonymous ? 1 : 0,
      input.isSimulated ? 1 : 0
    );

  const created = sqlite
    .prepare('SELECT * FROM safety_reports WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
  return mapReportRow(created);
}

export async function listSafetyReportsForPulse(limit = 100): Promise<SafetyReportRecord[]> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select()
      .from(safetyReports)
      .orderBy(desc(safetyReports.createdAt), desc(safetyReports.id))
      .limit(limit);
    return rows.map((r) => mapReportRow(r as unknown as Record<string, unknown>));
  }
  const rows = sqlite
    .prepare('SELECT * FROM safety_reports ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapReportRow);
}

export async function listIncidentsForPulse(limit = 150) {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const rows = await db
      .select({
        id: emergencyIncidents.id,
        category: emergencyIncidents.category,
        priority: emergencyIncidents.priority,
        status: emergencyIncidents.status,
        latitude: emergencyIncidents.latitude,
        longitude: emergencyIncidents.longitude,
        isSimulated: emergencyIncidents.isSimulated,
        createdAt: emergencyIncidents.createdAt,
      })
      .from(emergencyIncidents)
      .orderBy(desc(emergencyIncidents.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      priority: r.priority,
      status: r.status,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      isSimulated: r.isSimulated,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  const rows = sqlite
    .prepare(
      'SELECT id, category, priority, status, latitude, longitude, is_simulated, created_at FROM emergency_incidents ORDER BY created_at DESC LIMIT ?'
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    category: String(r.category),
    priority: String(r.priority),
    status: String(r.status),
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
    isSimulated: Boolean(r.is_simulated),
    createdAt: String(r.created_at),
  }));
}

// ========================
// SHARED CLUSTER RUNTIME SECRET & PERSISTENT REALTIME EVENT LOG
// ========================
export async function getOrInitSharedRuntimeSessionSecret(): Promise<string> {
  const dialect = await ensureDialect();
  const generated = crypto.randomBytes(32).toString('hex');
  const KEY_NAME = 'session_signing_secret';

  if (dialect === 'postgres') {
    await queryWithRetry(
      `CREATE TABLE IF NOT EXISTS system_runtime_config (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await queryWithRetry(
      `INSERT INTO system_runtime_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [KEY_NAME, generated]
    );
    const res = await queryWithRetry<{ value: string }>(
      'SELECT value FROM system_runtime_config WHERE key = $1 LIMIT 1',
      [KEY_NAME]
    );
    return res.rows[0]?.value || generated;
  }

  sqlite
    .prepare('INSERT OR IGNORE INTO system_runtime_config (key, value) VALUES (?, ?)')
    .run(KEY_NAME, generated);
  const row = sqlite
    .prepare('SELECT value FROM system_runtime_config WHERE key = ? LIMIT 1')
    .get(KEY_NAME) as { value?: string } | undefined;
  return row?.value || generated;
}

export interface PersistedRealtimeEventRecord {
  seq: number;
  eventId: string;
  targetUserId: number | null;
  includeOperators: boolean;
  userPayload: Record<string, unknown>;
  operatorPayload: Record<string, unknown>;
}

export async function recordRealtimeEvent(input: {
  eventId: string;
  targetUserId?: number;
  includeOperators: boolean;
  userPayload: Record<string, unknown>;
  operatorPayload: Record<string, unknown>;
}): Promise<PersistedRealtimeEventRecord> {
  const dialect = await ensureDialect();

  if (dialect === 'postgres') {
    const res = await queryWithRetry<{ id: number }>(
      `INSERT INTO realtime_events (event_id, target_user_id, include_operators, user_payload, operator_payload)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
       RETURNING id`,
      [
        input.eventId,
        input.targetUserId ?? null,
        input.includeOperators,
        JSON.stringify(input.userPayload),
        JSON.stringify(input.operatorPayload),
      ]
    );
    const seq = Number(res.rows[0].id);
    const userMsg = { ...input.userPayload, seq, eventId: input.eventId };
    const opMsg = { ...input.operatorPayload, seq, eventId: input.eventId };
    await queryWithRetry(
      'UPDATE realtime_events SET user_payload = $1::jsonb, operator_payload = $2::jsonb WHERE id = $3',
      [JSON.stringify(userMsg), JSON.stringify(opMsg), seq]
    );
    return {
      seq,
      eventId: input.eventId,
      targetUserId: input.targetUserId ?? null,
      includeOperators: input.includeOperators,
      userPayload: userMsg,
      operatorPayload: opMsg,
    };
  }

  const res = sqlite
    .prepare(
      `INSERT INTO realtime_events (event_id, target_user_id, include_operators, user_payload, operator_payload)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.eventId,
      input.targetUserId ?? null,
      input.includeOperators ? 1 : 0,
      JSON.stringify(input.userPayload),
      JSON.stringify(input.operatorPayload)
    );
  const seq = Number(res.lastInsertRowid);
  const userMsg = { ...input.userPayload, seq, eventId: input.eventId };
  const opMsg = { ...input.operatorPayload, seq, eventId: input.eventId };
  sqlite
    .prepare('UPDATE realtime_events SET user_payload = ?, operator_payload = ? WHERE id = ?')
    .run(JSON.stringify(userMsg), JSON.stringify(opMsg), seq);
  return {
    seq,
    eventId: input.eventId,
    targetUserId: input.targetUserId ?? null,
    includeOperators: input.includeOperators,
    userPayload: userMsg,
    operatorPayload: opMsg,
  };
}

export async function getLatestRealtimeEventSeq(): Promise<number> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await queryWithRetry<{ max_id: number | null }>('SELECT MAX(id)::int AS max_id FROM realtime_events');
    return Number(res.rows[0]?.max_id || 0);
  }
  const row = sqlite.prepare('SELECT MAX(id) AS max_id FROM realtime_events').get() as { max_id: number | null } | undefined;
  return Number(row?.max_id || 0);
}

export async function listRealtimeEventsSince(
  sinceSeq: number,
  viewerUserId: number,
  isOperator: boolean,
  limit = 200
): Promise<Array<{ seq: number; payload: Record<string, unknown> }>> {
  const dialect = await ensureDialect();
  if (dialect === 'postgres') {
    const res = await queryWithRetry<{
      id: number;
      target_user_id: number | null;
      include_operators: boolean;
      user_payload: Record<string, unknown>;
      operator_payload: Record<string, unknown>;
    }>(
      `SELECT id, target_user_id, include_operators, user_payload, operator_payload
       FROM realtime_events
       WHERE id > $1 AND ((include_operators = TRUE AND $3 = TRUE) OR target_user_id = $2)
       ORDER BY id ASC
       LIMIT $4`,
      [sinceSeq, viewerUserId, isOperator, limit]
    );
    return res.rows.map((r) => ({
      seq: Number(r.id),
      payload: r.include_operators && isOperator ? r.operator_payload : r.user_payload,
    }));
  }

  const rows = sqlite
    .prepare(
      `SELECT id, target_user_id, include_operators, user_payload, operator_payload
       FROM realtime_events
       WHERE id > ? AND ((include_operators = 1 AND ? = 1) OR target_user_id = ?)
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(sinceSeq, isOperator ? 1 : 0, viewerUserId, limit) as Array<{
    id: number;
    target_user_id: number | null;
    include_operators: number;
    user_payload: string;
    operator_payload: string;
  }>;

  return rows.map((r) => ({
    seq: Number(r.id),
    payload: JSON.parse(r.include_operators && isOperator ? r.operator_payload : r.user_payload) as Record<
      string,
      unknown
    >,
  }));
}


