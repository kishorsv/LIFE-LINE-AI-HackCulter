import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-auth-test-'));
const dbPath = path.join(tempDir, 'auth-test.db');

process.env.LIFELINE_NO_AUTOSTART = 'true';
process.env.DB_DRIVER = 'sqlite';
process.env.LIFELINE_DB_PATH = dbPath;
process.env.SESSION_SECRET = 'test-production-grade-session-secret-0123456789abcdef';

describe('Authentication, RBAC & Security Hardening', () => {
  let baseUrl = '';
  let shutdown: () => Promise<void>;
  let authMod: typeof import('../src/middleware/auth.ts');
  let repoMod: typeof import('../src/db/repository.ts');
  let rateLimitMod: typeof import('../src/middleware/rateLimit.ts');

  before(async () => {
    authMod = await import('../src/middleware/auth.ts');
    repoMod = await import('../src/db/repository.ts');
    rateLimitMod = await import('../src/middleware/rateLimit.ts');
    const serverMod = await import('../server.ts');

    const srv = await serverMod.createAppServer({
      enableVite: false,
      firebaseVerifier: {
        verifyIdToken: async (token: string) => {
          if (token === 'valid-firebase-id-token-0123456789') {
            return {
              uid: 'fb-uid-verified-1',
              email: 'google.verified@example.com',
              name: 'Google Verified User',
              email_verified: true,
            };
          }
          if (token === 'unverified-firebase-token-0123456789') {
            return {
              uid: 'fb-uid-unverified-2',
              email: 'citizen@example.com',
              name: 'Spoof Attempt',
              email_verified: false,
            };
          }
          throw new Error('Invalid Firebase ID token');
        },
      },
    });
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

  it('enforces strong SESSION_SECRET in production and rejects weak defaults', () => {
    assert.throws(() => {
      authMod.resolveSessionSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    }, /SESSION_SECRET/);

    assert.throws(() => {
      authMod.resolveSessionSecret({
        NODE_ENV: 'production',
        SESSION_SECRET: 'lifeline-ai-dev-session-secret',
      } as NodeJS.ProcessEnv);
    }, /SESSION_SECRET/);

    assert.throws(() => {
      authMod.resolveSessionSecret({
        NODE_ENV: 'production',
        SESSION_SECRET: 'too-short-secret',
      } as NodeJS.ProcessEnv);
    }, /32/);

    const strong = 'a-very-strong-production-secret-at-least-32-chars';
    assert.equal(
      authMod.resolveSessionSecret({ NODE_ENV: 'production', SESSION_SECRET: strong } as NodeJS.ProcessEnv),
      strong
    );
  });

  it('locks public registration to regular_user and blocks operator/org/admin self-registration with audit logs', async () => {
    for (const attemptedRole of ['emergency_operator', 'support_organization', 'administrator']) {
      const resp = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `elevated.${attemptedRole}@example.com`,
          password: 'Password123!',
          displayName: 'Elevated Attacker',
          role: attemptedRole,
        }),
      });
      assert.equal(resp.status, 403);
    }

    const okResp = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'citizen@example.com',
        password: 'Password123!',
        displayName: 'Citizen User',
      }),
    });
    assert.equal(okResp.status, 201);
    const data = (await okResp.json()) as { user: { role: string; email: string }; token: string; verificationCodePreview?: string };
    assert.equal(data.user.role, 'regular_user');
    assert.ok(data.token.startsWith('ll_'));
    assert.ok(data.verificationCodePreview);

    const logs = await repoMod.listAuditLogs(20);
    assert.ok(logs.some((l) => l.action === 'BLOCKED_ELEVATED_SELF_REGISTRATION'));
  });

  it('enforces verification & reset code expiry and 5-attempt lockout', async () => {
    const regResp = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'verify.limits@example.com',
        password: 'Password123!',
        displayName: 'Verify Limits',
      }),
    });
    const regData = (await regResp.json()) as { token: string; verificationCodePreview: string };

    // 5 failed verification attempts should lock out and invalidate the code
    for (let i = 0; i < 5; i++) {
      const badVerify = await fetch(`${baseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${regData.token}`,
        },
        body: JSON.stringify({ code: '000000' }),
      });
      assert.equal(badVerify.status, 400);
    }

    // Even the original preview code is now invalidated until resend
    const afterLockout = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({ code: regData.verificationCodePreview }),
    });
    assert.equal(afterLockout.status, 400);

    // Resend works and verifies cleanly
    const resendResp = await fetch(`${baseUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    assert.equal(resendResp.status, 200);
    const resendData = (await resendResp.json()) as { verificationCodePreview: string };

    const goodVerify = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({ code: resendData.verificationCodePreview }),
    });
    assert.equal(goodVerify.status, 200);
    const verifiedBody = (await goodVerify.json()) as { user: { emailVerified: boolean } };
    assert.equal(verifiedBody.user.emailVerified, true);

    // Password reset expiry / invalidation after 5 bad attempts
    const forgotResp = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verify.limits@example.com' }),
    });
    assert.equal(forgotResp.status, 200);
    const forgotData = (await forgotResp.json()) as { resetCodePreview: string };
    assert.ok(forgotData.resetCodePreview);

    for (let i = 0; i < 5; i++) {
      const badReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'verify.limits@example.com',
          code: '999999',
          newPassword: 'NewPassword123!',
        }),
      });
      assert.equal(badReset.status, 400);
    }

    const invalidatedReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'verify.limits@example.com',
        code: forgotData.resetCodePreview,
        newPassword: 'NewPassword123!',
      }),
    });
    assert.equal(invalidatedReset.status, 400);
  });

  it('enforces admin-only role management, last-admin protection, analytics RBAC, and ID validation', async () => {
    const userLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'citizen@example.com', password: 'Password123!' }),
    });
    const userSession = (await userLogin.json()) as { user: { id: number }; token: string };

    // Regular user cannot read analytics or admin users
    const analyticsForbidden = await fetch(`${baseUrl}/api/analytics`, {
      headers: { Authorization: `Bearer ${userSession.token}` },
    });
    assert.equal(analyticsForbidden.status, 403);

    const adminUsersForbidden = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${userSession.token}` },
    });
    assert.equal(adminUsersForbidden.status, 403);

    // Invalid ID validation
    const invalidContact = await fetch(`${baseUrl}/api/contacts/not-a-number`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userSession.token}` },
    });
    assert.equal(invalidContact.status, 400);

    // Demo admin can promote regular user and inspect analytics
    const adminLogin = await fetch(`${baseUrl}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'administrator' }),
    });
    const adminSession = (await adminLogin.json()) as { user: { id: number }; token: string };

    const promoteResp = await fetch(`${baseUrl}/api/admin/users/${userSession.user.id}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ role: 'emergency_operator' }),
    });
    assert.equal(promoteResp.status, 200);
    const promoted = (await promoteResp.json()) as { user: { role: string } };
    assert.equal(promoted.user.role, 'emergency_operator');

    // Last administrator cannot be demoted
    const demoteLastAdmin = await fetch(`${baseUrl}/api/admin/users/${adminSession.user.id}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSession.token}`,
      },
      body: JSON.stringify({ role: 'regular_user' }),
    });
    assert.equal(demoteLastAdmin.status, 400);
  });

  it('enforces login rate limiting (429 with Retry-After)', async () => {
    rateLimitMod.resetRateLimits();
    let lastStatus = 200;
    let retryAfter = '';
    for (let i = 0; i < 16; i++) {
      const resp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ratelimit.victim@example.com', password: 'WrongPassword!' }),
      });
      lastStatus = resp.status;
      retryAfter = resp.headers.get('retry-after') || '';
    }
    assert.equal(lastStatus, 429);
    assert.ok(Number(retryAfter) >= 1);
    rateLimitMod.resetRateLimits();
  });

  it('exchanges verified Firebase ID tokens via /api/auth/firebase, blocks unverified email hijacking, and exposes non-secret googleAuth status', async () => {
    rateLimitMod.resetRateLimits();

    // Non-secret public config reports googleAuth readiness without exposing apiKey or secrets
    const cfgResp = await fetch(`${baseUrl}/api/config/public`);
    assert.equal(cfgResp.status, 200);
    const cfgData = (await cfgResp.json()) as {
      googleAuth?: { configured?: boolean; authDomain?: string; oAuthClientConfigured?: boolean };
      apiKey?: unknown;
      oAuthClientSecret?: unknown;
    };
    assert.equal(cfgData.googleAuth?.configured, true);
    assert.ok(cfgData.googleAuth?.authDomain?.includes('firebaseapp.com'));
    assert.equal(cfgData.googleAuth?.oAuthClientConfigured, true);
    assert.equal(cfgData.apiKey, undefined);
    assert.equal(cfgData.oAuthClientSecret, undefined);

    // Valid Firebase ID token exchanges for a 7-day ll_ session token with regular_user role
    const fbResp = await fetch(`${baseUrl}/api/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-firebase-id-token-0123456789' }),
    });
    assert.equal(fbResp.status, 200);
    const fbData = (await fbResp.json()) as { token: string; user: { role: string; email: string; emailVerified: boolean } };
    assert.ok(fbData.token.startsWith('ll_'));
    assert.equal(fbData.user.role, 'regular_user');
    assert.equal(fbData.user.email, 'google.verified@example.com');
    assert.equal(fbData.user.emailVerified, true);

    // Unverified Firebase email cannot overwrite/link an existing email-registered account
    const hijackResp = await fetch(`${baseUrl}/api/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'unverified-firebase-token-0123456789' }),
    });
    assert.equal(hijackResp.status, 401);

    // Invalid token rejected cleanly
    const badResp = await fetch(`${baseUrl}/api/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'bad-firebase-token-0123456789' }),
    });
    assert.equal(badResp.status, 401);
  });

  it('formats and persists Firebase auth/access-denied testing-mode alerts and developer contact helpers', async () => {
    const errMod = await import('../src/lib/firebaseAuthErrors.ts');

    const firebaseDenied = errMod.formatGoogleAuthError(
      { code: 'auth/access-denied', message: 'Firebase: Error (auth/access-denied).' },
      { mode: 'login', currentHost: 'ais-dev-example.run.app' }
    );
    assert.equal(firebaseDenied.code, 'google_access_denied');
    assert.equal(firebaseDenied.rawCode, 'auth/access-denied');
    assert.equal(firebaseDenied.testingMode, true);
    assert.match(firebaseDenied.title, /Testing Mode/i);
    assert.match(firebaseDenied.recoveryHint, /Email & Password|Demo Sandbox/i);

    const workspaceDenied = errMod.formatGoogleAuthError(
      { code: 'auth/internal-error', customData: { _tokenResponse: { error: { message: 'access_denied' } } } },
      { mode: 'workspace' }
    );
    assert.equal(workspaceDenied.code, 'google_access_denied');
    assert.equal(workspaceDenied.testingMode, true);
    assert.match(workspaceDenied.message, /Workspace/i);

    const badDomain = errMod.formatGoogleAuthError(
      { code: 'auth/unauthorized-domain', message: 'Firebase: Error (auth/unauthorized-domain).' },
      { currentHost: 'custom-preview.example.com' }
    );
    assert.equal(badDomain.code, 'unauthorized_domain');
    assert.match(badDomain.message, /custom-preview\.example\.com/);

    const popupBlocked = errMod.formatGoogleAuthError({ code: 'auth/popup-blocked' });
    assert.equal(popupBlocked.code, 'popup_blocked');

    const popupClosed = errMod.formatGoogleAuthError({ code: 'auth/popup-closed-by-user' });
    assert.equal(popupClosed.code, 'popup_closed');
    assert.match(popupClosed.message, /403/);

    // Persistence lifecycle: save -> load -> expire -> clear
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };

    const persisted = errMod.createPersistedAuthBlockedAlert(
      { code: 'auth/access-denied' },
      { currentHost: 'ais-dev-example.run.app', mode: 'login', occurredAt: '2026-11-15T10:00:00.000Z' }
    );
    errMod.savePersistedAuthBlockedAlert(persisted, mockStorage);

    const loaded = errMod.loadPersistedAuthBlockedAlert(mockStorage, Date.parse('2026-11-15T11:00:00.000Z'));
    assert.ok(loaded);
    assert.equal(loaded.rawCode, 'auth/access-denied');
    assert.equal(loaded.host, 'ais-dev-example.run.app');

    const mailto = errMod.buildDeveloperContactMailto('dev@example.com', loaded);
    assert.ok(mailto.startsWith('mailto:dev%40example.com?subject='));
    assert.match(decodeURIComponent(mailto), /auth\/access-denied/);
    assert.match(decodeURIComponent(mailto), /ais-dev-example\.run\.app/);

    errMod.clearPersistedAuthBlockedAlert(mockStorage);
    assert.equal(errMod.loadPersistedAuthBlockedAlert(mockStorage), null);

    // Expired alerts (>24h) auto-prune on load
    errMod.savePersistedAuthBlockedAlert(persisted, mockStorage);
    const expired = errMod.loadPersistedAuthBlockedAlert(mockStorage, Date.parse('2026-11-17T12:00:00.000Z'));
    assert.equal(expired, null);
  });
});
