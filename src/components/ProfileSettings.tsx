import React, { useEffect, useState } from 'react';
import { LogOut, MailCheck, Save, Shield, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { useTheme } from '../contexts/ThemeContext.tsx';

export function ProfileSettings({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { user, profile, preferences, apiFetch, refreshAllData, logout, setLanguage } = useAuth();
  const { theme, setTheme } = useTheme();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [emergencyNotes, setEmergencyNotes] = useState('');
  const [medicalNotes, setMedicalNotes] = useState('');
  const [bloodType, setBloodType] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('en');
  const [enableEmailAlerts, setEnableEmailAlerts] = useState(true);
  const [enableSmsAlerts, setEnableSmsAlerts] = useState(false);
  const [enableInAppAlerts, setEnableInAppAlerts] = useState(true);
  const [locationConsentMode, setLocationConsentMode] = useState('sos_only');
  const [dataRetentionDays, setDataRetentionDays] = useState(90);
  const [verifyCode, setVerifyCode] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName || user?.displayName || '');
      setPhone(profile.phone || '');
      setEmergencyNotes(profile.emergencyNotes || '');
      setMedicalNotes(profile.medicalNotes || '');
      setBloodType(profile.bloodType || '');
      setPreferredLanguage(profile.preferredLanguage || 'en');
    }
    if (preferences) {
      setEnableEmailAlerts(preferences.enableEmailAlerts);
      setEnableSmsAlerts(preferences.enableSmsAlerts);
      setEnableInAppAlerts(preferences.enableInAppAlerts);
      setLocationConsentMode(preferences.locationConsentMode);
      setDataRetentionDays(preferences.dataRetentionDays);
    }
  }, [profile, preferences, user?.displayName]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    setErr('');
    try {
      await apiFetch('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          fullName,
          phone,
          emergencyNotes,
          medicalNotes,
          bloodType,
          preferredLanguage,
          theme,
          enableEmailAlerts,
          enableSmsAlerts,
          enableInAppAlerts,
          locationConsentMode,
          dataRetentionDays,
        }),
      });
      await refreshAllData();
      setLanguage(preferredLanguage === 'kn' ? 'kn' : 'en');
      setMsg('Profile and privacy preferences saved.');
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Save failed.');
    }
  };

  const handleVerifyEmail = async () => {
    setErr('');
    setMsg('');
    try {
      await apiFetch('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code: verifyCode }),
      });
      await refreshAllData();
      setMsg('Email verified successfully.');
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Verification failed.');
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await apiFetch('/api/profile', { method: 'DELETE' });
      await logout();
      onLoggedOut();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Unable to delete account.');
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">Profile & Privacy Settings</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Account: {user?.email} · Role: {user?.role}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => {
            await logout();
            onLoggedOut();
          }}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign Out</span>
        </button>
      </div>

      {msg && (
        <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-600 dark:text-rose-300">
          {err}
        </div>
      )}

      {!user?.emailVerified && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-200">
            <MailCheck className="h-4 w-4 shrink-0" />
            <span>Your email is not yet verified. Enter your 6-digit verification code:</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder="6-digit code"
              className="rounded-lg border border-amber-500/40 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-mono"
            />
            <button
              type="button"
              onClick={handleVerifyEmail}
              className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white"
            >
              Verify
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Phone Number</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555-0100"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Blood Type (Optional)</label>
            <input
              type="text"
              value={bloodType}
              onChange={(e) => setBloodType(e.target.value)}
              placeholder="e.g. O+"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Preferred Language</label>
            <select
              value={preferredLanguage}
              onChange={(e) => setPreferredLanguage(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            >
              <option value="en">English</option>
              <option value="kn">ಕನ್ನಡ (Kannada)</option>
              <option value="es">Español</option>
              <option value="hi">हिन्दी</option>
              <option value="fr">Français</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Emergency Responder Notes</label>
            <textarea
              rows={3}
              value={emergencyNotes}
              onChange={(e) => setEmergencyNotes(e.target.value)}
              placeholder="Safe word, campus building, or critical instructions..."
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Medical / Allergy Notes</label>
            <textarea
              rows={3}
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
              placeholder="Allergies, asthma inhaler, medications..."
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="border-t border-slate-200 dark:border-slate-800 pt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Location Privacy Mode</label>
            <select
              value={locationConsentMode}
              onChange={(e) => setLocationConsentMode(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
            >
              <option value="sos_only">Share on SOS Activation Only</option>
              <option value="live_escort">Active Safe-Escort Sharing</option>
              <option value="manual_only">Manual Address Entry Only</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Data Retention Window</label>
            <select
              value={dataRetentionDays}
              onChange={(e) => setDataRetentionDays(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
            >
              <option value={30}>30 Days</option>
              <option value={90}>90 Days</option>
              <option value={365}>365 Days</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Appearance Theme</label>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
            >
              <option value="dark">Midnight Navy (Dark Mode)</option>
              <option value="light">Clean Daylight (Light Mode)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-5 text-xs text-slate-700 dark:text-slate-300">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enableInAppAlerts} onChange={(e) => setEnableInAppAlerts(e.target.checked)} />
            <span>In-App Real-Time Alerts</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enableEmailAlerts} onChange={(e) => setEnableEmailAlerts(e.target.checked)} />
            <span>Email Alerts (Gmail / Resend)</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enableSmsAlerts} onChange={(e) => setEnableSmsAlerts(e.target.checked)} />
            <span>SMS Alerts (when configured)</span>
          </label>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"
          >
            <Save className="h-4 w-4" />
            <span>Save Profile & Privacy</span>
          </button>
        </div>
      </form>

      {/* Account Deletion Workflow */}
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Shield className="h-5 w-5 text-rose-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Account Deletion & Data Removal</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Permanently deletes your profile, contacts, and personal records (unavailable for shared demo accounts).
            </p>
          </div>
        </div>
        {!confirmDelete ? (
          <button
            type="button"
            disabled={Boolean(user?.isDemoAccount)}
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/40 px-4 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete Account</span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeleteAccount}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Confirm Permanent Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
