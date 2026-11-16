import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(crypto.pbkdf2);

const resolvedDbPath = process.env.LIFELINE_DB_PATH
  ? path.resolve(process.env.LIFELINE_DB_PATH)
  : path.resolve(process.cwd(), '.data', 'lifeline.db');

const dbDir = path.dirname(resolvedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new DatabaseSync(resolvedDbPath);
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA synchronous = NORMAL;');
sqlite.exec('PRAGMA busy_timeout = 5000;');
sqlite.exec('PRAGMA cache_size = -16000;');
sqlite.exec('PRAGMA temp_store = MEMORY;');
sqlite.exec('PRAGMA mmap_size = 67108864;');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${derived}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await pbkdf2Async(password, salt, 100000, 64, 'sha512')).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, original] = parts;
  if (!salt || !original) return false;
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(original, 'hex'));
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, original] = parts;
  if (!salt || !original) return false;
  const derived = (await pbkdf2Async(password, salt, 100000, 64, 'sha512')).toString('hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(original, 'hex'));
}

export function hashOneTimeCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

export function verifyOneTimeCode(code: string, storedHash: string): boolean {
  if (!code || !storedHash) return false;
  const candidate = hashOneTimeCode(code);
  if (candidate.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(storedHash, 'hex'));
}

export function runSqliteTransaction<T>(fn: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    sqlite.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK;');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

function getTableColumns(tableName: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function ensureColumn(tableName: string, columnName: string, ddlFragment: string) {
  const cols = getTableColumns(tableName);
  if (!cols.has(columnName)) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddlFragment};`);
  }
}

export function runSqliteMigrations(): string {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = sqlite.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  if (!applied.has('v1_initial_schema')) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'regular_user',
        password_hash TEXT NOT NULL DEFAULT '',
        email_verified INTEGER NOT NULL DEFAULT 0,
        verification_code TEXT NOT NULL DEFAULT '',
        reset_code TEXT NOT NULL DEFAULT '',
        is_demo_account INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

      CREATE TABLE IF NOT EXISTS user_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        emergency_notes TEXT NOT NULL DEFAULT '',
        medical_notes TEXT NOT NULL DEFAULT '',
        blood_type TEXT NOT NULL DEFAULT '',
        preferred_language TEXT NOT NULL DEFAULT 'en',
        safety_status TEXT NOT NULL DEFAULT 'Safe',
        last_known_lat REAL,
        last_known_lng REAL,
        last_location_label TEXT NOT NULL DEFAULT '',
        location_sharing_consent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS trusted_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'Trusted Contact',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notify_email INTEGER NOT NULL DEFAULT 1,
        notify_sms INTEGER NOT NULL DEFAULT 0,
        notify_whatsapp INTEGER NOT NULL DEFAULT 0,
        priority_order INTEGER NOT NULL DEFAULT 1,
        is_verified INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS trusted_contacts_user_idx ON trusted_contacts(user_id);

      CREATE TABLE IF NOT EXISTS emergency_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Personal Safety',
        status TEXT NOT NULL DEFAULT 'SOS Activated',
        priority TEXT NOT NULL DEFAULT 'HIGH',
        latitude REAL,
        longitude REAL,
        location_label TEXT NOT NULL DEFAULT 'Location pending',
        location_accuracy_meters INTEGER,
        is_simulated INTEGER NOT NULL DEFAULT 0,
        acknowledged_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        acknowledged_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS incidents_user_idx ON emergency_incidents(user_id);
      CREATE INDEX IF NOT EXISTS incidents_status_idx ON emergency_incidents(status);

      CREATE TABLE IF NOT EXISTS incident_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_role TEXT NOT NULL DEFAULT 'system',
        previous_status TEXT NOT NULL DEFAULT '',
        new_status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        is_internal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS incident_updates_incident_idx ON incident_updates(incident_id);

      CREATE TABLE IF NOT EXISTS incident_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        operator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active',
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS support_organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        website TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        verification_status TEXT NOT NULL DEFAULT 'Sample Directory',
        source TEXT NOT NULL DEFAULT 'LIFE-LINE Verified Demo Registry',
        is_sample_data INTEGER NOT NULL DEFAULT 1,
        last_verified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS support_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL REFERENCES support_organizations(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        operating_hours TEXT NOT NULL DEFAULT '24/7',
        is_24_hours INTEGER NOT NULL DEFAULT 1,
        availability_note TEXT NOT NULL DEFAULT 'Confirm availability by phone',
        google_place_id TEXT NOT NULL DEFAULT '',
        last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE SET NULL,
        channel TEXT NOT NULL DEFAULT 'in_app',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'safety',
        is_read INTEGER NOT NULL DEFAULT 0,
        is_simulated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);

      CREATE TABLE IF NOT EXISTS notification_delivery_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        channel TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'internal',
        status TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        error_message TEXT NOT NULL DEFAULT '',
        external_message_id TEXT NOT NULL DEFAULT '',
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ai_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        model_used TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
        input_summary TEXT NOT NULL,
        urgency_level TEXT NOT NULL DEFAULT 'MEDIUM',
        classification TEXT NOT NULL DEFAULT 'General Safety',
        assigned_priority TEXT NOT NULL DEFAULT 'MEDIUM',
        confidence_score REAL NOT NULL DEFAULT 0.75,
        rationale TEXT NOT NULL,
        missing_info_questions TEXT NOT NULL DEFAULT '[]',
        uncertainty_notes TEXT NOT NULL DEFAULT '',
        escalate_to_human INTEGER NOT NULL DEFAULT 0,
        raw_structured_output TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ai_recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assessment_id INTEGER REFERENCES ai_assessments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        incident_id INTEGER REFERENCES emergency_incidents(id) ON DELETE SET NULL,
        agent_name TEXT NOT NULL,
        title TEXT NOT NULL,
        recommendation_text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Practical Safety',
        confidence REAL NOT NULL DEFAULT 0.8,
        source_citation TEXT NOT NULL DEFAULT 'LIFE-LINE Safety Protocol',
        action_required_auth INTEGER NOT NULL DEFAULT 0,
        is_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_email TEXT NOT NULL DEFAULT 'system',
        actor_role TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'dark',
        enable_email_alerts INTEGER NOT NULL DEFAULT 1,
        enable_sms_alerts INTEGER NOT NULL DEFAULT 0,
        enable_in_app_alerts INTEGER NOT NULL DEFAULT 1,
        location_consent_mode TEXT NOT NULL DEFAULT 'sos_only',
        data_retention_days INTEGER NOT NULL DEFAULT 90,
        demo_mode_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES ('v1_initial_schema')").run();
  }

  if (!applied.has('v2_auth_code_security_columns')) {
    runSqliteTransaction(() => {
      ensureColumn('users', 'verification_code_hash', "verification_code_hash TEXT NOT NULL DEFAULT ''");
      ensureColumn('users', 'verification_code_expires_at', 'verification_code_expires_at TEXT');
      ensureColumn('users', 'verification_attempts', 'verification_attempts INTEGER NOT NULL DEFAULT 0');
      ensureColumn('users', 'reset_code_hash', "reset_code_hash TEXT NOT NULL DEFAULT ''");
      ensureColumn('users', 'reset_code_expires_at', 'reset_code_expires_at TEXT');
      ensureColumn('users', 'reset_attempts', 'reset_attempts INTEGER NOT NULL DEFAULT 0');

      // Migrate any legacy plaintext verification/reset codes to SHA-256 hashes and clear plaintext columns
      const userCols = getTableColumns('users');
      if (userCols.has('verification_code')) {
        const legacyRows = sqlite
          .prepare("SELECT id, verification_code, reset_code FROM users WHERE verification_code != '' OR reset_code != ''")
          .all() as Array<{ id: number; verification_code: string; reset_code: string }>;
        for (const r of legacyRows) {
          const vHash = r.verification_code ? hashOneTimeCode(r.verification_code) : '';
          const rHash = r.reset_code ? hashOneTimeCode(r.reset_code) : '';
          const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          sqlite
            .prepare(
              `UPDATE users SET
                verification_code_hash = CASE WHEN ? != '' THEN ? ELSE verification_code_hash END,
                verification_code_expires_at = CASE WHEN ? != '' THEN ? ELSE verification_code_expires_at END,
                verification_code = '',
                reset_code_hash = CASE WHEN ? != '' THEN ? ELSE reset_code_hash END,
                reset_code_expires_at = CASE WHEN ? != '' THEN ? ELSE reset_code_expires_at END,
                reset_code = ''
               WHERE id = ?`
            )
            .run(vHash, vHash, vHash, expires, rHash, rHash, rHash, expires, r.id);
        }
      }
      sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES ('v2_auth_code_security_columns')").run();
    });
  }

  if (!applied.has('v3_sos_idempotency_and_delivery')) {
    runSqliteTransaction(() => {
      ensureColumn('emergency_incidents', 'idempotency_key', 'idempotency_key TEXT');
      ensureColumn('emergency_incidents', 'client_queued_at', 'client_queued_at TEXT');
      ensureColumn('emergency_incidents', 'delivery_status', "delivery_status TEXT NOT NULL DEFAULT 'submitted'");
      sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS incidents_user_idempotency_idx
        ON emergency_incidents(user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND idempotency_key != '';
      `);
      sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES ('v3_sos_idempotency_and_delivery')").run();
    });
  }

  if (!applied.has('v4_pulse_journeys_reports_responders')) {
    runSqliteTransaction(() => {
      ensureColumn('users', 'responder_status', "responder_status TEXT NOT NULL DEFAULT 'Available'");
      ensureColumn('users', 'responder_updated_at', "responder_updated_at TEXT NOT NULL DEFAULT ''");
      sqlite.exec(`
        UPDATE users
        SET responder_updated_at = COALESCE(NULLIF(responder_updated_at, ''), updated_at, datetime('now'))
        WHERE responder_updated_at = '';

        CREATE TABLE IF NOT EXISTS safety_journeys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          origin_label TEXT NOT NULL,
          origin_lat REAL NOT NULL,
          origin_lng REAL NOT NULL,
          destination_label TEXT NOT NULL,
          destination_lat REAL NOT NULL,
          destination_lng REAL NOT NULL,
          travel_mode TEXT NOT NULL DEFAULT 'WALK',
          selected_route_summary TEXT NOT NULL DEFAULT '',
          route_risk_level TEXT NOT NULL DEFAULT 'LOW',
          share_token TEXT NOT NULL,
          shared_with_contacts TEXT NOT NULL DEFAULT '[]',
          check_in_interval_minutes INTEGER NOT NULL DEFAULT 15,
          expected_arrival_at TEXT NOT NULL,
          next_check_in_due_at TEXT NOT NULL,
          last_check_in_at TEXT,
          arrived_at TEXT,
          status TEXT NOT NULL DEFAULT 'Active',
          is_simulated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS safety_journeys_user_idx ON safety_journeys(user_id);
        CREATE INDEX IF NOT EXISTS safety_journeys_status_idx ON safety_journeys(status);

        CREATE TABLE IF NOT EXISTS safety_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'MODERATE',
          description TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          location_label TEXT NOT NULL,
          is_anonymous INTEGER NOT NULL DEFAULT 1,
          verification_status TEXT NOT NULL DEFAULT 'User Submitted',
          is_simulated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS safety_reports_created_idx ON safety_reports(created_at);
        CREATE INDEX IF NOT EXISTS safety_reports_coords_idx ON safety_reports(latitude, longitude);
      `);
      sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES ('v4_pulse_journeys_reports_responders')").run();
    });
  }

  if (!applied.has('v5_scalability_indexes')) {
    runSqliteTransaction(() => {
      sqlite.exec(`
        CREATE INDEX IF NOT EXISTS incidents_user_created_idx ON emergency_incidents(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS incidents_sim_status_created_idx ON emergency_incidents(is_simulated, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS notifications_user_read_created_idx ON notifications(user_id, is_read, created_at DESC);
        CREATE INDEX IF NOT EXISTS safety_reports_sim_created_idx ON safety_reports(is_simulated, created_at DESC);
        CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

        CREATE TABLE IF NOT EXISTS system_runtime_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS realtime_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          target_user_id INTEGER,
          include_operators INTEGER NOT NULL DEFAULT 0,
          user_payload TEXT NOT NULL,
          operator_payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS realtime_events_target_idx ON realtime_events(target_user_id, id);
      `);
      sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES ('v5_scalability_indexes')").run();
    });
  }

  const latest = sqlite
    .prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
    .get() as { version: string } | undefined;
  return latest?.version || 'v5_scalability_indexes';
}

