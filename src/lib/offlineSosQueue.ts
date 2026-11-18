export type QueueItemState = 'queued' | 'syncing' | 'submitted' | 'delivered' | 'failed';

export interface QueuedSosPayload {
  id: string;
  idempotencyKey: string;
  userId: number;
  userUid: string;
  queuedAt: string;
  expiresAt: string;
  attempts: number;
  maxRetries: number;
  nextRetryAt: string;
  state: QueueItemState;
  lastError?: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  latitude: number | null;
  longitude: number | null;
  locationLabel: string;
  locationAccuracyMeters: number | null;
  isSimulated: boolean;
}

const QUEUE_KEY = 'lifeline_pending_sos_queue_v2';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_RETRIES = 5;

export interface QueueStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function getStorage(storage?: QueueStorageLike): QueueStorageLike | null {
  if (storage) return storage;
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  return null;
}

const syncingSosIds = new Set<string>();

function emitQueueUpdated() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('lifeline-sos-queue-updated'));
  }
}

export function markQueuedSosSyncing(id: string, syncing: boolean) {
  const changed = syncing ? !syncingSosIds.has(id) : syncingSosIds.has(id);
  if (syncing) {
    syncingSosIds.add(id);
  } else {
    syncingSosIds.delete(id);
  }
  if (changed) {
    emitQueueUpdated();
  }
}

export function getSyncingSosIds(): string[] {
  return Array.from(syncingSosIds);
}

export function requestSosQueueFlush() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('lifeline-sos-flush-requested'));
  }
}

function generateIdempotencyKey(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `sos_${globalThis.crypto.randomUUID()}`;
  }
  return `sos_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function readRawQueue(storage?: QueueStorageLike): QueuedSosPayload[] {
  const store = getStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueuedSosPayload =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.idempotencyKey === 'string' &&
        typeof item.userId === 'number' &&
        typeof item.userUid === 'string'
    );
  } catch {
    return [];
  }
}

function writeRawQueue(items: QueuedSosPayload[], storage?: QueueStorageLike) {
  const store = getStorage(storage);
  if (!store) return;
  store.setItem(QUEUE_KEY, JSON.stringify(items));
  emitQueueUpdated();
}

export function pruneExpiredQueuedSos(nowMs = Date.now(), storage?: QueueStorageLike): QueuedSosPayload[] {
  const current = readRawQueue(storage);
  const valid = current.filter((item) => {
    const exp = new Date(item.expiresAt).getTime();
    return Number.isFinite(exp) && exp > nowMs;
  });
  if (valid.length !== current.length) {
    writeRawQueue(valid, storage);
  }
  return valid;
}

export function getQueuedSosAlerts(
  owner?: { id: number; uid: string } | null,
  storage?: QueueStorageLike,
  nowMs = Date.now()
): QueuedSosPayload[] {
  if (!owner) return [];
  const active = pruneExpiredQueuedSos(nowMs, storage);
  return active.filter((q) => q.userId === owner.id && q.userUid === owner.uid);
}

export function getRetryableQueuedSosAlerts(
  owner: { id: number; uid: string } | null | undefined,
  storage?: QueueStorageLike,
  nowMs = Date.now()
): QueuedSosPayload[] {
  return getQueuedSosAlerts(owner, storage, nowMs).filter((q) => {
    if (q.state === 'delivered' || q.state === 'submitted') return false;
    if (q.attempts >= q.maxRetries) return false;
    const nextRetry = new Date(q.nextRetryAt).getTime();
    return !Number.isFinite(nextRetry) || nextRetry <= nowMs;
  });
}

export function enqueueOfflineSos(
  payload: {
    userId: number;
    userUid: string;
    idempotencyKey?: string;
    title: string;
    description: string;
    category: string;
    priority: string;
    latitude: number | null;
    longitude: number | null;
    locationLabel: string;
    locationAccuracyMeters: number | null;
    isSimulated: boolean;
  },
  options?: { ttlMs?: number; maxRetries?: number; storage?: QueueStorageLike; nowMs?: number }
): QueuedSosPayload {
  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const current = pruneExpiredQueuedSos(nowMs, options?.storage);

  // Deduplicate if the exact same idempotencyKey is already queued for this user
  if (payload.idempotencyKey) {
    const existing = current.find(
      (q) => q.idempotencyKey === payload.idempotencyKey && q.userId === payload.userId && q.userUid === payload.userUid
    );
    if (existing) return existing;
  }

  const key = payload.idempotencyKey || generateIdempotencyKey();
  const entry: QueuedSosPayload = {
    id: `offline_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
    idempotencyKey: key,
    userId: payload.userId,
    userUid: payload.userUid,
    queuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    attempts: 0,
    maxRetries,
    nextRetryAt: new Date(nowMs).toISOString(),
    state: 'queued',
    title: payload.title,
    description: payload.description,
    category: payload.category,
    priority: payload.priority,
    latitude: payload.latitude,
    longitude: payload.longitude,
    locationLabel: payload.locationLabel,
    locationAccuracyMeters: payload.locationAccuracyMeters,
    isSimulated: payload.isSimulated,
  };

  writeRawQueue([...current, entry], options?.storage);
  return entry;
}

export function recordQueuedSosRetryFailure(
  id: string,
  owner: { id: number; uid: string },
  errorMessage: string,
  options?: { permanent?: boolean; storage?: QueueStorageLike; nowMs?: number }
): QueuedSosPayload | null {
  const nowMs = options?.nowMs ?? Date.now();
  const current = readRawQueue(options?.storage);
  let updatedItem: QueuedSosPayload | null = null;

  const next = current.map((item) => {
    if (item.id !== id || item.userId !== owner.id || item.userUid !== owner.uid) return item;
    const attempts = item.attempts + 1;
    const exhausted = Boolean(options?.permanent) || attempts >= item.maxRetries;
    const backoffMs = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, attempts - 1));
    updatedItem = {
      ...item,
      attempts,
      state: exhausted ? 'failed' : 'queued',
      nextRetryAt: new Date(nowMs + backoffMs).toISOString(),
      lastError: errorMessage.slice(0, 300),
    };
    return updatedItem;
  });

  writeRawQueue(next, options?.storage);
  return updatedItem;
}

export function resetQueuedSosForManualRetry(
  id: string,
  owner: { id: number; uid: string },
  storage?: QueueStorageLike,
  nowMs = Date.now()
): QueuedSosPayload | null {
  const current = readRawQueue(storage);
  let updatedItem: QueuedSosPayload | null = null;

  const next = current.map((item) => {
    if (item.id !== id || item.userId !== owner.id || item.userUid !== owner.uid) return item;
    updatedItem = {
      ...item,
      state: 'queued',
      attempts: Math.min(item.attempts, Math.max(0, item.maxRetries - 1)),
      nextRetryAt: new Date(nowMs).toISOString(),
      lastError: undefined,
    };
    return updatedItem;
  });

  if (updatedItem) {
    writeRawQueue(next, storage);
  }
  return updatedItem;
}

export function removeQueuedSos(
  id: string,
  owner?: { id: number; uid: string } | null,
  storage?: QueueStorageLike
) {
  const current = readRawQueue(storage);
  const remaining = current.filter((q) => {
    if (q.id !== id) return true;
    if (!owner) return false;
    return !(q.userId === owner.id && q.userUid === owner.uid);
  });
  writeRawQueue(remaining, storage);
}

export function clearLegacySharedSosQueue(storage?: QueueStorageLike) {
  const store = getStorage(storage);
  store?.removeItem?.('lifeline_pending_sos_queue');
}
