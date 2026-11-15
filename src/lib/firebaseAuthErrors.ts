export interface FormattedGoogleAuthError {
  code:
    | 'google_access_denied'
    | 'unauthorized_domain'
    | 'provider_disabled'
    | 'popup_blocked'
    | 'popup_closed'
    | 'account_exists_different_credential'
    | 'network_error'
    | 'backend_verification_failed'
    | 'unknown';
  title: string;
  message: string;
  recoveryHint: string;
}

export function formatGoogleAuthError(
  err: unknown,
  context?: { currentHost?: string; mode?: 'login' | 'workspace' }
): FormattedGoogleAuthError {
  const errObj = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown;
    message?: unknown;
    customData?: { _tokenResponse?: { error?: { message?: string } } };
  };
  const rawCode = typeof errObj.code === 'string' ? errObj.code : '';
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
      title: 'Google OAuth Access Blocked (403 access_denied)',
      message: isWorkspace
        ? 'Google blocked Workspace OAuth access because this project has not completed Google verification for restricted Workspace scopes (Gmail, Contacts, Drive, Calendar) or your Google account is not listed as an approved test user.'
        : 'Google blocked sign-in (403 access_denied) because this Firebase/Google Cloud OAuth consent screen is currently in Testing mode or awaiting Google verification, so only developer-approved test users can sign in with Google.',
      recoveryHint: isWorkspace
        ? 'Emergency SOS and core platform features still work normally. To enable Workspace integrations, add your Google account to OAuth Test Users or complete Google Cloud verification.'
        : 'Sign in with Email & Password or use the Demo Sandbox (if enabled). Administrators can allow your account by adding your email under Google Cloud Console -> OAuth consent screen -> Test users, or by publishing the app.',
    };
  }

  if (rawCode === 'auth/unauthorized-domain' || combined.includes('unauthorized-domain')) {
    return {
      code: 'unauthorized_domain',
      title: 'Domain Not Authorized for Google Sign-In',
      message: `Firebase Authentication rejected "${host}" because it is not listed under Authorized domains for this project.`,
      recoveryHint: `Add "${host}" in Firebase Console -> Authentication -> Settings -> Authorized domains, or sign in with Email & Password.`,
    };
  }

  if (rawCode === 'auth/operation-not-allowed' || combined.includes('operation-not-allowed')) {
    return {
      code: 'provider_disabled',
      title: 'Google Sign-In Provider Not Enabled',
      message: 'The Google sign-in provider is not currently enabled in Firebase Authentication for this project.',
      recoveryHint: 'Enable Google in Firebase Console -> Authentication -> Sign-in method, or use Email & Password.',
    };
  }

  if (rawCode === 'auth/popup-blocked' || combined.includes('popup-blocked')) {
    return {
      code: 'popup_blocked',
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
      title: 'Google Sign-In Window Closed',
      message:
        'Google authentication was closed before completion. If Google displayed an "Access blocked (403)" screen inside the popup, your account is not yet in the project’s approved OAuth test user list.',
      recoveryHint: isWorkspace
        ? 'Try again with an approved test user account, or continue using LIFE-LINE AI without Workspace OAuth.'
        : 'Try again with an approved test user account, or sign in immediately using Email & Password or the Demo Sandbox.',
    };
  }

  if (rawCode === 'auth/account-exists-with-different-credential') {
    return {
      code: 'account_exists_different_credential',
      title: 'Account Uses Another Sign-In Method',
      message: 'An account with this email already exists using a different sign-in provider.',
      recoveryHint: 'Sign in using your Email & Password credentials instead.',
    };
  }

  if (rawCode === 'auth/network-request-failed' || combined.includes('network-request-failed')) {
    return {
      code: 'network_error',
      title: 'Network Error Reaching Google Auth',
      message: 'Unable to reach Firebase/Google authentication servers. Check your internet connection.',
      recoveryHint: 'Retry once connected, or use Email & Password.',
    };
  }

  if (combined.includes('firebase token') || combined.includes('verifyidtoken') || combined.includes('verification failed')) {
    return {
      code: 'backend_verification_failed',
      title: 'Server Verification of Google Session Failed',
      message: rawMessage || 'The server could not verify your Google authentication token.',
      recoveryHint: 'Try signing in again, or use Email & Password authentication.',
    };
  }

  return {
    code: 'unknown',
    title: isWorkspace ? 'Google Workspace Connection Failed' : 'Google Sign-In Failed',
    message: rawMessage || 'Google authentication could not be completed.',
    recoveryHint: isWorkspace
      ? 'Core safety features remain available. Retry or verify OAuth test user access.'
      : 'Use Email & Password Sign In or the Demo Sandbox if Google OAuth is restricted.',
  };
}
