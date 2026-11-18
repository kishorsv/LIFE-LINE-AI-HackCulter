import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { AppLanguage, AppUser, EmergencyIncident } from '../types/lifeline.ts';
import { t } from '../i18n/translations.ts';
import {
  getQueuedSosAlerts,
  getSyncingSosIds,
  QueuedSosPayload,
  removeQueuedSos,
  requestSosQueueFlush,
  resetQueuedSosForManualRetry,
} from '../lib/offlineSosQueue.ts';
import {
  buildUnifiedSosReports,
  SosLifecycleStatus,
  summarizeSosReports,
  UnifiedSosReportItem,
} from '../lib/sosHistory.ts';

interface SosHistorySectionProps {
  user: AppUser | null;
  incidents: EmergencyIncident[];
  language: AppLanguage;
  realtimeConnected: boolean;
  onMarkSafeIncident: (incidentId: number) => Promise<void>;
  onRefresh: () => Promise<void>;
  cancellingId: number | null;
}

type HistoryFilter = 'all' | 'active' | 'resolved';

function getStatusBadgeClasses(status: SosLifecycleStatus): string {
  switch (status) {
    case 'queued':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'syncing':
      return 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300';
    case 'failed':
      return 'border-rose-500/45 bg-rose-500/15 text-rose-700 dark:text-rose-300';
    case 'submitted':
    case 'alert_sent':
      return 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300';
    case 'acknowledged':
      return 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300';
    case 'in_progress':
      return 'border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300';
    case 'resolved':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'cancelled':
    default:
      return 'border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300';
  }
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PROGRESS_LABELS = ['Queued', 'Submitted', 'Acknowledged', 'Resolved'] as const;

export function SosHistorySection({
  user,
  incidents,
  language,
  realtimeConnected,
  onMarkSafeIncident,
  onRefresh,
  cancellingId,
}: SosHistorySectionProps) {
  const [queuedItems, setQueuedItems] = useState<QueuedSosPayload[]>(() => getQueuedSosAlerts(user));
  const [syncingIds, setSyncingIds] = useState<string[]>(() => getSyncingSosIds());
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const syncLocalQueue = () => {
      setQueuedItems(getQueuedSosAlerts(user));
      setSyncingIds(getSyncingSosIds());
    };
    syncLocalQueue();
    window.addEventListener('lifeline-sos-queue-updated', syncLocalQueue);
    window.addEventListener('storage', syncLocalQueue);
    return () => {
      window.removeEventListener('lifeline-sos-queue-updated', syncLocalQueue);
      window.removeEventListener('storage', syncLocalQueue);
    };
  }, [user]);

  const unifiedReports = useMemo(
    () => buildUnifiedSosReports(incidents, queuedItems, syncingIds),
    [incidents, queuedItems, syncingIds]
  );

  const summary = useMemo(() => summarizeSosReports(unifiedReports), [unifiedReports]);

  const filteredReports = useMemo(() => {
    if (filter === 'active') {
      return unifiedReports.filter((r) => r.isActive);
    }
    if (filter === 'resolved') {
      return unifiedReports.filter((r) => !r.isActive);
    }
    return unifiedReports;
  }, [unifiedReports, filter]);

  const visibleReports = showAll ? filteredReports : filteredReports.slice(0, 6);

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRetryQueued = (item: UnifiedSosReportItem) => {
    if (!user || !item.queueId) return;
    resetQueuedSosForManualRetry(item.queueId, { id: user.id, uid: user.uid });
    requestSosQueueFlush();
  };

  const handleDiscardQueued = (item: UnifiedSosReportItem) => {
    if (!user || !item.queueId) return;
    removeQueuedSos(item.queueId, { id: user.id, uid: user.uid });
  };

  return (
    <section
      id="sos-reports-history"
      aria-labelledby="sos-reports-history-heading"
      className="rounded-2xl border border-slate-200 dark:border-violet-500/25 bg-white dark:bg-[#0B1022] p-6 space-y-5"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-600 dark:text-rose-400">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="sos-reports-history-heading"
                className="font-display text-base sm:text-lg font-bold text-slate-900 dark:text-white"
              >
                {t(language, 'dash_incidents_title')} &amp; Status History
              </h2>
              <span className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:text-slate-300">
                {summary.total} {summary.total === 1 ? 'report' : 'reports'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Track every past and pending SOS alert from offline queue and syncing through operator acknowledgement and resolution.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
              realtimeConnected
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            <Radio className="h-3 w-3" />
            <span>{realtimeConnected ? 'Live Status Updates Active' : 'Offline / Reconnecting'}</span>
          </span>
          <button
            type="button"
            disabled={refreshing}
            onClick={handleManualRefresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-violet-500/50 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Summary Metrics + Peace-of-Mind Strip */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Queued / Syncing</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-amber-600 dark:text-amber-300">
            {summary.queuedOrSyncing}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Active / Acknowledged</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-sky-600 dark:text-sky-300">
            {summary.active}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Resolved / Closed</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-300">
            {summary.resolvedOrClosed}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3.5 py-2.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Needs Retry (Failed)</div>
          <div
            className={`mt-0.5 text-lg font-bold tabular-nums ${
              summary.failed > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            {summary.failed}
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter SOS reports">
          {(
            [
              { id: 'all', label: `All Reports (${summary.total})` },
              {
                id: 'active',
                label: `Pending & Active (${summary.queuedOrSyncing + summary.active + summary.failed})`,
              },
              { id: 'resolved', label: `Resolved & Closed (${summary.resolvedOrClosed})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === tab.id
                  ? 'border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {summary.total > 0 && summary.queuedOrSyncing === 0 && summary.active === 0 && summary.failed === 0 && (
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" />
            <span>All recorded SOS reports are resolved or closed.</span>
          </div>
        )}
      </div>

      {/* Report List */}
      {filteredReports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40 px-5 py-8 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-emerald-500/80" />
          <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
            {summary.total === 0
              ? 'No SOS reports recorded yet'
              : `No ${filter === 'active' ? 'pending or active' : 'resolved or closed'} SOS reports`}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {summary.total === 0
              ? 'Any Emergency SOS you trigger — online or offline — appears here with live status tracking (queued, syncing, acknowledged, and resolved).'
              : 'Switch filter tabs above to review your other recorded SOS reports.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleReports.map((item) => {
            const expanded = Boolean(expandedKeys[item.key]);
            const isSyncing = item.lifecycleStatus === 'syncing';
            const isQueued = item.lifecycleStatus === 'queued';
            const isFailed = item.lifecycleStatus === 'failed';
            const isCancelled = item.lifecycleStatus === 'cancelled';

            return (
              <div
                key={item.key}
                className={`rounded-xl border p-4 space-y-3 transition-colors ${
                  isFailed
                    ? 'border-rose-500/40 bg-rose-500/5'
                    : isQueued || isSyncing
                    ? 'border-amber-500/35 bg-amber-500/5'
                    : item.isActive
                    ? 'border-violet-500/35 bg-violet-500/5'
                    : 'border-slate-200 dark:border-slate-800'
                }`}
              >
                {/* Top Metadata + Status Badges */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-white">
                        {item.isSimulated ? '[SIMULATED] ' : ''}
                        {item.incidentId ? `#${item.incidentId}` : 'Offline Queue'} · {item.title}
                      </span>
                      <span className="rounded border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600 dark:text-slate-300">
                        {item.category}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        <span>Reported {formatTimestamp(item.createdAt)}</span>
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 text-violet-500" />
                        <span>{item.locationLabel || 'Location unavailable'}</span>
                      </span>
                      {item.operatorName && (
                        <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                          Responder: {item.operatorName}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.deliveryStatus && (
                      <span
                        className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                          item.deliveryStatus === 'delivered'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : item.deliveryStatus === 'failed'
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        alerts: {item.deliveryStatus}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${getStatusBadgeClasses(
                        item.lifecycleStatus
                      )}`}
                    >
                      {isSyncing && <Loader2 className="h-3 w-3 animate-spin" />}
                      {isQueued && <WifiOff className="h-3 w-3" />}
                      {item.lifecycleStatus === 'resolved' && <CheckCircle2 className="h-3 w-3" />}
                      <span>{item.statusLabel}</span>
                    </span>
                  </div>
                </div>

                {/* Progress Stepper + Reassurance Note */}
                <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-950/50 p-3 space-y-2">
                  <div className="grid grid-cols-4 gap-1.5">
                    {PROGRESS_LABELS.map((stepLabel, idx) => {
                      const reached = !isCancelled && item.progressStep >= idx;
                      const displayLabel =
                        idx === 3 && isCancelled ? 'Cancelled' : stepLabel;
                      return (
                        <div key={stepLabel} className="space-y-1">
                          <div
                            className={`h-1.5 rounded-full transition-colors ${
                              isCancelled && idx === 3
                                ? 'bg-slate-400 dark:bg-slate-500'
                                : isFailed && idx === 0
                                ? 'bg-rose-500'
                                : reached
                                ? idx === 3
                                  ? 'bg-emerald-500'
                                  : 'bg-violet-500'
                                : 'bg-slate-200 dark:bg-slate-800'
                            }`}
                          />
                          <div
                            className={`text-[10px] font-semibold ${
                              reached || (isCancelled && idx === 3)
                                ? 'text-slate-800 dark:text-slate-200'
                                : 'text-slate-400 dark:text-slate-500'
                            }`}
                          >
                            {displayLabel}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">{item.reassuranceNote}</p>
                  {item.lastError && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-300 font-medium">
                      Last error: {item.lastError}
                    </p>
                  )}
                </div>

                {/* Actions Row */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(item.key)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    <span>
                      {expanded
                        ? 'Hide Status Timeline'
                        : item.origin === 'server_incident'
                        ? `View Status Timeline & Delivery (${item.updates.length} updates)`
                        : 'View Queue Details'}
                    </span>
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    {item.origin === 'offline_queue' && (isQueued || isFailed) && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleRetryQueued(item)}
                          className="inline-flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>Retry Sync Now</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDiscardQueued(item)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-rose-500/40 hover:text-rose-600 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Discard</span>
                        </button>
                      </>
                    )}

                    {item.origin === 'server_incident' && item.incidentId && item.isActive && (
                      <button
                        type="button"
                        disabled={cancellingId === item.incidentId}
                        onClick={() => {
                          void onMarkSafeIncident(item.incidentId!);
                        }}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-60"
                      >
                        {cancellingId === item.incidentId ? 'Updating...' : t(language, 'dash_mark_safe')}
                      </button>
                    )}
                  </div>
                </div>

                {/* Expandable Timeline & Delivery Audit */}
                {expanded && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3.5 space-y-3 text-xs">
                    {item.description && (
                      <div>
                        <div className="font-semibold text-slate-700 dark:text-slate-200">Details Shared</div>
                        <p className="mt-0.5 text-slate-600 dark:text-slate-300 whitespace-pre-line">
                          {item.description}
                        </p>
                      </div>
                    )}

                    {item.origin === 'offline_queue' ? (
                      <div className="grid gap-2 sm:grid-cols-3 text-[11px] text-slate-600 dark:text-slate-300">
                        <div>
                          <span className="font-semibold">Sync Attempts:</span> {item.attempts ?? 0}/{item.maxRetries ?? 5}
                        </div>
                        <div>
                          <span className="font-semibold">Next Retry:</span> {formatTimestamp(item.nextRetryAt)}
                        </div>
                        <div className="font-mono truncate">
                          <span className="font-sans font-semibold">Dedup Key:</span> {item.idempotencyKey}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-2 sm:grid-cols-3 text-[11px] text-slate-600 dark:text-slate-300">
                          <div>
                            <span className="font-semibold">Submitted:</span> {formatTimestamp(item.createdAt)}
                          </div>
                          <div>
                            <span className="font-semibold">Acknowledged:</span> {formatTimestamp(item.acknowledgedAt)}
                          </div>
                          <div>
                            <span className="font-semibold">Resolved:</span> {formatTimestamp(item.resolvedAt)}
                          </div>
                        </div>

                        {item.updates.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-semibold text-slate-700 dark:text-slate-200">Status Timeline</div>
                            <div className="space-y-1.5">
                              {item.updates.map((upd) => (
                                <div
                                  key={upd.id}
                                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-2.5 py-1.5 text-[11px]"
                                >
                                  <div>
                                    <span className="font-semibold text-slate-900 dark:text-white">{upd.newStatus}</span>
                                    {upd.authorName && (
                                      <span className="text-slate-500 dark:text-slate-400"> · {upd.authorName}</span>
                                    )}
                                    {upd.note && (
                                      <div className="text-slate-600 dark:text-slate-300 mt-0.5">{upd.note}</div>
                                    )}
                                  </div>
                                  <span className="text-slate-400 tabular-nums">{formatTimestamp(upd.createdAt)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {item.deliveryLogs.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-semibold text-slate-700 dark:text-slate-200">
                              Trusted Contact Alert Delivery
                            </div>
                            <div className="space-y-1">
                              {item.deliveryLogs.map((log) => (
                                <div
                                  key={log.id}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-2.5 py-1.5 text-[11px]"
                                >
                                  <span className="text-slate-700 dark:text-slate-300">
                                    {log.recipient} ({log.channel})
                                  </span>
                                  <span
                                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                                      log.status === 'delivered' || log.status === 'simulated'
                                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                        : log.status === 'failed'
                                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                    }`}
                                  >
                                    {log.status} · {log.provider}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {filteredReports.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full rounded-xl border border-slate-200 dark:border-slate-800 py-2 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-500/5"
            >
              {showAll ? 'Show Fewer SOS Reports' : `Show All ${filteredReports.length} SOS Reports`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
