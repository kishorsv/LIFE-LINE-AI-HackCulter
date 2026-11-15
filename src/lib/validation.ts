export const VALID_USER_ROLES = [
  'regular_user',
  'emergency_operator',
  'support_organization',
  'administrator',
] as const;

export const VALID_INCIDENT_STATUSES = [
  'SOS Activated',
  'Alert Sent',
  'Acknowledged',
  'Assistance in Progress',
  'Resolved',
  'Cancelled',
] as const;

export const VALID_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export const VALID_SAFETY_STATUSES = ['Safe', 'Cautious', 'Check-In Needed'] as const;

export const VALID_LOCATION_MODES = ['sos_only', 'live_escort', 'manual_only'] as const;

export const VALID_THEMES = ['dark', 'light'] as const;

export const ALLOWED_MAP_PLACE_TYPES = new Set([
  'hospital',
  'police',
  'pharmacy',
  'doctor',
  'fire_station',
  'local_government_office',
  'transit_station',
  'subway_station',
  'bus_station',
]);

const EMAIL_REGEX = /^[^\s@<>()[\]\\,;:\s@"]+@[^\s@<>()[\]\\,;:\s@"]+\.[^\s@<>()[\]\\,;:\s@"]{2,}$/;

export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 5 && trimmed.length <= 254 && EMAIL_REGEX.test(trimmed);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

export function sanitizeBoundedString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
}

export function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function validateOptionalCoordinates(
  lat: unknown,
  lng: unknown
): { valid: boolean; latitude: number | null; longitude: number | null; error?: string } {
  if ((lat === undefined || lat === null) && (lng === undefined || lng === null)) {
    return { valid: true, latitude: null, longitude: null };
  }
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    return {
      valid: false,
      latitude: null,
      longitude: null,
      error: 'Coordinates must be valid finite numbers (latitude -90..90, longitude -180..180).',
    };
  }
  return { valid: true, latitude: lat, longitude: lng };
}

export function isValidIdempotencyKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 8 && trimmed.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(trimmed);
}

export function isValidVerificationCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value.trim());
}

export function isValidPhone(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length <= 32 && /^[+\d\s().-]+$/.test(trimmed);
}
