export interface QueuedSosPayload {
  id: string;
  queuedAt: string;
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

const QUEUE_KEY = 'lifeline_pending_sos_queue';

export function getQueuedSosAlerts(): QueuedSosPayload[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineSos(payload: Omit<QueuedSosPayload, 'id' | 'queuedAt'>): QueuedSosPayload {
  const entry: QueuedSosPayload = {
    ...payload,
    id: `offline_${Date.now()}`,
    queuedAt: new Date().toISOString(),
  };
  const current = getQueuedSosAlerts();
  localStorage.setItem(QUEUE_KEY, JSON.stringify([...current, entry]));
  window.dispatchEvent(new CustomEvent('lifeline-sos-queue-updated'));
  return entry;
}

export function removeQueuedSos(id: string) {
  const remaining = getQueuedSosAlerts().filter((q) => q.id !== id);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  window.dispatchEvent(new CustomEvent('lifeline-sos-queue-updated'));
}
