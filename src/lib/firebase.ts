import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

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

export async function signInWithGoogleWorkspace(): Promise<{
  idToken: string;
  accessToken: string | null;
  email: string;
  displayName: string;
}> {
  const provider = new GoogleAuthProvider();
  for (const scope of WORKSPACE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'select_account' });

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