export function seedSqliteInitialData() {
  const orgCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM support_organizations').get() as { cnt: number };
  if (orgCount.cnt === 0) {
    runSqliteTransaction(() => {
      const insertOrg = sqlite.prepare(`
        INSERT INTO support_organizations (name, category, phone, website, email, verification_status, source, is_sample_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const insertLoc = sqlite.prepare(`
        INSERT INTO support_locations (organization_id, address, city, region, latitude, longitude, operating_hours, is_24_hours, availability_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const seedOrgs = [
        {
          name: 'National Domestic Violence Hotline (Sample Reference)',
          category: 'Government Helpline',
          phone: '1-800-799-7233',
          website: 'https://www.thehotline.org',
          email: 'support@example-hotline.org',
          verificationStatus: 'Public Directory (Sample)',
          source: 'Sample Safety Helpline Registry',
          address: 'National Toll-Free Helpline · Text START to 88788',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7749,
          lng: -122.4194,
          hours: '24/7 Confidential Support',
          is24: 1,
          note: 'Sample reference listing — verify local emergency numbers (911/112) in crisis.',
        },
        {
          name: 'Zuckerberg SF General Emergency Center (Sample)',
          category: 'Hospital',
          phone: '(628) 206-8000',
          website: 'https://zuckerbergsanfranciscogeneral.org',
          email: 'emergency-info@example-hospital.org',
          verificationStatus: 'Sample Directory',
          source: 'Sample Public Hospital Dataset',
          address: '1001 Potrero Ave, San Francisco, CA 94110',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7555,
          lng: -122.4045,
          hours: '24/7 Emergency Department',
          is24: 1,
          note: 'Use live Google Maps search for real-time hospital status near your exact GPS location.',
        },
        {
          name: 'Bay Area Women & Youth Safe Haven (Demo)',
          category: 'Womens Support',
          phone: '(415) 555-0142',
          website: 'https://example-safehaven.org',
          email: 'intake@example-safehaven.org',
          verificationStatus: 'Demo Partner',
          source: 'LIFE-LINE Hackathon Demo Registry',
          address: '445 Valencia St, San Francisco, CA 94103',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7656,
          lng: -122.4218,
          hours: 'Mon-Sun 08:00 - 22:00 (24/7 Crisis Line)',
          is24: 0,
          note: 'Demo support shelter entry for hackathon walkthroughs.',
        },
        {
          name: 'Larkin Street Youth Support Hub (Sample)',
          category: 'Youth Support',
          phone: '(800) 669-6196',
          website: 'https://example-youthhub.org',
          email: 'youth@example-youthhub.org',
          verificationStatus: 'Sample Directory',
          source: 'LIFE-LINE Hackathon Demo Registry',
          address: '134 Golden Gate Ave, San Francisco, CA 94102',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7819,
          lng: -122.4126,
          hours: '24/7 Youth Drop-In & Counselling',
          is24: 1,
          note: 'Sample youth safe space entry; confirm live hours via Google Maps search.',
        },
        {
          name: 'Civic Crisis Response & Counselling Center (Demo)',
          category: 'Counselling',
          phone: '988 (Crisis Lifeline)',
          website: 'https://988lifeline.org',
          email: 'counselling@example-crisis.org',
          verificationStatus: 'Public Directory (Sample)',
          source: 'Sample Crisis Counselling Registry',
          address: '870 Market St, Suite 400, San Francisco, CA 94102',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7848,
          lng: -122.4071,
          hours: '24/7 Multilingual Counselling',
          is24: 1,
          note: 'Dial or text 988 in the US/Canada for immediate crisis counselling.',
        },
        {
          name: 'Mission District Community Safe Refuge (Demo)',
          category: 'Shelter',
          phone: '(415) 555-0198',
          website: 'https://example-refuge.org',
          email: 'shelter@example-refuge.org',
          verificationStatus: 'Demo Partner',
          source: 'LIFE-LINE Hackathon Demo Registry',
          address: '2190 Mission St, San Francisco, CA 94110',
          city: 'San Francisco',
          region: 'CA',
          lat: 37.7618,
          lng: -122.4193,
          hours: '24/7 Intake Desk',
          is24: 1,
          note: 'Simulated shelter capacity data for hackathon evaluation.',
        },
      ];

      for (const org of seedOrgs) {
        const res = insertOrg.run(
          org.name,
          org.category,
          org.phone,
          org.website,
          org.email,
          org.verificationStatus,
          org.source
        );
        const orgId = Number(res.lastInsertRowid);
        insertLoc.run(
          orgId,
          org.address,
          org.city,
          org.region,
          org.lat,
          org.lng,
          org.hours,
          org.is24,
          org.note
        );
      }
    });
  }

  const userCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (userCount.cnt === 0) {
    runSqliteTransaction(() => {
      const demoPass = hashPassword('LifelineDemo2026!');
      const insertUser = sqlite.prepare(`
        INSERT INTO users (uid, email, display_name, role, password_hash, email_verified, is_demo_account)
        VALUES (?, ?, ?, ?, ?, 1, 1)
      `);
      const insertProfile = sqlite.prepare(`
        INSERT INTO user_profiles (user_id, full_name, phone, emergency_notes, preferred_language, safety_status, last_known_lat, last_known_lng, last_location_label, location_sharing_consent)
        VALUES (?, ?, ?, ?, 'en', 'Safe', 37.7749, -122.4194, 'San Francisco, CA (Demo Default)', 1)
      `);
      const insertPref = sqlite.prepare(`
        INSERT INTO user_preferences (user_id, theme, demo_mode_enabled) VALUES (?, 'dark', 1)
      `);

      const demoAccounts = [
        {
          uid: 'demo-user-maya',
          email: 'maya.demo@lifeline-ai.demo',
          name: 'Maya Lin (Demo User)',
          role: 'regular_user',
          phone: '+1-415-555-0101',
          notes: 'Allergic to penicillin. Prefers silent text check-ins during late commute.',
        },
        {
          uid: 'demo-operator-elena',
          email: 'operator.demo@lifeline-ai.demo',
          name: 'Elena Vance (Demo Operator)',
          role: 'emergency_operator',
          phone: '+1-415-555-0190',
          notes: 'Shift Lead — Youth & Women Rapid Safety Desk',
        },
        {
          uid: 'demo-org-safehaven',
          email: 'partner.demo@lifeline-ai.demo',
          name: 'Safe Haven Coordinator (Demo Org)',
          role: 'support_organization',
          phone: '+1-415-555-0142',
          notes: 'Verified Partner Intake Desk',
        },
        {
          uid: 'demo-admin-console',
          email: 'admin.demo@lifeline-ai.demo',
          name: 'System Governance Admin (Demo)',
          role: 'administrator',
          phone: '+1-415-555-0199',
          notes: 'Audit & RBAC Governance Account',
        },
      ];

      let mayaId = 1;
      for (const acc of demoAccounts) {
        const res = insertUser.run(acc.uid, acc.email, acc.name, acc.role, demoPass);
        const userId = Number(res.lastInsertRowid);
        if (acc.uid === 'demo-user-maya') mayaId = userId;
        insertProfile.run(userId, acc.name, acc.phone, acc.notes);
        insertPref.run(userId);
      }

      const insertContact = sqlite.prepare(`
        INSERT INTO trusted_contacts (user_id, name, relationship, email, phone, notify_email, notify_sms, priority_order, is_verified, source)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, 'demo_seed')
      `);
      insertContact.run(mayaId, 'Priya Sharma (Demo Contact)', 'Sister', 'priya.demo@example.com', '+1-415-555-0112', 1);
      insertContact.run(mayaId, 'Campus Security Desk (Demo)', 'University Escort', 'campus.safety@example.edu', '+1-415-555-0188', 2);

      const incRes = sqlite
        .prepare(
          `INSERT INTO emergency_incidents (user_id, delivery_status, title, description, category, status, priority, latitude, longitude, location_label, location_accuracy_meters, is_simulated)
           VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          mayaId,
          'Simulated Late-Night Transit Check-In Alert',
          'Sample simulated incident: User reported feeling followed near transit stop and requested safety routing + trusted contact check-in.',
          'Commute Safety',
          'Alert Sent',
          'HIGH',
          37.7765,
          -122.4167,
          'Market & 8th St Transit Corridor (Simulated)',
          18
        );
      const incId = Number(incRes.lastInsertRowid);

      sqlite
        .prepare(
          `INSERT INTO incident_updates (incident_id, author_user_id, author_role, previous_status, new_status, note)
           VALUES (?, ?, 'regular_user', 'SOS Activated', 'Alert Sent', 'Simulated SOS triggered for hackathon evaluation. Trusted contacts notified in sandbox.')`
        )
        .run(incId, mayaId);
    });
  }
}

runSqliteMigrations();
seedSqliteInitialData();

export { sqlite, resolvedDbPath };
