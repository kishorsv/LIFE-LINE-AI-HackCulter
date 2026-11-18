import {
  DeliveryLogItem,
  EmergencyIncident,
  IncidentDeliveryStatus,
  IncidentUpdateItem,
} from '../types/lifeline.ts';
import { QueuedSosPayload } from './offlineSosQueue.ts';

export type SosLifecycleStatus =
  | 'queued'
  | 'syncing'
  | 'failed'
  | 'submitted'
  | 'alert_sent'
  | 'acknowledged'
  | 'in_progress'
  | 'resolved'
  | 'cancelled';

export interface UnifiedSosReportItem {
  key: string;
  origin: 'offline_queue' | 'server_incident';
  incidentId?: number;
  queueId?: string;
  idempotencyKey?: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  locationLabel: string;
  latitude: number | null;
  longitude: number | null;
  isSimulated: boolean;
  lifecycleStatus: SosLifecycleStatus;
  statusLabel: string;
  rawStatus: string;
  reassuranceNote: string;
  deliveryStatus?: IncidentDeliveryStatus;
  operatorName: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  attempts?: number;
  maxRetries?: number;
  nextRetryAt?: string;
  lastError?: string;
  updates: IncidentUpdateItem[];
  deliveryLogs: DeliveryLogItem[];
  progressStep: 0 | 1 | 2 | 3;
  isActive: boolean;
}

export interface SosHistorySummary {
  total: number;
  queuedOrSyncing: number;
  failed: number;
  active: number;
  resolvedOrClosed: number;
}

export function mapIncidentToLifecycle(inc: EmergencyIncident): {
  lifecycleStatus: SosLifecycleStatus;
  statusLabel: string;
  reassuranceNote: string;
  progressStep: 0 | 1 | 2 | 3;
  isActive: boolean;
} {
  switch (inc.status) {
    case 'Alert Sent':
      return {
        lifecycleStatus: 'alert_sent',
        statusLabel: 'Alert Sent',
        reassuranceNote: 'SOS logged with operators and notifications dispatched to your trusted contacts.',
        progressStep: 1,
        isActive: true,
      };
    case 'Acknowledged':
      return {
        lifecycleStatus: 'acknowledged',
        statusLabel: 'Acknowledged',
        reassuranceNote: inc.operatorName
          ? `Acknowledged by ${inc.operatorName}. Operator monitoring is active.`
          : 'An authorized operator has acknowledged your SOS alert.',
        progressStep: 2,
        isActive: true,
      };
    case 'Assistance in Progress':
      return {
        lifecycleStatus: 'in_progress',
        statusLabel: 'In Progress',
        reassuranceNote: inc.operatorName
          ? `Active assistance coordination underway with ${inc.operatorName}.`
          : 'Active assistance coordination is underway.',
        progressStep: 2,
        isActive: true,
      };
    case 'Resolved':
      return {
        lifecycleStatus: 'resolved',
        statusLabel: 'Resolved',
        reassuranceNote: 'This SOS report has been marked resolved.',
        progressStep: 3,
        isActive: false,
      };
    case 'Cancelled':
      return {
        lifecycleStatus: 'cancelled',
        statusLabel: 'Cancelled',
        reassuranceNote: 'Closed — you confirmed safe / cancelled this alert.',
        progressStep: 3,
        isActive: false,
      };
    case 'SOS Activated':
    default:
      return {
        lifecycleStatus: 'submitted',
        statusLabel: 'SOS Activated',
        reassuranceNote: 'Received by platform; waiting for operator acknowledgement.',
        progressStep: 1,
        isActive: true,
      };
  }
}

export function buildUnifiedSosReports(
  incidents: EmergencyIncident[],
  queuedItems: QueuedSosPayload[],
  syncingIds: string[] = []
): UnifiedSosReportItem[] {
  const syncingSet = new Set(syncingIds);

  const localEntries: UnifiedSosReportItem[] = queuedItems.map((q) => {
    const isSyncing = syncingSet.has(q.id) || q.state === 'syncing';
    const isFailed = !isSyncing && q.state === 'failed';
    const lifecycleStatus: SosLifecycleStatus = isSyncing ? 'syncing' : isFailed ? 'failed' : 'queued';
    const statusLabel = isSyncing ? 'Syncing' : isFailed ? 'Sync Failed' : 'Queued';
    const reassuranceNote = isSyncing
      ? 'Connectivity detected — transmitting your queued SOS report to operators now.'
      : isFailed
      ? `Automatic sync stopped after ${q.attempts}/${q.maxRetries} attempts. Use Retry Sync or dial 911/112.`
      : 'Saved securely on this device. It will auto-sync as soon as connectivity is available.';

    return {
      key: `queue:${q.id}`,
      origin: 'offline_queue',
      queueId: q.id,
      idempotencyKey: q.idempotencyKey,
      title: q.title,
      description: q.description,
      category: q.category,
      priority: q.priority,
      locationLabel: q.locationLabel,
      latitude: q.latitude,
      longitude: q.longitude,
      isSimulated: q.isSimulated,
      lifecycleStatus,
      statusLabel,
      rawStatus: lifecycleStatus,
      reassuranceNote,
      operatorName: null,
      createdAt: q.queuedAt,
      updatedAt: q.queuedAt,
      acknowledgedAt: null,
      resolvedAt: null,
      attempts: q.attempts,
      maxRetries: q.maxRetries,
      nextRetryAt: q.nextRetryAt,
      lastError: q.lastError,
      updates: [],
      deliveryLogs: [],
      progressStep: 0,
      isActive: true,
    };
  });

  const serverEntries: UnifiedSosReportItem[] = incidents.map((inc) => {
    const mapped = mapIncidentToLifecycle(inc);
    return {
      key: `incident:${inc.id}`,
      origin: 'server_incident',
      incidentId: inc.id,
      title: inc.title,
      description: inc.description,
      category: inc.category,
      priority: inc.priority,
      locationLabel: inc.locationLabel,
      latitude: inc.latitude,
      longitude: inc.longitude,
      isSimulated: inc.isSimulated,
      lifecycleStatus: mapped.lifecycleStatus,
      statusLabel: mapped.statusLabel,
      rawStatus: inc.status,
      reassuranceNote: mapped.reassuranceNote,
      deliveryStatus: inc.deliveryStatus,
      operatorName: inc.operatorName,
      createdAt: inc.createdAt,
      updatedAt: inc.updatedAt,
      acknowledgedAt: inc.acknowledgedAt,
      resolvedAt: inc.resolvedAt,
      updates: inc.updates || [],
      deliveryLogs: inc.deliveryLogs || [],
      progressStep: mapped.progressStep,
      isActive: mapped.isActive,
    };
  });

  return [...localEntries, ...serverEntries].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
}

export function summarizeSosReports(items: UnifiedSosReportItem[]): SosHistorySummary {
  let queuedOrSyncing = 0;
  let failed = 0;
  let active = 0;
  let resolvedOrClosed = 0;

  for (const item of items) {
    if (item.lifecycleStatus === 'queued' || item.lifecycleStatus === 'syncing') {
      queuedOrSyncing += 1;
    } else if (item.lifecycleStatus === 'failed') {
      failed += 1;
    } else if (item.isActive) {
      active += 1;
    } else {
      resolvedOrClosed += 1;
    }
  }

  return {
    total: items.length,
    queuedOrSyncing,
    failed,
    active,
    resolvedOrClosed,
  };
}
