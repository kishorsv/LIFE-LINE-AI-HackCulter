import React, { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ThemeProvider } from './contexts/ThemeContext.tsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import { ActiveView, WorkspaceConfirmPayload } from './types/lifeline.ts';
import { Navbar } from './components/Navbar.tsx';
import { LandingPage } from './components/LandingPage.tsx';
import { UserDashboard } from './components/UserDashboard.tsx';
import { LiveMapPage } from './components/LiveMapPage.tsx';
import { AiAgentsHub } from './components/AiAgentsHub.tsx';
import { OperatorDashboard } from './components/OperatorDashboard.tsx';
import { ProfileSettings } from './components/ProfileSettings.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { SosModal } from './components/SosModal.tsx';
import { WorkspaceConfirmModal } from './components/WorkspaceConfirmModal.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import {
  clearLegacySharedSosQueue,
  getQueuedSosAlerts,
  getRetryableQueuedSosAlerts,
  recordQueuedSosRetryFailure,
  removeQueuedSos,
} from './lib/offlineSosQueue.ts';

function AppShell() {
  const { user, loading, notifications, apiFetch, refreshAllData } = useAuth();
  const [activeView, setActiveView] = useState<ActiveView>('landing');
  const [authOpen, setAuthOpen] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const [notifDrawerOpen, setNotifDrawerOpen] = useState(false);
  const [workspaceConfirm, setWorkspaceConfirm] = useState<WorkspaceConfirmPayload | null>(null);
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);
  const [queuedSosCount, setQueuedSosCount] = useState(0);
  const [failedSosCount, setFailedSosCount] = useState(0);
  const flushingRef = React.useRef(false);

  useEffect(() => {
    clearLegacySharedSosQueue();
    const onQuota = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  useEffect(() => {
    const syncQueueCounts = () => {
      const items = getQueuedSosAlerts(user);
      setQueuedSosCount(items.filter((i) => i.state === 'queued').length);
      setFailedSosCount(items.filter((i) => i.state === 'failed').length);
    };

    const flushQueue = async () => {
      if (!user || !navigator.onLine || flushingRef.current) {
        syncQueueCounts();
        return;
      }
      const retryable = getRetryableQueuedSosAlerts(user);
      if (retryable.length === 0) {
        syncQueueCounts();
        return;
      }

      flushingRef.current = true;
      let anySynced = false;
      try {
        for (const item of retryable) {
          try {
            await apiFetch('/api/incidents/sos', {
              method: 'POST',
              body: JSON.stringify({
                idempotencyKey: item.idempotencyKey,
                clientQueuedAt: item.queuedAt,
                title: item.title,
                description: item.description,
                category: item.category,
                priority: item.priority,
                latitude: item.latitude,
                longitude: item.longitude,
                locationLabel: item.locationLabel,
                locationAccuracyMeters: item.locationAccuracyMeters,
                isSimulated: item.isSimulated,
              }),
            });
            removeQueuedSos(item.id, user);
            anySynced = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Network error';
            const isPermanentValidationErr = /invalid|forbidden|unauthorized|must be/i.test(msg);
            recordQueuedSosRetryFailure(item.id, user, msg, { permanent: isPermanentValidationErr });
            if (!isPermanentValidationErr) break;
          }
        }
      } finally {
        flushingRef.current = false;
        syncQueueCounts();
        if (anySynced) {
          await refreshAllData();
        }
      }
    };

    syncQueueCounts();
    window.addEventListener('lifeline-sos-queue-updated', syncQueueCounts);
    window.addEventListener('online', flushQueue);
    const retryTimer = setInterval(flushQueue, 15_000);
    void flushQueue();

    return () => {
      clearInterval(retryTimer);
      window.removeEventListener('lifeline-sos-queue-updated', syncQueueCounts);
      window.removeEventListener('online', flushQueue);
    };
  }, [user, apiFetch, refreshAllData]);

  const handleMarkNotificationRead = async (id: number) => {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' });
    await refreshAllData();
  };

  const renderMainContent = () => {
    if (loading) {
      return (
        <div className="mx-auto max-w-7xl px-4 py-20 text-center text-sm text-slate-500 dark:text-slate-400">
          Initializing LIFE-LINE AI Safety Session...
        </div>
      );
    }

    switch (activeView) {
      case 'landing':
        return (
          <LandingPage
            onNavigate={setActiveView}
            onOpenAuth={() => setAuthOpen(true)}
            onOpenSos={() => setSosOpen(true)}
          />
        );
      case 'map':
        return <LiveMapPage />;
      case 'dashboard':
        return user ? (
          <UserDashboard
            onNavigate={setActiveView}
            onOpenSos={() => setSosOpen(true)}
            onRequestWorkspaceConfirm={setWorkspaceConfirm}
          />
        ) : (
          <LandingPage
            onNavigate={setActiveView}
            onOpenAuth={() => setAuthOpen(true)}
            onOpenSos={() => setSosOpen(true)}
          />
        );
      case 'agents':
        return user ? (
          <AiAgentsHub />
        ) : (
          <LandingPage
            onNavigate={setActiveView}
            onOpenAuth={() => setAuthOpen(true)}
            onOpenSos={() => setSosOpen(true)}
          />
        );
      case 'operator':
        return user ? (
          <OperatorDashboard />
        ) : (
          <LandingPage
            onNavigate={setActiveView}
            onOpenAuth={() => setAuthOpen(true)}
            onOpenSos={() => setSosOpen(true)}
          />
        );
      case 'profile':
        return user ? (
          <ProfileSettings onLoggedOut={() => setActiveView('landing')} />
        ) : (
          <LandingPage
            onNavigate={setActiveView}
            onOpenAuth={() => setAuthOpen(true)}
            onOpenSos={() => setSosOpen(true)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#060916] text-slate-900 dark:text-slate-100 transition-colors">
      {/* Case A Demo Key Quota Banner */}
      {mapsQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      <Navbar
        activeView={activeView}
        onNavigate={setActiveView}
        onOpenAuth={() => setAuthOpen(true)}
        onOpenSos={() => setSosOpen(true)}
        onToggleNotifications={() => setNotifDrawerOpen((v) => !v)}
      />

      {/* Slide-out Notification Center Drawer */}
      {notifDrawerOpen && user && (
        <div className="fixed right-4 top-28 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 dark:border-violet-500/30 bg-white dark:bg-[#0B1022] p-4 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2.5 mb-3">
            <span className="font-display text-sm font-bold">Notifications</span>
            <button
              type="button"
              onClick={() => setNotifDrawerOpen(false)}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="text-xs text-slate-500">All caught up.</p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`rounded-xl border p-2.5 text-xs ${
                    n.isRead
                      ? 'border-slate-200 dark:border-slate-800 opacity-70'
                      : 'border-violet-500/40 bg-violet-500/5'
                  }`}
                >
                  <div className="font-semibold text-slate-900 dark:text-white">{n.title}</div>
                  <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">{n.message}</div>
                  {!n.isRead && (
                    <button
                      type="button"
                      onClick={() => handleMarkNotificationRead(n.id)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-600 dark:text-violet-400"
                    >
                      <Check className="h-3 w-3" />
                      <span>Mark Read</span>
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <main>{renderMainContent()}</main>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={() => {
          if (activeView === 'landing') setActiveView('dashboard');
        }}
      />

      <SosModal open={sosOpen} onClose={() => setSosOpen(false)} />

      <WorkspaceConfirmModal payload={workspaceConfirm} onClose={() => setWorkspaceConfirm(null)} />

      <OfflineIndicator queuedCount={queuedSosCount} failedCount={failedSosCount} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </ThemeProvider>
  );
}
