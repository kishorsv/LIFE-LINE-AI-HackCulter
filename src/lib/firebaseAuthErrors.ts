export type GoogleAuthErrorCode =
  | 'google_access_denied'
  | 'unauthorized_domain'
  | 'provider_disabled'
  | 'popup_blocked'
  | 'popup_closed'
  | 'user_disabled'
  | 'account_exists_different_credential'
  | 'network_error'
  | 'backend_verification_failed'
  | 'unknown';

export interface FormattedGoogleAuthError {
  code: GoogleAuthErrorCode;
  rawCode: string;
  testingMode: boolean;
  title: string;
  message: string;
  recoveryHint: string;
}

export interface PersistedAuthBlockedAlert extends FormattedGoogleAuthError {
  mode: 'login' | 'workspace';
  host: string;
  occurredAt: string;
}

const BLOCKED_ALERT_STORAGE_KEY = 'lifeline_auth_blocked_alert_v1';
const BLOCKED_ALERT_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export function formatGoogleAuthError(
  err: unknown,
  context?: { currentHost?: string; mode?: 'login' | 'workspace' }
): FormattedGoogleAuthError {
  const errObj = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown;
    message?: unknown;
    customData?: { _tokenResponse?: { error?: { message?: string } } };
  };
  const rawCode = typeof errObj.code === 'string' ? errObj.code.trim() : '';
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof errObj.message === 'string'
        ? errObj.message
        : String(err || '');
  const tokenError = errObj.customData?._tokenResponse?.error?.message || '';
  const combined = `${rawCode} ${rawMessage} ${tokenError}`.toLowerCase();
  const host =
    context?.currentHost ||
    (typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'this domain');
  const isWorkspace = context?.mode === 'workspace';

  if (
    rawCode === 'auth/access-denied' ||
    combined.includes('auth/access-denied') ||
    combined.includes('access_denied') ||
    combined.includes('403') ||
    combined.includes('verification') ||
    combined.includes('test user') ||
    combined.includes('tester') ||
    combined.includes('org_internal') ||
    combined.includes('admin_policy_enforced')
  ) {
    return {
      code: 'google_access_denied',
      rawCode: rawCode || 'auth/access-denied',
      testingMode: true,
      title: 'Google Sign-In Blocked — App Is Currently in Testing Mode',
      message: isWorkspace
        ? 'Google blocked Workspace OAuth access (403 access_denied) because LIFE-LINE AI is currently in Testing mode while Google verification for sensitive Workspace scopes is pending. Only developer-approved test accounts can connect Google Workspace right now.'
        : 'Firebase Authentication blocked Google sign-in (auth/access-denied) because this app is currently in Testing mode awaiting Google verification. Only developer-approved test users can sign in with Google at this time.',
      recoveryHint: isWorkspace
        ? 'All core safety features and Emergency SOS continue to work normally. Ask the developer to add your Google email as an OAuth Test User if you need Workspace features.'
        : 'You can sign in immediately using Email & Password (or the Demo Sandbox if enabled). To request Google Sign-In access, contact the developer to add your Google account to the OAuth Test Users list.',
    };
  }

  if (rawCode === 'auth/unauthorized-domain' || combined.includes('unauthorized-domain')) {
    return {
      code: 'unauthorized_domain',
      rawCode: rawCode || 'auth/unauthorized-domain',
      testingMode: true,
      title: 'Domain Not Authorized for Google Sign-In',
      message: `Firebase Authentication blocked sign-in because "${host}" is not listed under Authorized domains for this project.`,
      recoveryHint: `Contact the developer to add "${host}" in Firebase Console -> Authentication -> Settings -> Authorized domains, or sign in with Email & Password.`,
    };
  }

  if (rawCode === 'auth/operation-not-allowed' || combined.includes('operation-not-allowed')) {
    return {
      code: 'provider_disabled',
      rawCode: rawCode || 'auth/operation-not-allowed',
      testingMode: true,
      title: 'Google Sign-In Provider Not Enabled',
      message: 'The Google sign-in provider is not currently enabled in Firebase Authentication for this project.',
      recoveryHint: 'Contact the developer to enable Google in Firebase Authentication, or use Email & Password sign-in.',
    };
  }

  if (rawCode === 'auth/popup-blocked' || combined.includes('popup-blocked')) {
    return {
      code: 'popup_blocked',
      rawCode: rawCode || 'auth/popup-blocked',
      testingMode: false,
      title: 'Google Sign-In Popup Blocked',
      message: 'Your browser blocked the Google authentication popup window before sign-in could begin.',
      recoveryHint: 'Allow popups for this site and try again, or sign in with Email & Password.',
    };
  }

  if (
    rawCode === 'auth/popup-closed-by-user' ||
    rawCode === 'auth/cancelled-popup-request' ||
    combined.includes('popup-closed-by-user') ||
    combined.includes('cancelled-popup-request')
  ) {
    return {
      code: 'popup_closed',
      rawCode: rawCode || 'auth/popup-closed-by-user',
      testingMode: true,
      title: 'Google Sign-In Window Closed (Testing Mode Restriction Possible)',
      message:
        'Google authentication was closed before completion. If Google displayed an "Access blocked (403)" testing-mode notice inside the popup, your Google account is not yet in the project’s approved test user list.',
      recoveryHint: isWorkspace
        ? 'Try again with an approved test user account, contact the developer for test access, or continue using LIFE-LINE AI without Workspace OAuth.'
        : 'Sign in immediately using Email & Password (or the Demo Sandbox), or contact the developer to add your Google account as an approved test user.',
    };
  }

  if (rawCode === 'auth/user-disabled' || combined.includes('user-disabled')) {
    return {
      code: 'user_disabled',
      rawCode: rawCode || 'auth/user-disabled',
      testingMode: false,
      title: 'Firebase Account Disabled',
      message: 'This Google/Firebase account has been disabled by an administrator.',
      recoveryHint: 'Contact the developer or platform administrator for assistance.',
    };
  }

  if (rawCode === 'auth/account-exists-with-different-credential') {
    return {
      code: 'account_exists_different_credential',
      rawCode: rawCode || 'auth/account-exists-with-different-credential',
      testingMode: false,
      title: 'Account Uses Another Sign-In Method',
      message: 'An account with this email already exists using a different sign-in provider.',
      recoveryHint: 'Sign in using your Email & Password credentials instead.',
    };
  }

  if (rawCode === 'auth/network-request-failed' || combined.includes('network-request-failed')) {
    return {
      code: 'network_error',
      rawCode: rawCode || 'auth/network-request-failed',
      testingMode: false,
      title: 'Network Error Reaching Google Auth',
      message: 'Unable to reach Firebase/Google authentication servers. Check your internet connection.',
      recoveryHint: 'Retry once connected, or use Email & Password.',
    };
  }

  if (combined.includes('firebase token') || combined.includes('verifyidtoken') || combined.includes('verification failed')) {
    return {
      code: 'backend_verification_failed',
      rawCode: rawCode || 'auth/verification-failed',
      testingMode: false,
      title: 'Server Verification of Google Session Failed',
      message: rawMessage || 'The server could not verify your Google authentication token.',
      recoveryHint: 'Try signing in again, use Email & Password, or contact the developer if the issue persists.',
    };
  }

  return {
    code: 'unknown',
    rawCode: rawCode || 'auth/unknown',
    testingMode: false,
    title: isWorkspace ? 'Google Workspace Connection Blocked' : 'Google Sign-In Could Not Complete',
    message: rawMessage || 'Google authentication was blocked or could not be completed.',
    recoveryHint: isWorkspace
      ? 'Core safety features remain available. Contact the developer if you need Workspace test-user access.'
      : 'Use Email & Password Sign In or the Demo Sandbox, or contact the developer for test-user access.',
  };
}

