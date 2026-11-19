export interface GoogleMapsAuthErrorDetail {
  code: string;
  message: string;
  origin: string;
}

declare global {
  interface Window {
    __lifelineMapsAuthError?: GoogleMapsAuthErrorDetail | null;
    __lifelineMapsQuotaExceeded?: boolean;
  }
}

const CODE_MESSAGES: Record<string, string> = {
  RefererNotAllowedMapError:
    'This domain is not authorized for the Google Maps JavaScript API key (RefererNotAllowedMapError).',
  InvalidKeyMapError:
    'The configured VITE_GOOGLE_MAPS_API_KEY is invalid or revoked (InvalidKeyMapError).',
  ApiNotActivatedMapError:
    'The Maps JavaScript API is not enabled on this Google Cloud project (ApiNotActivatedMapError).',
  BillingNotEnabledMapError:
    'Billing is not enabled on the Google Cloud project for this Maps API key (BillingNotEnabledMapError).',
  ApiTargetBlockedMapError:
    'API restrictions on this key block Maps JavaScript API requests (ApiTargetBlockedMapError).',
  AuthFailure:
    'Google Maps authentication failed. Check API key restrictions, enabled APIs, and billing.',
};

export function formatMapsAuthMessage(code: string, rawMessage?: string): GoogleMapsAuthErrorDetail {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const friendly = CODE_MESSAGES[code] || rawMessage || CODE_MESSAGES.AuthFailure;
  return {
    code,
    message: friendly,
    origin,
  };
}

export function dispatchMapsAuthError(code: string, rawMessage?: string) {
  if (typeof window === 'undefined') return;
  const detail = formatMapsAuthMessage(code, rawMessage);
  window.__lifelineMapsAuthError = detail;
  window.dispatchEvent(new CustomEvent<GoogleMapsAuthErrorDetail>('gmp-auth-error', { detail }));
}

export function dispatchMapsQuotaExceeded() {
  if (typeof window === 'undefined') return;
  window.__lifelineMapsQuotaExceeded = true;
  window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
}

export function clearMapsErrorState() {
  if (typeof window === 'undefined') return;
  window.__lifelineMapsAuthError = null;
  window.__lifelineMapsQuotaExceeded = false;
  window.dispatchEvent(new CustomEvent('gmp-auth-cleared'));
}

export function detectMapsErrorCodeFromText(text: string): string | null {
  const knownCodes = [
    'RefererNotAllowedMapError',
    'InvalidKeyMapError',
    'ApiNotActivatedMapError',
    'BillingNotEnabledMapError',
    'ApiTargetBlockedMapError',
  ];
  for (const code of knownCodes) {
    if (text.includes(code)) return code;
  }
  return null;
}
