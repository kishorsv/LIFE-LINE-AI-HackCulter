import React, { useCallback, useEffect, useState } from 'react';
import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, ClipboardList, Lock, Radio, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { LifeLineLogo } from './LifeLineLogo.tsx';
import {
  AnalyticsSummary,
  AppUser,
  AuditLogEntry,
  EmergencyIncident,
  ResponderInfo,
  UserRole,
} from '../types/lifeline.ts';

export function OperatorDashboard() {
  const { user, operatorIncidents, demoMode, loginDemoRole, mapsApiKey, apiFetch, refreshAllData } = useAuth();
  const [tab, setTab] = useState<'queue' | 'analytics' | 'audit' | 'roles'>('queue');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [pagedQueue, setPagedQueue] = useState<EmergencyIncident[] | null>(null);
  const [queuePage, setQueuePage] = useState(1);
  const [queueTotalPages, setQueueTotalPages] = useState(1);
  const [adminUsers, setAdminUsers] = useState<AppUser[]>([]);
  const [responders, setResponders] = useState<ResponderInfo[]>([]);
  const [assignOperatorId, setAssignOperatorId] = useState<string>('');
  const [myStatus, setMyStatus] = useState<'Available' | 'Responding' | 'Off Duty'>('Available');
  const [actionError, setActionError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const isAuthorized = Boolean(
    user && ['emergency_operator', 'support_organization', 'administrator'].includes(user.role)
  );

  const loadOperatorResources = useCallback(async () => {
    if (!isAuthorized || !user) return;
    apiFetch<AnalyticsSummary>('/api/analytics').then(setAnalytics).catch(() => {});
    apiFetch<{ responders: ResponderInfo[] }>('/api/operator/responders')
      .then((d) => {
        setResponders(d.responders);
        const me = d.responders.find((r) => r.id === user.id);
        if (me) setMyStatus(me.responderStatus);
        if (!assignOperatorId && d.responders.length > 0) {
          setAssignOperatorId(String(me?.id || d.responders[0].id));
        }
      })
      .catch(() => {});

    apiFetch<{ incidents: EmergencyIncident[]; pagination?: { totalPages: number } }>(
      `/api/operator/incidents?page=${queuePage}&limit=25`
    )
      .then((d) => {
        setPagedQueue(d.incidents);
        if (d.pagination?.totalPages) setQueueTotalPages(d.pagination.totalPages);
      })
      .catch(() => {});

    if (['administrator', 'emergency_operator'].includes(user.role)) {
      apiFetch<{ logs: AuditLogEntry[]; pagination?: { totalPages: number } }>(
        `/api/admin/audit-logs?page=${auditPage}&limit=25`
      )
        .then((d) => {
          setAuditLogs(d.logs);
          if (d.pagination?.totalPages) setAuditTotalPages(d.pagination.totalPages);
        })
        .catch(() => {});
    }
    if (user.role === 'administrator') {
      apiFetch<{ users: AppUser[] }>('/api/admin/users')
        .then((d) => setAdminUsers(d.users))
        .catch(() => {});
    }
  }, [isAuthorized, user, apiFetch, queuePage, auditPage, assignOperatorId]);

  useEffect(() => {
    void loadOperatorResources();
  }, [loadOperatorResources, operatorIncidents.length]);

  if (!isAuthorized) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center space-y-4">
        <Lock className="mx-auto h-10 w-10 text-violet-500" />
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          Authorized Responder Access Required
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Your current role (<strong>{user?.role || 'guest'}</strong>) does not have Emergency Operator or Support
          Organization permissions.
        </p>
        {demoMode && (
          <button
            type="button"
            onClick={() => loginDemoRole('emergency_operator')}
            className="rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"
          >
            Switch to Demo Emergency Operator Sandbox
          </button>
        )}
      </div>
    );
  }

  const activeSourceIncidents = queuePage === 1 && operatorIncidents.length > 0 ? operatorIncidents : pagedQueue || operatorIncidents;
  const filteredIncidents = activeSourceIncidents.filter((i) =>
    priorityFilter === 'ALL' ? true : i.priority === priorityFilter
  );
  const selectedIncident: EmergencyIncident | undefined =
    filteredIncidents.find((i) => i.id === selectedId) || filteredIncidents[0];
  const mappableIncidents = filteredIncidents.filter(
    (i): i is EmergencyIncident & { latitude: number; longitude: number } =>
      typeof i.latitude === 'number' && typeof i.longitude === 'number'
  );

  const handleAvailabilityChange = async (status: 'Available' | 'Responding' | 'Off Duty') => {
    setActionError('');
    setActionMsg('');
    try {
      await apiFetch('/api/operator/availability', {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setMyStatus(status);
      setActionMsg(`Responder availability updated to ${status}.`);
      await loadOperatorResources();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update responder availability.');
    }
  };

  const handleAssignResponder = async (incidentId: number) => {
    if (!assignOperatorId) return;
    setActionError('');
    setActionMsg('');
    try {
      await apiFetch(`/api/operator/incidents/${incidentId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ operatorUserId: Number(assignOperatorId) }),
      });
      setActionMsg(`Assigned Incident #${incidentId} to responder.`);
      await refreshAllData();
      await loadOperatorResources();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Responder assignment failed.');
    }
  };

  const handleStatusUpdate = async (incidentId: number, status: EmergencyIncident['status']) => {
    setActionError('');
    setActionMsg('');
    try {
      await apiFetch(`/api/incidents/${incidentId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          note: noteText.trim() || `Operator updated status to ${status}`,
          isInternal: isInternalNote,
        }),
      });
      setNoteText('');
      setIsInternalNote(false);
      await refreshAllData();
      await loadOperatorResources();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Status update failed.');
    }
  };

  const handleRoleChange = async (targetUserId: number, role: UserRole) => {
    try {
      await apiFetch(`/api/admin/users/${targetUserId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      const res = await apiFetch<{ users: AppUser[] }>('/api/admin/users');
      setAdminUsers(res.users);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Role update failed.');
    }
  };

  const COLORS = ['#8B5CF6', '#EC4899', '#10B981', '#F59E0B', '#38BDF8'];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LifeLineLogo variant="mark" size="md" />
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Live Emergency Command Center
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Signed in as <strong>{user?.displayName}</strong> ({user?.role}) · Real-time SOS feed &amp; responder telemetry
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0B1022] px-2.5 py-1.5 text-xs">
            <Radio
              className={`h-3.5 w-3.5 ${
                myStatus === 'Available'
                  ? 'text-emerald-500'
                  : myStatus === 'Responding'
                  ? 'text-amber-500'
                  : 'text-slate-400'
              }`}
            />
            <span className="text-slate-500 dark:text-slate-400">Duty:</span>
            <select
              value={myStatus}
              onChange={(e) => handleAvailabilityChange(e.target.value as 'Available' | 'Responding' | 'Off Duty')}
              className="bg-transparent font-semibold text-slate-900 dark:text-white focus:outline-none"
            >
              <option value="Available">Available</option>
              <option value="Responding">Responding</option>
              <option value="Off Duty">Off Duty</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setTab('queue')}
            className={`rounded-xl px-3.5 py-2 text-xs font-semibold ${
              tab === 'queue' ? 'bg-violet-600 text-white' : 'border border-slate-300 dark:border-slate-700'
            }`}
          >
            SOS Queue ({operatorIncidents.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('analytics')}
            className={`rounded-xl px-3.5 py-2 text-xs font-semibold ${
              tab === 'analytics' ? 'bg-violet-600 text-white' : 'border border-slate-300 dark:border-slate-700'
            }`}
          >
            Analytics Dashboard
          </button>
          {['administrator', 'emergency_operator'].includes(user!.role) && (
            <button
              type="button"
              onClick={() => setTab('audit')}
              className={`rounded-xl px-3.5 py-2 text-xs font-semibold ${
                tab === 'audit' ? 'bg-violet-600 text-white' : 'border border-slate-300 dark:border-slate-700'
              }`}
            >
              Audit Logs
            </button>
          )}
          {user!.role === 'administrator' && (
            <button
              type="button"
              onClick={() => setTab('roles')}
              className={`rounded-xl px-3.5 py-2 text-xs font-semibold ${
                tab === 'roles' ? 'bg-violet-600 text-white' : 'border border-slate-300 dark:border-slate-700'
              }`}
            >
              Role Governance
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2 text-xs text-rose-600 dark:text-rose-300">
          {actionError}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {actionMsg}
        </div>
      )}

      {/* Active Responder Availability Roster */}
      {responders.length > 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] px-4 py-3 flex flex-wrap items-center gap-2.5 text-xs">
          <span className="font-semibold text-slate-600 dark:text-slate-300 mr-1">Active Responders:</span>
          {responders.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  r.responderStatus === 'Available'
                    ? 'bg-emerald-500'
                    : r.responderStatus === 'Responding'
                    ? 'bg-amber-500'
                    : 'bg-slate-400'
                }`}
              />
              <span className="font-medium text-slate-900 dark:text-white">{r.displayName}</span>
              <span className="font-mono text-[10px] text-slate-500">
                ({r.responderStatus} · {r.activeAssignedCount} active)
              </span>
            </span>
          ))}
        </div>
      )}

      {tab === 'queue' && (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Incident List */}
          <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Active & Historical SOS</span>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              >
                <option value="ALL">All Priorities</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
              </select>
            </div>

            <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
              {filteredIncidents.map((inc) => (
                <button
                  key={inc.id}
                  type="button"
                  onClick={() => setSelectedId(inc.id)}
                  className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
                    selectedIncident?.id === inc.id
                      ? 'border-violet-500 bg-violet-500/10'
                      : 'border-slate-200 dark:border-slate-800 hover:border-violet-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      {inc.isSimulated ? '[SIMULATED] ' : ''}#{inc.id} · {inc.title}
                    </span>
                    <span className="rounded bg-rose-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-rose-600 dark:text-rose-300">
                      {inc.priority}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {inc.reporterName} · {inc.status} {inc.operatorName ? `· Assigned: ${inc.operatorName}` : ''}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 truncate">{inc.locationLabel}</div>
                </button>
              ))}
            </div>
            {queueTotalPages > 1 && (
              <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px]">
                <button
                  type="button"
                  disabled={queuePage <= 1}
                  onClick={() => setQueuePage((p) => Math.max(1, p - 1))}
                  className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="font-mono text-slate-500">
                  Page {queuePage} of {queueTotalPages}
                </span>
                <button
                  type="button"
                  disabled={queuePage >= queueTotalPages}
                  onClick={() => setQueuePage((p) => Math.min(queueTotalPages, p + 1))}
                  className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>

          {/* Incident Detail + Map + Operator Actions */}
          <div className="lg:col-span-7 space-y-5">
            {selectedIncident ? (
              <>
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-mono text-violet-500">
                        INCIDENT #{selectedIncident.id} · {selectedIncident.isSimulated ? 'SIMULATED SANDBOX' : 'LIVE REPORT'}
                      </div>
                      <h2 className="mt-1 font-display text-xl font-bold text-slate-900 dark:text-white">
                        {selectedIncident.title}
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Reporter: {selectedIncident.reporterName} ({selectedIncident.reporterEmail}) · Created{' '}
                        {new Date(selectedIncident.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-1 text-xs font-bold text-violet-700 dark:text-violet-300">
                      {selectedIncident.status}
                    </span>
                  </div>

                  <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                    {selectedIncident.description}
                  </p>

                  {/* Responder Assignment Bar */}
                  {responders.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-xs">
                      <div className="text-slate-600 dark:text-slate-300">
                        <strong>Assigned Responder:</strong>{' '}
                        {selectedIncident.operatorName || 'Unassigned'}
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={assignOperatorId}
                          onChange={(e) => setAssignOperatorId(e.target.value)}
                          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                        >
                          {responders.map((r) => (
                            <option key={r.id} value={String(r.id)}>
                              {r.displayName} ({r.responderStatus})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleAssignResponder(selectedIncident.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 dark:bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white"
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          <span>Assign</span>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
                    <textarea
                      rows={2}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Add operator coordination note..."
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
                    />
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-400">
                      <input
                        type="checkbox"
                        checked={isInternalNote}
                        onChange={(e) => setIsInternalNote(e.target.checked)}
                      />
                      <span>Internal responder note (hidden from reporter timeline)</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleStatusUpdate(selectedIncident.id, 'Acknowledged')}
                        className="rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-500"
                      >
                        Acknowledge Alert
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStatusUpdate(selectedIncident.id, 'Assistance in Progress')}
                        className="rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500"
                      >
                        Assistance in Progress
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStatusUpdate(selectedIncident.id, 'Resolved')}
                        className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Mark Resolved</span>
                      </button>
                    </div>
                  </div>

                  {/* Audit Timeline */}
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Response Timeline</div>
                    {selectedIncident.updates.map((u) => (
                      <div key={u.id} className="text-xs text-slate-600 dark:text-slate-300 flex justify-between gap-2">
                        <span>
                          <strong>{u.newStatus}</strong>
                          {u.isInternal ? ' [INTERNAL]' : ''} — {u.note} ({u.authorName})
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {new Date(u.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live Multi-Incident Command Map */}
                {mapsApiKey && selectedIncident.latitude != null && selectedIncident.longitude != null && (
                  <div className="h-64 w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 relative">
                    <APIProvider apiKey={mapsApiKey}>
                      <GoogleMap
                        center={{ lat: selectedIncident.latitude, lng: selectedIncident.longitude }}
                        defaultZoom={13}
                        mapId="DEMO_MAP_ID"
                        internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                        style={{ width: '100%', height: '100%' }}
                      >
                        {mappableIncidents.map((inc) => (
                          <AdvancedMarker
                            key={inc.id}
                            position={{ lat: inc.latitude, lng: inc.longitude }}
                            onClick={() => setSelectedId(inc.id)}
                          >
                            <Pin
                              background={
                                inc.id === selectedIncident.id
                                  ? '#E11D48'
                                  : inc.status === 'Resolved' || inc.status === 'Cancelled'
                                  ? '#10B981'
                                  : '#F59E0B'
                              }
                              borderColor={inc.id === selectedIncident.id ? '#FFFFFF' : '#0F172A'}
                              glyphColor="#FFFFFF"
                            />
                          </AdvancedMarker>
                        ))}
                      </GoogleMap>
                    </APIProvider>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-12 text-center text-xs text-slate-500">
                No incidents match the selected filter.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Analytics Dashboard (strictly separating Live vs Simulated Metrics) */}
      {tab === 'analytics' && analytics && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Real Live Operational Metrics */}
            <div className="rounded-2xl border border-emerald-500/35 bg-white dark:bg-[#0B1022] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  Live Operational Metrics
                </h2>
                <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  REAL DATABASE DATA
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Total Live</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums">{analytics.liveStats.total}</div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Active Now</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums text-rose-500">
                    {analytics.liveStats.active}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Avg Ack (s)</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums">
                    {analytics.liveStats.avgAckSeconds ?? '—'}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Avg Resolve (s)</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums text-emerald-500">
                    {analytics.liveStats.avgResolutionSeconds ?? '—'}
                  </div>
                </div>
              </div>
              {analytics.responders && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Responder Fleet: {analytics.responders.available} Available · {analytics.responders.responding} Responding ·{' '}
                  {analytics.responders.offDuty} Off Duty
                </div>
              )}
            </div>

            {/* Simulated Demo Metrics */}
            <div className="rounded-2xl border border-amber-500/35 bg-white dark:bg-[#0B1022] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  Simulated Sandbox Metrics
                </h2>
                <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  [SIMULATED] DEMO DATA
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Total Demo</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums">{analytics.demoStats.total}</div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Active Demo</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums text-amber-500">
                    {analytics.demoStats.active}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-[11px] text-slate-500">Resolved Demo</div>
                  <div className="font-display text-2xl font-extrabold tabular-nums text-emerald-500">
                    {analytics.demoStats.resolved}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5">
              <h3 className="font-display text-sm font-bold mb-4">Support Directory Resource Distribution</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.resourceDistribution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                    <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#8B5CF6" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5">
              <h3 className="font-display text-sm font-bold mb-4">Simulated Incidents by Category</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={
                        analytics.demoStats.byCategory.length
                          ? analytics.demoStats.byCategory
                          : [{ name: 'No Data', count: 1 }]
                      }
                      dataKey="count"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label
                    >
                      {(analytics.demoStats.byCategory.length
                        ? analytics.demoStats.byCategory
                        : [{ name: 'No Data', count: 1 }]
                      ).map((_, idx) => (
                        <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Audit Logs */}
      {tab === 'audit' && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-violet-500" />
              <h2 className="font-display text-base font-bold">Immutable Platform Audit Trail</h2>
            </div>
            {auditTotalPages > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  disabled={auditPage <= 1}
                  onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                  className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="font-mono text-slate-500">
                  Page {auditPage} of {auditTotalPages}
                </span>
                <button
                  type="button"
                  disabled={auditPage >= auditTotalPages}
                  onClick={() => setAuditPage((p) => Math.min(auditTotalPages, p + 1))}
                  className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Timestamp</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2">Resource</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2 pr-4 font-mono text-[11px]">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4">{log.actorEmail}</td>
                    <td className="py-2 pr-4">{log.actorRole}</td>
                    <td className="py-2 pr-4 font-mono text-violet-600 dark:text-violet-400">{log.action}</td>
                    <td className="py-2">
                      {log.resourceType} #{log.resourceId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Admin Role Governance */}
      {tab === 'roles' && user!.role === 'administrator' && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-amber-500" />
            <h2 className="font-display text-base font-bold">Administrator Role Governance</h2>
          </div>
          <div className="space-y-2.5">
            {adminUsers.map((u) => (
              <div
                key={u.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 text-xs"
              >
                <div>
                  <div className="font-bold text-slate-900 dark:text-white">
                    {u.displayName} {u.isDemoAccount ? '(Demo Sandbox)' : ''}
                  </div>
                  <div className="text-slate-500">{u.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-violet-500" />
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  >
                    <option value="regular_user">regular_user</option>
                    <option value="emergency_operator">emergency_operator</option>
                    <option value="support_organization">support_organization</option>
                    <option value="administrator">administrator</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
