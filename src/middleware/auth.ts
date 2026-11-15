import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { AppUser, getOrCreateUserByFirebase, getUserById, UserRole } from '../db/repository.ts';

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(process.env.GEMINI_API_KEY || 'lifeline-ai-dev-session-secret').digest('hex');

export interface AuthRequest extends Request {
  appUser?: AppUser;
}

export function signAppToken(user: AppUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: user.id,
      uid: user.uid,
      role: user.role,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `ll_${payload}.${sig}`;
}

export function verifyAppToken(token: string): { userId: number; uid: string; role: UserRole } | null {
  if (!token.startsWith('ll_')) return null;
  const raw = token.slice(3);
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.exp < Date.now()) return null;
    return parsed;
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
    if (token.startsWith('ll_')) {
      const decoded = verifyAppToken(token);
      if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized: Session expired or invalid' });
      }
      const user = await getUserById(decoded.userId);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized: Account not found' });
      }
      req.appUser = user;
      return next();
    }

    // Verify Firebase ID token from Google Sign-In
    const decodedFirebase = await adminAuth.verifyIdToken(token);
    const email = decodedFirebase.email || `${decodedFirebase.uid}@firebase.user`;
    const user = await getOrCreateUserByFirebase(
      decodedFirebase.uid,
      email,
      decodedFirebase.name || '',
      Boolean(decodedFirebase.email_verified)
    );
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