export function createPersistedAuthBlockedAlert(
  err: unknown,
  context?: { currentHost?: string; mode?: 'login' | 'workspace'; occurredAt?: string }
): PersistedAuthBlockedAlert {
  const host =
    context?.currentHost ||
    (typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'unknown-host');
  const formatted = formatGoogleAuthError(err, { currentHost: host, mode: context?.mode });
  return {
    ...formatted,
    mode: context?.mode || 'login',
    host,
    occurredAt: context?.occurredAt || new Date().toISOString(),
  };
}

export function savePersistedAuthBlockedAlert(
  alert: PersistedAuthBlockedAlert,
  storage?: Pick<Storage, 'setItem'>
): void {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return;
  try {
    target.setItem(BLOCKED_ALERT_STORAGE_KEY, JSON.stringify(alert));
  } catch {
    // ignore storage quota errors
  }
}

export function loadPersistedAuthBlockedAlert(
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
  nowMs = Date.now()
): PersistedAuthBlockedAlert | null {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return null;
  try {
    const raw = target.getItem(BLOCKED_ALERT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAuthBlockedAlert>;
    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.message !== 'string') {
      target.removeItem(BLOCKED_ALERT_STORAGE_KEY);
      return null;
    }
    const ts = parsed.occurredAt ? Date.parse(parsed.occurredAt) : 0;
    if (!ts || Number.isNaN(ts) || nowMs - ts > BLOCKED_ALERT_TTL_MS) {
      target.removeItem(BLOCKED_ALERT_STORAGE_KEY);
      return null;
    }
    return parsed as PersistedAuthBlockedAlert;
  } catch {
    return null;
  }
}

export function clearPersistedAuthBlockedAlert(storage?: Pick<Storage, 'removeItem'>): void {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return;
  try {
    target.removeItem(BLOCKED_ALERT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function buildAccessRequestMessage(alert: PersistedAuthBlockedAlert): string {
  return [
    'Hello LIFE-LINE AI Developer,',
    '',
    'I encountered a blocked Google/Firebase sign-in while testing the application:',
    `- Error Code: ${alert.rawCode}`,
    `- Flow: ${alert.mode === 'workspace' ? 'Google Workspace OAuth' : 'Google Sign-In'}`,
    `- App Host: ${alert.host}`,
    `- Timestamp: ${alert.occurredAt}`,
    '',
    'Please add my Google email address as an approved Test User in the Google Cloud OAuth Consent Screen if needed.',
  ].join('\n');
}

export function buildDeveloperContactMailto(email: string, alert: PersistedAuthBlockedAlert): string {
  const subject = encodeURIComponent(`LIFE-LINE AI Access Request (${alert.rawCode})`);
  const body = encodeURIComponent(buildAccessRequestMessage(alert));
  return `mailto:${encodeURIComponent(email.trim())}?subject=${subject}&body=${body}`;
}
