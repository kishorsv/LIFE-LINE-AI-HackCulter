import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export interface FirebaseAuthConfigStatus {
  configured: boolean;
  hasProjectId: boolean;
  hasAuthDomain: boolean;
  hasApiKey: boolean;
  hasAppId: boolean;
  hasOAuthClientId: boolean;
  authDomain: string;
}

export function validateFirebaseAuthConfig(): FirebaseAuthConfigStatus {
  const cfg = firebaseConfig as {
    projectId?: string;
    authDomain?: string;
    apiKey?: string;
    appId?: string;
    oAuthClientId?: string;
  };
  const hasProjectId = Boolean(cfg.projectId && cfg.projectId !== 'remixed-project-id');
  const hasAuthDomain = Boolean(cfg.authDomain && cfg.authDomain.includes('.'));
  const hasApiKey = Boolean(cfg.apiKey && cfg.apiKey.trim().length > 10);
  const hasAppId = Boolean(cfg.appId && cfg.appId.trim().length > 5);
  const hasOAuthClientId = Boolean(cfg.oAuthClientId && cfg.oAuthClientId.includes('.apps.googleusercontent.com'));

  return {
    configured: hasProjectId && hasAuthDomain && hasApiKey && hasAppId,
    hasProjectId,
    hasAuthDomain,
    hasApiKey,
    hasAppId,
    hasOAuthClientId,
    authDomain: hasAuthDomain ? cfg.authDomain! : '',
  };
}

export const WORKSPACE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/tasks',
];

// Google Workspace OAuth access token is held strictly in memory (never localStorage/sessionStorage)
let inMemoryGoogleAccessToken: string | null = null;

export function getInMemoryGoogleToken(): string | null {
  return inMemoryGoogleAccessToken;
}

export function clearInMemoryGoogleToken() {
  inMemoryGoogleAccessToken = null;
}

/**
 * Standard Google authentication using basic OpenID scopes only (openid, email, profile).
 * Avoids forcing unverified/restricted Workspace scopes during basic account sign-in.
 */
export async function signInWithGoogleBasic(): Promise<{
  idToken: string;
  email: string;
  displayName: string;
}> {
  const status = validateFirebaseAuthConfig();
  if (!status.configured) {
    throw new Error('Firebase Authentication configuration is incomplete for this environment.');
  }

  const provider = new GoogleAuthProvider();
  provider.addScope('openid');
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({ prompt: 'select_account' });

  const result = await signInWithPopup(auth, provider);
  const idToken = await result.user.getIdToken();

  return {
    idToken,
    email: result.user.email || '',
    displayName: result.user.displayName || result.user.email?.split('@')[0] || 'User',
  };
}

/**
 * Explicit Google Workspace OAuth connection for Gmail, Contacts, Calendar, Drive, Docs, Sheets & Tasks.
 * Stores the resulting OAuth access token strictly in memory.
 */
export async function signInWithGoogleWorkspace(): Promise<{
  idToken: string;
  accessToken: string | null;
  email: string;
  displayName: string;
}> {
  const status = validateFirebaseAuthConfig();
  if (!status.configured) {
    throw new Error('Firebase Authentication configuration is incomplete for this environment.');
  }

  const provider = new GoogleAuthProvider();
  for (const scope of WORKSPACE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'consent select_account' });

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  inMemoryGoogleAccessToken = credential?.accessToken ?? null;
  const idToken = await result.user.getIdToken();

  return {
    idToken,
    accessToken: inMemoryGoogleAccessToken,
    email: result.user.email || '',
    displayName: result.user.displayName || result.user.email?.split('@')[0] || 'User',
  };
}

export async function signOutFirebase() {
  clearInMemoryGoogleToken();
  await signOut(auth);
}
