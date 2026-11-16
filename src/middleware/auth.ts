import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { AppUser, getOrCreateUserByFirebase, getUserById, UserRole } from '../db/repository.ts';

const WEAK_SECRETS = new Set([
  'lifeline-ai-dev-session-secret',
  'my_session_secret',
  'my-session-secret',
  'changeme',
  'secret',
  'default',
  'dev-secret',
]);

let ephemeralDevSecret: string | null = null;
let runtimeDbSecret: string | null = null;

export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.SESSION_SECRET || '').trim();
  const isProd = env.NODE_ENV === 'production';

  if (configured) {
    if (configured.length < 32 || WEAK_SECRETS.has(configured.toLowerCase())) {
      if (isProd) {
        throw new Error(
          'FATAL SECURITY ERROR: SESSION_SECRET must be at least 32 non-trivial characters in production.'
        );
      }
      console.warn(
        '[security] Weak SESSION_SECRET detected in non-production; generating an ephemeral random secret for this process.'
      );
    } else {
      return configured;
    }
  }

  if (isProd) {
    if (runtimeDbSecret && runtimeDbSecret.length >= 32) {
      return runtimeDbSecret;
    }
    throw new Error(
      'FATAL SECURITY ERROR: SESSION_SECRET environment variable is required in production (minimum 32 characters).'
    );
  }

  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[security] SESSION_SECRET not configured in development/test; using a cryptographically random ephemeral secret.'
    );
  }
  return ephemeralDevSecret;
}

/**
 * Ensures production servers running in managed environments (e.g. Cloud Run) where SESSION_SECRET
 * was omitted or set to a short placeholder obtain a shared 256-bit CSPRNG secret persisted in the
 * authoritative database so multiple scaled instances verify each other's tokens without crashing.
 */
export async function initializeRuntimeSessionSecret(
  loadOrCreateDbSecret: () => Promise<string>,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  runtimeDbSecret = null;
  try {
    return resolveSessionSecret(env);
  } catch (err) {
    const canUseDbSecret =
      env.NODE_ENV === 'production' && env.ALLOW_DB_SESSION_SECRET !== 'false';
    if (!canUseDbSecret) {
      throw err;
    }
    const dbSecret = await loadOrCreateDbSecret();
    if (!dbSecret || dbSecret.length < 32) {
      throw err;
    }
    runtimeDbSecret = dbSecret;
    console.warn(
      '[security] SESSION_SECRET missing or <32 chars in production; initialized shared 256-bit CSPRNG signing key in authoritative database. Set SESSION_SECRET in Cloud Run Secrets for manual key rotation.'
    );
    return runtimeDbSecret;
  }
}

export function resetEphemeralSecretForTests() {
  ephemeralDevSecret = null;
  runtimeDbSecret = null;
}

export interface AuthRequest extends Request {
  appUser?: AppUser;
}

export function signAppToken(user: AppUser, secretOverride?: string): string {
  const secret = secretOverride || resolveSessionSecret();
  const payload = Buffer.from(
    JSON.stringify({
      userId: user.id,
      uid: user.uid,
      role: user.role,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `ll_${payload}.${sig}`;
}

export function verifyAppToken(
  token: string,
  secretOverride?: string
): { userId: number; uid: string; role: UserRole; exp: number } | null {
  if (!token || !token.startsWith('ll_')) return null;
  const raw = token.slice(3);
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const secret = secretOverride || resolveSessionSecret();
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      userId?: unknown;
      uid?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.userId !== 'number' ||
      !Number.isSafeInteger(parsed.userId) ||
      parsed.userId <= 0 ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Date.now()
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      uid: parsed.uid,
      role: parsed.role as UserRole,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export interface FirebaseTokenVerifier {
  verifyIdToken: (
    token: string
  ) => Promise<{ uid: string; email?: string; name?: string; email_verified?: boolean }>;
}

export async function verifyAndSyncFirebaseUser(
  token: string,
  verifier: FirebaseTokenVerifier = adminAuth
): Promise<AppUser> {
  if (!token || token.startsWith('ll_')) {
    throw new Error('A valid Firebase ID token is required.');
  }
  const decodedFirebase = await verifier.verifyIdToken(token);
  const email = decodedFirebase.email || `${decodedFirebase.uid}@firebase.user`;
  return await getOrCreateUserByFirebase(
    decodedFirebase.uid,
    email,
    decodedFirebase.name || '',
    Boolean(decodedFirebase.email_verified)
  );
}

export async function resolveUserFromToken(token: string): Promise<AppUser | null> {
  if (!token) return null;
  if (token.startsWith('ll_')) {
    const decoded = verifyAppToken(token);
    if (!decoded) return null;
    const user = await getUserById(decoded.userId);
    if (!user || user.uid !== decoded.uid) return null;
    return user;
  }

  try {
    return await verifyAndSyncFirebaseUser(token);
  } catch {
    return null;
  }
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
  }

  const token = authHeader.split('Bearer ')[1].trim();
  try {
    const user = await resolveUserFromToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
    }
    req.appUser = user;
    return next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid credentials' });
  }
};

export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.appUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!allowedRoles.includes(req.appUser.role)) {
      return res.status(403).json({
        error: `Forbidden: Role '${req.appUser.role}' is not authorized for this resource.`,
      });
    }
    next();
  };
};
