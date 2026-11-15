import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-db-test-'));
const dbPath = path.join(tempDir, 'legacy-upgrade.db');

// Create a pre-hardening legacy SQLite DB missing new security & SOS idempotency columns
const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
  CREATE TABLE users (
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
  INSERT INTO users (uid, email, display_name, verification_code, reset_code)
  VALUES ('legacy-uid-1', 'legacy@example.com', 'Legacy User', '123456', '654321');

  CREATE TABLE emergency_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Personal Safety',
    status TEXT NOT NULL DEFAULT 'SOS Activated',
    priority TEXT NOT NULL DEFAULT 'CRITICAL',
    latitude REAL,
    longitude REAL,
    location_label TEXT NOT NULL DEFAULT '',
    location_accuracy_meters INTEGER,
    is_simulated INTEGER NOT NULL DEFAULT 0,
    acknowledged_by_user_id INTEGER REFERENCES users(id),
    acknowledged_at TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
legacyDb.close();

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

describe('Database Integrity, Safe Migrations & Authoritative Persistence', () => {
  let shutdown: (() => Promise<void>) | undefined;

  after(async () => {
    if (shutdown) await shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('safely migrates legacy schema without data loss and persists relational records consistently', async () => {
    const repo = await import('../src/db/repository.ts');
    const localStore = await import('../src/db/local-store.ts');
    const serverMod = await import('../server.ts');

    const srv = await serverMod.createAppServer({ enableVite: false });
    shutdown = srv.shutdown;

    let baseUrl = '';
    await new Promise<void>((resolve) => {
      srv.httpServer.listen(0, '127.0.0.1', () => {
        const addr = srv.httpServer.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    // Verify migrations recorded
    const migrations = localStore.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: string }>;
    const versions = migrations.map((m) => m.version);
    assert.deepEqual(versions, [
      'v1_initial_schema',
      'v2_auth_code_security_columns',
      'v3_sos_idempotency_and_delivery',
      'v4_pulse_journeys_reports_responders',
    ]);

    // Verify legacy row preserved and legacy plaintext codes hashed into verification_code_hash
    const legacyRow = localStore.sqlite
      .prepare('SELECT email, verification_code_hash, reset_code_hash FROM users WHERE uid = ?')
      .get('legacy-uid-1') as { email: string; verification_code_hash: string; reset_code_hash: string };
    assert.equal(legacyRow.email, 'legacy@example.com');
    assert.ok(localStore.verifyOneTimeCode('123456', legacyRow.verification_code_hash));
    assert.ok(localStore.verifyOneTimeCode('654321', legacyRow.reset_code_hash));

    // Verify health endpoints report single authoritative backend cleanly
    const healthResp = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResp.status, 200);
    const healthBody = (await healthResp.json()) as {
      status: string;
      database: { ok: boolean; dialect: string; migrationVersion: string; tablesVerified: number };
    };
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.database.ok, true);
    assert.equal(healthBody.database.dialect, 'sqlite');
    assert.equal(healthBody.database.migrationVersion, 'v4_pulse_journeys_reports_responders');
    assert.ok(healthBody.database.tablesVerified >= 13);

    // Verify full persistence roundtrip for user, profile, contact, SOS, notification, and audit log
    const regResp = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'persist.check@example.com',
        password: 'Password123!',
        displayName: 'Persist Check',
      }),
    });
    const regData = (await regResp.json()) as { user: { id: number }; token: string };

    await fetch(`${baseUrl}/api/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({
        phone: '+15550199',
        safetyStatus: 'Cautious',
        lastKnownLat: 37.7749,
        lastKnownLng: -122.4194,
      }),
    });

    await fetch(`${baseUrl}/api/contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({
        name: 'Trusted Guardian',
        email: 'guardian@example.com',
        phone: '+15550100',
      }),
    });

    await fetch(`${baseUrl}/api/incidents/sos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({
        idempotencyKey: 'sos_persist_test_001',
        title: 'Persistence Check SOS',
        latitude: 37.7749,
        longitude: -122.4194,
      }),
    });

    const profile = await repo.getUserProfile(regData.user.id);
    const contacts = await repo.listTrustedContacts(regData.user.id);
    const incidents = await repo.listIncidentsForUser(regData.user.id);
    const notifications = await repo.listNotificationsForUser(regData.user.id);
    const auditLogs = await repo.listAuditLogs(20);

    assert.equal(profile.profile?.safetyStatus, 'Cautious');
    assert.equal(contacts.length, 1);
    assert.equal(incidents.length, 1);
    assert.ok(notifications.length >= 1);
    assert.ok(auditLogs.some((a) => a.actorEmail === 'persist.check@example.com' && a.action === 'SOS_ACTIVATED'));
  });
});
