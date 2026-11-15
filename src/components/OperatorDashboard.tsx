import React, { useEffect, useState } from 'react';
import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, ClipboardList, Lock, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { AnalyticsSummary, AppUser, AuditLogEntry, EmergencyIncident, UserRole } from '../types/lifeline.ts';

export function OperatorDashboard() {
  const { user, operatorIncidents, demoMode, loginDemoRole, mapsApiKey, apiFetch, refreshAllData } = useAuth();
  const [tab, setTab] = useState<'queue' | 'analytics' | 'audit' | 'roles'>('queue');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [adminUsers, setAdminUsers] = useState<AppUser[]>([]);
  const [actionError, setActionError] = useState('');

  const isAuthorized = Boolean(
    user && ['emergency_operator', 'support_organization', 'administrator'].includes(user.role)
  );

  useEffect(() => {
    if (!isAuthorized) return;
    apiFetch<AnalyticsSummary>('/api/analytics').then(setAnalytics).catch(() => {});
    if (['administrator', 'emergency_operator'].includes(user!.role)) {
      apiFetch<{ logs: AuditLogEntry[] }>('/api/admin/audit-logs')
        .then((d) => setAuditLogs(d.logs))
        .catch(() => {});
    }
    if (user!.role === 'administrator') {
      apiFetch<{ users: AppUser[] }>('/api/admin/users')
        .then((d) => setAdminUsers(d.users))
        .catch(() => {});
    }
  }, [isAuthorized, user, apiFetch, operatorIncidents.length]);

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

  const filteredIncidents = operatorIncidents.filter((i) =>
    priorityFilter === 'ALL' ? true : i.priority === priorityFilter
  );
  const selectedIncident: EmergencyIncident | undefined =
    filteredIncidents.find((i) => i.id === selectedId) || filteredIncidents[0];

  const handleStatusUpdate = async (incidentId: number, status: EmergencyIncident['status']) => {
    setActionError('');
    try {
      await apiFetch(`/api/incidents/${incidentId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          note: noteText.trim() || `Operator updated status to ${status}`,
        }),
      });
      setNoteText('');
      await refreshAllData();
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
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Emergency Operator & Governance Desk
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Signed in as <strong>{user?.displayName}</strong> ({user?.role}) · Real-time SOS feed active
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
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
                    {inc.reporterName} · {inc.status}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 truncate">{inc.locationLabel}</div>
                </button>
              ))}
            </div>
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

                  <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
                    <textarea
                      rows={2}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Add operator coordination note..."
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
                    />
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
                          <strong>{u.newStatus}</strong> — {u.note} ({u.authorName})
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {new Date(u.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live Operator Incident Map */}
                {mapsApiKey && selectedIncident.latitude != null && selectedIncident.longitude != null && (
                  <div className="h-64 w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
                    <APIProvider apiKey={mapsApiKey}>
                      <GoogleMap
                        center={{ lat: selectedIncident.latitude, lng: selectedIncident.longitude }}
                        defaultZoom={14}
                        mapId="DEMO_MAP_ID"
                        internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                        style={{ width: '100%', height: '100%' }}
                      >
                        <AdvancedMarker
                          position={{ lat: selectedIncident.latitude, lng: selectedIncident.longitude }}
                        >
                          <Pin background="#E11D48" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
                        </AdvancedMarker>
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
              <div className="grid grid-cols-3 gap-3 text-center">
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
              </div>
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
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex items-center gap-2 mb-4">
            <ClipboardList className="h-5 w-5 text-violet-500" />
            <h2 className="font-display text-base font-bold">Immutable Platform Audit Trail</h2>
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
