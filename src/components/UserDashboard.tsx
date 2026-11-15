import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CalendarPlus,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FolderUp,
  ListTodo,
  Mail,
  MapPin,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatGoogleAuthError } from '../lib/firebaseAuthErrors.ts';
import { FirebaseAuthBlockedAlert } from './FirebaseAuthBlockedAlert.tsx';
import { ActiveView, AiRecommendationItem, SupportResource, WorkspaceConfirmPayload } from '../types/lifeline.ts';
import {
  createSafetyActionTask,
  createSafetyPlanDoc,
  exportIncidentSheet,
  fetchRecentSafetyEmails,
  importGoogleContacts,
  saveReportToDrive,
  scheduleSafetyCheckInCalendar,
  sendEmergencyGmail,
} from '../lib/workspace.ts';

interface UserDashboardProps {
  onNavigate: (view: ActiveView) => void;
  onOpenSos: () => void;
  onRequestWorkspaceConfirm: (payload: WorkspaceConfirmPayload) => void;
}

export function UserDashboard({ onNavigate, onOpenSos, onRequestWorkspaceConfirm }: UserDashboardProps) {
  const {
    user,
    profile,
    contacts,
    incidents,
    notifications,
    googleAccessToken,
    connectWorkspaceOAuth,
    developerContactEmail,
    authBlockedAlert,
    dismissAuthBlockedAlert,
    apiFetch,
    refreshAllData,
    realtimeConnected,
  } = useAuth();

  const [safetyStatus, setSafetyStatus] = useState(profile?.safetyStatus || 'Safe');
  const [liveLocText, setLiveLocText] = useState(profile?.lastLocationLabel || 'Location sharing on SOS only');
  const [nearbyPreview, setNearbyPreview] = useState<SupportResource[]>([]);
  const [recommendations, setRecommendations] = useState<AiRecommendationItem[]>([]);

  // New contact form
  const [showAddContact, setShowAddContact] = useState(false);
  const [cName, setCName] = useState('');
  const [cRel, setCRel] = useState('Family');
  const [cEmail, setCEmail] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [workspaceStatusMsg, setWorkspaceStatusMsg] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');

  useEffect(() => {
    if (profile) {
      setSafetyStatus(profile.safetyStatus || 'Safe');
      setLiveLocText(profile.lastLocationLabel || 'Location sharing on SOS only');
    }
  }, [profile]);

  useEffect(() => {
    fetch('/api/support-directory')
      .then((r) => r.json())
      .then((d: { resources?: SupportResource[] }) => setNearbyPreview((d.resources || []).slice(0, 3)))
      .catch(() => {});
    if (user) {
      apiFetch<{ recommendations: AiRecommendationItem[] }>('/api/ai/recommendations')
        .then((d) => setRecommendations(d.recommendations || []))
        .catch(() => {});
    }
  }, [user, apiFetch]);

  const handleStatusChange = async (nextStatus: string) => {
    setSafetyStatus(nextStatus);
    await apiFetch('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({ safetyStatus: nextStatus }),
    });
    await refreshAllData();
  };

  const handleCaptureGps = () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          setWorkspaceError('Browser returned invalid GPS coordinates.');
          return;
        }
        const label = `GPS ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        setLiveLocText(label);
        await apiFetch('/api/profile', {
          method: 'PUT',
          body: JSON.stringify({
            lastKnownLat: latitude,
            lastKnownLng: longitude,
            lastLocationLabel: label,
            locationSharingConsent: true,
          }),
        });
        await refreshAllData();
      },
      () => {
        setWorkspaceError('GPS location permission denied or unavailable.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name: cName,
        relationship: cRel,
        email: cEmail,
        phone: cPhone,
        notifyEmail: Boolean(cEmail),
        notifySms: Boolean(cPhone),
      }),
    });
    setCName('');
    setCEmail('');
    setCPhone('');
    setShowAddContact(false);
    await refreshAllData();
  };

  const handleDeleteContact = async (id: number) => {
    await apiFetch(`/api/contacts/${id}`, { method: 'DELETE' });
    await refreshAllData();
  };

  const ensureWorkspaceToken = async (): Promise<string | null> => {
    if (googleAccessToken) return googleAccessToken;
    setWorkspaceError('');
    try {
      const tok = await connectWorkspaceOAuth();
      if (!tok) {
        setWorkspaceError('Google Workspace did not return an OAuth access token. Ensure test-user access is approved and try again.');
      }
      return tok;
    } catch (err) {
      const formatted = formatGoogleAuthError(err, { mode: 'workspace' });
      setWorkspaceError(`${formatted.title}: ${formatted.message}`);
      return null;
    }
  };

  const handleImportGoogleContacts = async () => {
    setWorkspaceError('');
    setWorkspaceStatusMsg('');
    try {
      const tok = await ensureWorkspaceToken();
      if (!tok) return;
      const imported = await importGoogleContacts(tok);
      if (imported.length === 0) {
        setWorkspaceStatusMsg('No contacts with email or phone were found in your Google Contacts.');
        return;
      }
      for (const item of imported.slice(0, 3)) {
        await apiFetch('/api/contacts', {
          method: 'POST',
          body: JSON.stringify({
            name: item.name,
            relationship: 'Google Contact',
            email: item.email,
            phone: item.phone,
            notifyEmail: Boolean(item.email),
            notifySms: Boolean(item.phone),
            source: 'google_contacts',
          }),
        });
      }
      await refreshAllData();
      setWorkspaceStatusMsg(`Imported ${Math.min(3, imported.length)} trusted contact(s) from Google Contacts.`);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : 'Google Contacts import failed.');
    }
  };

  const handleReadSafetyEmails = async () => {
    setWorkspaceError('');
    try {
      const tok = await ensureWorkspaceToken();
      if (!tok) return;
      const mails = await fetchRecentSafetyEmails(tok);
      setWorkspaceStatusMsg(`Checked Gmail: found ${mails.length} matching safety thread(s).`);
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : 'Failed to check Gmail.');
    }
  };

  // Mutating Workspace Actions — ALWAYS gated by WorkspaceConfirmModal
  const triggerWorkspaceEmailAlert = async () => {
    const primaryEmail = contacts.find((c) => c.email)?.email;
    if (!primaryEmail) {
      setWorkspaceError('Add at least one trusted contact with an email address first.');
      return;
    }
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'gmail_send',
      title: 'Send Check-In Email via Gmail',
      description: `This will send a safety check-in message directly from your Gmail account to ${primaryEmail}.`,
      details: [`Recipient: ${primaryEmail}`, `Location context: ${liveLocText}`, `Safety status: ${safetyStatus}`],
      onConfirm: async () => {
        await sendEmergencyGmail(
          tok,
          primaryEmail,
          `[LIFE-LINE AI] Safety Check-In from ${user?.displayName}`,
          `Hello,\n\nI am sharing a safety check-in from LIFE-LINE AI.\nCurrent Status: ${safetyStatus}\nLocation Context: ${liveLocText}\nTimestamp: ${new Date().toISOString()}`
        );
        setWorkspaceStatusMsg(`Gmail check-in sent to ${primaryEmail}.`);
      },
    });
  };

  const triggerCalendarCheckIn = async () => {
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'calendar_checkin',
      title: 'Schedule Safe Arrival Check-In',
      description: 'Creates a 15-minute safety check-in reminder on your primary Google Calendar 30 minutes from now.',
      details: ['Calendar: primary', 'Window: +30 minutes from now', `Location note: ${liveLocText}`],
      onConfirm: async () => {
        const res = await scheduleSafetyCheckInCalendar(
          tok,
          'LIFE-LINE AI Safe Arrival Check-In',
          `Automated safety reminder. Confirm safe arrival or trigger check-in. Location: ${liveLocText}`
        );
        setWorkspaceStatusMsg(`Google Calendar check-in created (${res.id}).`);
      },
    });
  };

  const triggerSheetsExport = async () => {
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'sheets_export',
      title: 'Export Incident History to Google Sheets',
      description: 'Creates a new Google Spreadsheet in your account containing your recorded safety incidents.',
      details: [`Incidents included: ${incidents.length}`, 'Columns: ID, Title, Status, Priority, Location, Timestamp'],
      onConfirm: async () => {
        const rows: Array<Array<string | number>> = [
          ['ID', 'Title', 'Status', 'Priority', 'Location', 'Simulated', 'Created At'],
          ...incidents.map((i) => [
            i.id,
            i.title,
            i.status,
            i.priority,
            i.locationLabel,
            i.isSimulated ? 'Yes' : 'No',
            i.createdAt,
          ]),
        ];
        const res = await exportIncidentSheet(tok, rows);
        setWorkspaceStatusMsg(`Exported to Google Sheets: ${res.spreadsheetUrl}`);
      },
    });
  };

  const triggerDocsSafetyPlan = async () => {
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'docs_safety_plan',
      title: 'Create Personal Safety Plan in Google Docs',
      description: 'Generates an editable Google Doc containing your trusted contacts, emergency notes, and AI safety tips.',
      details: [`Trusted contacts: ${contacts.length}`, `Medical notes included: ${profile?.medicalNotes ? 'Yes' : 'No'}`],
      onConfirm: async () => {
        const content = [
          `LIFE-LINE AI PERSONAL SAFETY PLAN — ${user?.displayName}\n`,
          `Generated: ${new Date().toISOString()}\n`,
          `Emergency Notes: ${profile?.emergencyNotes || 'None'}\n`,
          `Medical Notes: ${profile?.medicalNotes || 'None'}\n\n`,
          `TRUSTED CONTACTS:\n`,
          ...contacts.map((c) => `- ${c.name} (${c.relationship}): ${c.email || c.phone}\n`),
        ].join('');
        const doc = await createSafetyPlanDoc(tok, `LIFE-LINE AI Safety Plan — ${user?.displayName}`, content);
        setWorkspaceStatusMsg(`Safety Plan Doc created: ${doc.url}`);
      },
    });
  };

  const triggerDriveBackup = async () => {
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'drive_backup',
      title: 'Save Encrypted-Ready Safety Report to Google Drive',
      description: 'Uploads a JSON snapshot of your recent incidents and trusted contact roster to your Google Drive.',
      details: ['File type: application/json', `Records: ${incidents.length} incidents, ${contacts.length} contacts`],
      onConfirm: async () => {
        const file = await saveReportToDrive(
          tok,
          `lifeline-safety-report-${Date.now()}.json`,
          JSON.stringify({ user: user?.email, incidents, contacts, exportedAt: new Date().toISOString() }, null, 2)
        );
        setWorkspaceStatusMsg(`Saved safety report to Google Drive (File ID: ${file.id}).`);
      },
    });
  };

  const triggerCreateTask = async () => {
    const tok = await ensureWorkspaceToken();
    if (!tok) return;
    onRequestWorkspaceConfirm({
      actionType: 'tasks_create',
      title: 'Create Follow-Up Action in Google Tasks',
      description: 'Adds a personal safety preparedness checklist item to your default Google Tasks list.',
      details: ['Task: Verify trusted contact phone numbers & medical card in LIFE-LINE AI'],
      onConfirm: async () => {
        await createSafetyActionTask(
          tok,
          'Review LIFE-LINE AI Trusted Contacts & Safe Route',
          'Confirm at least two reachable emergency contacts and verify night-commute support hubs.'
        );
        setWorkspaceStatusMsg('Safety action item added to Google Tasks.');
      },
    });
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-8">
      {/* Welcome & Prominent SOS Banner */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8 rounded-2xl border border-slate-200 dark:border-violet-500/25 bg-white dark:bg-[#0B1022] p-6 flex flex-col justify-between gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                Personal Safety Hub · {user?.role.replace('_', ' ')}
              </div>
              <h1 className="mt-1 font-display text-2xl font-bold text-slate-900 dark:text-white">
                Welcome back, {user?.displayName}
              </h1>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Real-time WebSocket link: {realtimeConnected ? 'Connected' : 'Reconnecting...'} ·{' '}
                {user?.isDemoAccount ? 'Hackathon Demo Sandbox Account [SIMULATED]' : 'Verified Standard Session'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {['Safe', 'Cautious', 'Check-In Needed'].map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => handleStatusChange(st)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    safetyStatus === st
                      ? st === 'Safe'
                        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : st === 'Cautious'
                        ? 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        : 'border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-4 py-3">
            <div className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300">
              <MapPin className="h-4 w-4 text-violet-500 shrink-0" />
              <span>
                <strong>Live Location Status:</strong> {liveLocText}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCaptureGps}
                className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
              >
                Update GPS Now
              </button>
              <button
                type="button"
                onClick={() => onNavigate('map')}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Open Map
              </button>
            </div>
          </div>
        </div>

        {/* High-Visibility SOS Action Card */}
        <div className="lg:col-span-4 rounded-2xl border border-rose-500/40 bg-gradient-to-br from-rose-600/15 via-white to-violet-600/10 dark:from-rose-950/50 dark:via-[#0D1024] dark:to-violet-950/40 p-6 flex flex-col items-center justify-center text-center">
          <button
            type="button"
            onClick={onOpenSos}
            className="group relative flex h-24 w-24 items-center justify-center rounded-full bg-rose-600 text-white shadow-xl shadow-rose-600/40 hover:bg-rose-500 transition-transform active:scale-95"
          >
            <ShieldAlert className="h-10 w-10" />
          </button>
          <h2 className="mt-4 font-display text-lg font-bold text-slate-900 dark:text-white">Emergency SOS</h2>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            5-second cancellable alert to trusted contacts & active operators.
          </p>
        </div>
      </div>

      {/* Main Grid: Trusted Contacts, Recent Incidents, Nearby Support & AI Recommendations */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Trusted Contacts */}
        <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-violet-500" />
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Trusted Contacts ({contacts.length})
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImportGoogleContacts}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-violet-500/50"
              >
                <UserPlus className="h-3.5 w-3.5 text-violet-500" />
                <span>Import Google Contacts</span>
              </button>
              <button
                type="button"
                onClick={() => setShowAddContact((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add</span>
              </button>
            </div>
          </div>

          {showAddContact && (
            <form onSubmit={handleAddContact} className="mb-4 rounded-xl border border-violet-500/30 bg-slate-50 dark:bg-slate-900/60 p-4 space-y-3">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  placeholder="Full name"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
                <input
                  type="text"
                  value={cRel}
                  onChange={(e) => setCRel(e.target.value)}
                  placeholder="Relationship (e.g. Sister)"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
                <input
                  type="email"
                  value={cEmail}
                  onChange={(e) => setCEmail(e.target.value)}
                  placeholder="Email address"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
                <input
                  type="tel"
                  value={cPhone}
                  onChange={(e) => setCPhone(e.target.value)}
                  placeholder="Phone number"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddContact(false)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1 text-xs"
                >
                  Cancel
                </button>
                <button type="submit" className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white">
                  Save Contact
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2.5">
            {contacts.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No trusted contacts added yet. Add someone you trust or import from Google Contacts.
              </p>
            ) : (
              contacts.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3"
                >
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {c.name}{' '}
                      <span className="text-xs font-normal text-slate-500 dark:text-slate-400">· {c.relationship}</span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {[c.email, c.phone].filter(Boolean).join(' · ') || 'In-app contact'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteContact(c.id)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-500"
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Emergency Activity */}
        <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-rose-500" />
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Recent Emergency Activity
              </h2>
            </div>
            <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400">{incidents.length} recorded</span>
          </div>

          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
            {incidents.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No SOS incidents triggered yet. Use Emergency SOS or Hackathon Demo Mode to test the workflow.
              </p>
            ) : (
              incidents.slice(0, 6).map((inc) => (
                <div key={inc.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">
                      {inc.isSimulated ? '[SIMULATED] ' : ''}#{inc.id} · {inc.title}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {inc.deliveryStatus && (
                        <span
                          className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                            inc.deliveryStatus === 'delivered'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : inc.deliveryStatus === 'failed'
                              ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {inc.deliveryStatus}
                        </span>
                      )}
                      <span className="rounded-md border border-violet-500/35 bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                        {inc.status}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {inc.locationLabel} · Priority: {inc.priority}
                  </div>
                  {inc.operatorName && (
                    <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      Responder: {inc.operatorName}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Google Workspace Coordination Panel */}
      <div className="rounded-2xl border border-slate-200 dark:border-violet-500/25 bg-white dark:bg-[#0B1022] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Google Workspace Safety Integrations
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Every mutating Workspace action requires explicit confirmation before sending or writing data.
            </p>
          </div>
          {!googleAccessToken ? (
            <button
              type="button"
              onClick={() => {
                void ensureWorkspaceToken();
              }}
              className="rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500"
            >
              Connect Google Workspace
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Workspace Connected (In-Memory Token)
            </span>
          )}
        </div>

        {workspaceStatusMsg && (
          <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            {workspaceStatusMsg}
          </div>
        )}
        {authBlockedAlert?.mode === 'workspace' ? (
          <div className="mb-3">
            <FirebaseAuthBlockedAlert
              alert={authBlockedAlert}
              developerContactEmail={developerContactEmail}
              variant="inline"
              onRetryGoogle={() => {
                void ensureWorkspaceToken();
              }}
              onDismiss={() => {
                dismissAuthBlockedAlert();
                setWorkspaceError('');
              }}
            />
          </div>
        ) : (
          workspaceError && (
            <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
              {workspaceError}
            </div>
          )
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={triggerWorkspaceEmailAlert}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <Mail className="h-4 w-4 text-rose-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Send Gmail Check-In</div>
              <div className="text-slate-500 dark:text-slate-400">Notify primary contact</div>
            </div>
          </button>
          <button
            type="button"
            onClick={handleReadSafetyEmails}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <Mail className="h-4 w-4 text-violet-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Scan Safety Emails</div>
              <div className="text-slate-500 dark:text-slate-400">Read-only Gmail search</div>
            </div>
          </button>
          <button
            type="button"
            onClick={triggerCalendarCheckIn}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <CalendarPlus className="h-4 w-4 text-emerald-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Calendar Check-In</div>
              <div className="text-slate-500 dark:text-slate-400">Schedule +30m reminder</div>
            </div>
          </button>
          <button
            type="button"
            onClick={triggerSheetsExport}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <FileSpreadsheet className="h-4 w-4 text-emerald-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Export to Sheets</div>
              <div className="text-slate-500 dark:text-slate-400">Incident history log</div>
            </div>
          </button>
          <button
            type="button"
            onClick={triggerDocsSafetyPlan}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <FileText className="h-4 w-4 text-sky-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Create Safety Doc</div>
              <div className="text-slate-500 dark:text-slate-400">Personal plan in Docs</div>
            </div>
          </button>
          <button
            type="button"
            onClick={triggerDriveBackup}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <FolderUp className="h-4 w-4 text-amber-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Backup to Drive</div>
              <div className="text-slate-500 dark:text-slate-400">Save JSON safety report</div>
            </div>
          </button>
          <button
            type="button"
            onClick={triggerCreateTask}
            className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-left text-xs hover:border-violet-500/50"
          >
            <ListTodo className="h-4 w-4 text-purple-500 shrink-0" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">Add Google Task</div>
              <div className="text-slate-500 dark:text-slate-400">Preparedness checklist</div>
            </div>
          </button>
        </div>
      </div>

      {/* Nearby Support Preview + AI Safety Recommendations + Recent Notifications */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">Nearby Support Preview</h2>
            <button
              type="button"
              onClick={() => onNavigate('map')}
              className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
            >
              View All
            </button>
          </div>
          <div className="space-y-3">
            {nearbyPreview.map((r) => (
              <div key={r.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-xs font-bold text-slate-900 dark:text-white">{r.name}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {r.category} · {r.operatingHours}
                </div>
                <div className="mt-1 text-[10px] font-mono text-amber-600 dark:text-amber-300">
                  {r.source} · {r.verificationStatus}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">AI Recommendations</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('agents')}
              className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
            >
              Run Agent
            </button>
          </div>
          <div className="space-y-2.5">
            {recommendations.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Run an Emergency Assessment or Safety Intelligence scan in the AI Agents Hub to see tailored guidance here.
              </p>
            ) : (
              recommendations.slice(0, 4).map((rec) => (
                <div key={rec.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">{rec.title}</div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{rec.recommendationText}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="lg:col-span-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">Notification Center</h2>
          </div>
          <div className="space-y-2.5 max-h-60 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">No recent alerts.</p>
            ) : (
              notifications.slice(0, 5).map((n) => (
                <div key={n.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">{n.title}</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">{n.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
