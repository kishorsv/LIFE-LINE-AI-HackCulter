import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  CloudRain,
  Compass,
  ExternalLink,
  Flame,
  Info,
  Navigation,
  PhoneCall,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sparkles,
  Thermometer,
  Wind,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import {
  LiveExternalAlert,
  LiveIncidentVerificationStatus,
  LiveIncidentsFeedResponse,
  SupportResource,
} from '../types/lifeline.ts';

const LiveIncidentMap = React.lazy(() => import('./LiveIncidentMap.tsx'));

interface WhatIfSimResult {
  scenarioType: string;
  title: string;
  isSimulation: boolean;
  baselineScore: number;
  simulatedScore: number;
  scoreDelta: number;
  baselineMinutes: number | null;
  simulatedMinutes: number | null;
  minutesDelta: number | null;
  alternateHub: {
    id: number;
    name: string;
    category: string;
    distanceKm: number;
    phone: string;
  } | null;
}

interface AiLiveAnalysisResult {
  modelUsed: string;
  aiAvailable: boolean;
  isAiAdvisory: boolean;
  advisoryNotice: string;
  situationAssessment: string;
  affectedCommunitiesAndInfra: string[];
  responderRecommendations: string[];
  lastMileSurvivalGuidance: string[];
  whatIfAnalysis: string;
  uncertaintyDisclosure: string;
}

const CITY_PRESETS = [
  { label: 'Mysuru (Pilot)', city: 'Mysuru', state: 'Karnataka', region: 'mysuru', lat: 12.2958, lng: 76.6394 },
  { label: 'Bengaluru', city: 'Bengaluru', state: 'Karnataka', region: 'karnataka', lat: 12.9716, lng: 77.5946 },
  { label: 'Mandya', city: 'Mandya', state: 'Karnataka', region: 'karnataka', lat: 12.5218, lng: 76.8951 },
  { label: 'Kodagu', city: 'Kodagu', state: 'Karnataka', region: 'karnataka', lat: 12.4244, lng: 75.7382 },
  { label: 'Mangaluru', city: 'Mangaluru', state: 'Karnataka', region: 'karnataka', lat: 12.9141, lng: 74.856 },
  { label: 'All India', city: 'Mysuru', state: 'India', region: 'india', lat: 19.076, lng: 76.6394 },
];

const SEVERITY_BADGE: Record<string, string> = {
  EXTREME: 'bg-rose-600/15 text-rose-700 dark:text-rose-300 border-rose-500/40',
  SEVERE: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40',
  MODERATE: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
  MINOR: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40',
  ADVISORY: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40',
};

const VERIFICATION_BADGE: Record<LiveIncidentVerificationStatus, string> = {
  'Official Alert': 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
  'Awaiting Verification': 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40',
  'Verified Incident': 'bg-rose-600/15 text-rose-700 dark:text-rose-300 border-rose-500/40',
  'Resolved Incident': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
};

export function LiveIncidentsPage({ onOpenAuth }: { onOpenAuth: () => void }) {
  const { user, mapsApiKey, apiFetch, language, realtimeConnected } = useAuth();

  const [region, setRegion] = useState<'mysuru' | 'karnataka' | 'india'>('mysuru');
  const [selectedPreset, setSelectedPreset] = useState(CITY_PRESETS[0]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const [feedData, setFeedData] = useState<LiveIncidentsFeedResponse | null>(null);
  const [supportHubs, setSupportHubs] = useState<SupportResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(null);

  const [whatIfScenario, setWhatIfScenario] = useState<string>('');
  const [whatIfResult, setWhatIfResult] = useState<WhatIfSimResult | null>(null);
  const [whatIfLoading, setWhatIfLoading] = useState(false);

  const [whatIfQuestion, setWhatIfQuestion] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState<AiLiveAnalysisResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [updatingAlertId, setUpdatingAlertId] = useState<number | null>(null);
  const [operatorNote, setOperatorNote] = useState('');

  const [desktopAlertsEnabled, setDesktopAlertsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lifeline_desktop_live_alerts') === 'true';
    } catch {
      return false;
    }
  });

  const isPrivilegedOperator = Boolean(
    user && ['emergency_operator', 'support_organization', 'administrator'].includes(user.role)
  );

  const loadFeed = useCallback(async () => {
    setError('');
    try {
      const qs = new URLSearchParams({
        region,
        status: statusFilter,
        category: categoryFilter,
        city: selectedPreset.city,
        state: selectedPreset.state,
        lat: String(selectedPreset.lat),
        lng: String(selectedPreset.lng),
      });
      const [feedResp, hubsResp] = await Promise.all([
        fetch(`/api/live-incidents?${qs.toString()}`).then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
          return data as LiveIncidentsFeedResponse;
        }),
        fetch('/api/support-directory')
          .then((r) => (r.ok ? r.json() : { resources: [] }))
          .catch(() => ({ resources: [] })),
      ]);
      setFeedData(feedResp);
      setSupportHubs(Array.isArray(hubsResp.resources) ? hubsResp.resources : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load live incident telemetry.');
    } finally {
      setLoading(false);
    }
  }, [region, statusFilter, categoryFilter, selectedPreset]);

  useEffect(() => {
    setLoading(true);
    void loadFeed();
  }, [loadFeed]);

  // Listen to WebSocket live_incident updates dispatched via AuthContext
  useEffect(() => {
    const onRealtimeLiveEvent = () => {
      void loadFeed();
    };
    window.addEventListener('lifeline-live-incidents-updated', onRealtimeLiveEvent);
    return () => window.removeEventListener('lifeline-live-incidents-updated', onRealtimeLiveEvent);
  }, [loadFeed]);

  const handleManualSync = async () => {
    if (!isPrivilegedOperator) return;
    setSyncing(true);
    setError('');
    try {
      await apiFetch('/api/live-incidents/sync', { method: 'POST' });
      await loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to synchronize upstream disaster feeds.');
    } finally {
      setSyncing(false);
    }
  };

  const handleUpdateAlertStatus = async (
    alert: LiveExternalAlert,
    verificationStatus: LiveIncidentVerificationStatus
  ) => {
    if (!isPrivilegedOperator) return;
    setUpdatingAlertId(alert.id);
    setError('');
    try {
      await apiFetch(`/api/live-incidents/${alert.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          verificationStatus,
          instructionNote: operatorNote.trim() || undefined,
        }),
      });
      setOperatorNote('');
      await loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update alert verification status.');
    } finally {
      setUpdatingAlertId(null);
    }
  };

  const handleRunWhatIf = async (scenario: string) => {
    setWhatIfScenario(scenario);
    setWhatIfLoading(true);
    try {
      const qs = new URLSearchParams({
        region,
        city: selectedPreset.city,
        state: selectedPreset.state,
        lat: String(selectedPreset.lat),
        lng: String(selectedPreset.lng),
        scenario,
      });
      const resp = await fetch(`/api/live-incidents/mysuru-intel?${qs.toString()}`);
      const data = await resp.json();
      if (resp.ok && data.whatIf) {
        setWhatIfResult(data.whatIf as WhatIfSimResult);
      }
    } catch {
      // ignore transient error
    } finally {
      setWhatIfLoading(false);
    }
  };

  const handleRunAiAnalysis = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setAiLoading(true);
    setError('');
    try {
      const resp = await apiFetch<{ analysis: AiLiveAnalysisResult }>('/api/ai/analyze-live-incident', {
        method: 'POST',
        body: JSON.stringify({
          region,
          city: selectedPreset.city,
          state: selectedPreset.state,
          lat: selectedPreset.lat,
          lng: selectedPreset.lng,
          whatIfQuestion: whatIfQuestion.trim() || undefined,
          language,
        }),
      });
      setAiAnalysis(resp.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI incident intelligence request failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const toggleDesktopAlerts = async () => {
    if (desktopAlertsEnabled) {
      localStorage.setItem('lifeline_desktop_live_alerts', 'false');
      setDesktopAlertsEnabled(false);
      return;
    }
    if (typeof Notification === 'undefined') {
      setError('Browser desktop notifications are not supported in this browser.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      localStorage.setItem('lifeline_desktop_live_alerts', 'true');
      setDesktopAlertsEnabled(true);
    } else {
      setError('Notification permission was not granted by the browser.');
    }
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    (feedData?.alerts || []).forEach((a) => set.add(a.category));
    return ['all', ...Array.from(set)];
  }, [feedData]);

  const sgs = feedData?.safetyGap;
  const weather = feedData?.weather;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">
            <Radio className="h-3.5 w-3.5" />
            <span>LIVE INCIDENT INTELLIGENCE · MYSURU PILOT &amp; ALL INDIA</span>
            {realtimeConnected && <span className="h-2 w-2 rounded-full bg-emerald-500" title="WebSocket Live" />}
          </div>
          <h1 className="mt-2 font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
            Real-World Disaster Monitoring &amp; Minutes-to-Safety Engine
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Ingesting real NDMA SACHET CAP feeds, IMD Bengaluru Karnataka RSS advisories, USGS seismic feeds, and Open-Meteo 24h telemetry — zero invented incidents.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleDesktopAlerts}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
              desktopAlertsEnabled
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <BellRing className="h-3.5 w-3.5" />
            <span>{desktopAlertsEnabled ? 'Desktop Alerts: ON' : 'Enable Desktop Alerts'}</span>
          </button>

          <button
            type="button"
            onClick={() => void loadFeed()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh View</span>
          </button>

          {isPrivilegedOperator && (
            <button
              type="button"
              onClick={handleManualSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-violet-600/25 hover:bg-violet-500 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Polling Upstream Feeds...' : 'Poll Live Sources Now'}</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* Region & City Focus Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-[#0B1022]/90 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(['mysuru', 'karnataka', 'india'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRegion(r);
                if (r === 'mysuru') setSelectedPreset(CITY_PRESETS[0]);
                else if (r === 'karnataka') setSelectedPreset(CITY_PRESETS[1]);
                else setSelectedPreset(CITY_PRESETS[5]);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                region === r
                  ? 'bg-violet-600 text-white'
                  : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {r === 'mysuru' ? 'Mysuru Pilot' : r === 'karnataka' ? 'Karnataka State' : 'All India Feeds'}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500 dark:text-slate-400 font-medium">Locality Focus:</span>
          {CITY_PRESETS.slice(0, 5).map((preset) => (
            <button
              key={preset.city}
              type="button"
              onClick={() => {
                setSelectedPreset(preset);
                setRegion(preset.region as 'mysuru' | 'karnataka' | 'india');
              }}
              className={`rounded-md px-2.5 py-1 font-medium ${
                selectedPreset.city === preset.city
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/40'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {preset.city}
            </button>
          ))}
        </div>
      </div>

      {/* Honest Zero-Incident Banner OR Active Incident Summary */}
      {feedData && (
        <div
          className={`rounded-2xl border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
            feedData.hasActiveLocalIncidents
              ? 'border-amber-500/40 bg-amber-500/10'
              : 'border-emerald-500/40 bg-emerald-500/10'
          }`}
        >
          <div className="flex items-start gap-3">
            {feedData.hasActiveLocalIncidents ? (
              <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            )}
            <div>
              <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
                {feedData.zeroStateMessage}
              </div>
              <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                Focus: {selectedPreset.city}, {selectedPreset.state} · Evaluated {new Date(feedData.evaluatedAt).toLocaleString()} · Public India Emergency Helplines: <strong>112</strong> (ERSS) / <strong>108</strong> (Ambulance) / <strong>181</strong> (Women)
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="tel:112"
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500"
            >
              <PhoneCall className="h-3.5 w-3.5" />
              <span>Call 112</span>
            </a>
          </div>
        </div>
      )}

      {/* Upstream Source Health & Freshness Strip */}
      {feedData && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {feedData.sources.map((src) => (
            <div
              key={src.sourceId}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0B1022]/85 p-3.5 text-xs space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900 dark:text-white truncate">{src.sourceName}</span>
                <span
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase ${
                    src.status === 'healthy'
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : src.status === 'unconfigured'
                      ? 'border-slate-500/40 bg-slate-500/15 text-slate-600 dark:text-slate-300'
                      : 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {src.isStale ? 'STALE' : src.status}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                <span>Active: {src.recordsActive} · Fetched: {src.recordsFetched}</span>
                <span>{src.latencyMs > 0 ? `${src.latencyMs} ms` : '—'}</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {src.lastSuccessAt
                  ? `Last sync: ${new Date(src.lastSuccessAt).toLocaleTimeString()}`
                  : src.lastError || 'Pending initial sync'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Map + Alerts Feed */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7 space-y-4">
          <Suspense
            fallback={
              <div className="h-[420px] w-full animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800/70" />
            }
          >
            <LiveIncidentMap
              mapsApiKey={mapsApiKey}
              center={{ lat: selectedPreset.lat, lng: selectedPreset.lng }}
              localityName={selectedPreset.city}
              alerts={feedData?.alerts || []}
              supportHubs={supportHubs}
              selectedAlertId={selectedAlertId}
              onSelectAlert={setSelectedAlertId}
            />
          </Suspense>

          {/* Weather & 2h/6h/24h Forecast Strip */}
          {weather && (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-[#0B1022]/90 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <Thermometer className="h-4 w-4 text-sky-500" />
                  <span>Observed Meteorology — {weather.city}, {weather.state}</span>
                </div>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {weather.source} · {new Date(weather.retrievedAt).toLocaleTimeString()}
                </span>
              </div>

              {weather.available ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5">
                      <div className="text-slate-500 dark:text-slate-400">Temperature</div>
                      <div className="mt-0.5 text-base font-bold tabular-nums text-slate-900 dark:text-white">
                        {weather.temperatureC ?? '--'}°C
                        <span className="ml-1 text-[11px] font-normal text-slate-500">
                          (Feels {weather.apparentTemperatureC ?? '--'}°C)
                        </span>
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5">
                      <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <CloudRain className="h-3.5 w-3.5 text-sky-500" /> Rain Rate
                      </div>
                      <div className="mt-0.5 text-base font-bold tabular-nums text-slate-900 dark:text-white">
                        {weather.precipitationMm ?? 0} mm/h
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5">
                      <div className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Wind className="h-3.5 w-3.5 text-violet-500" /> Wind &amp; Sky
                      </div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-900 dark:text-white truncate">
                        {weather.windSpeedKmh ?? 0} km/h · {weather.weatherLabel}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5">
                      <div className="text-slate-500 dark:text-slate-400">Humidity / Visibility</div>
                      <div className="mt-0.5 text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                        {weather.humidityPercent ?? '--'}% ·{' '}
                        {weather.visibilityMeters != null ? `${(weather.visibilityMeters / 1000).toFixed(1)} km` : '--'}
                      </div>
                    </div>
                  </div>

                  {weather.horizons.length > 0 && (
                    <div className="grid grid-cols-5 gap-2 pt-1">
                      {weather.horizons.map((h) => (
                        <div
                          key={h.horizonLabel}
                          className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2 text-center text-[11px] tabular-nums"
                        >
                          <div className="font-bold text-violet-600 dark:text-violet-400">{h.horizonLabel}</div>
                          <div className="mt-0.5 font-semibold text-slate-900 dark:text-white">
                            {h.temperatureC ?? '--'}°C
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400">
                            {h.precipitationMm ?? 0}mm ({h.precipitationProbability ?? 0}%)
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  Weather telemetry unavailable: {weather.reason || 'Upstream unreachable'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live Alerts Stream & Human-in-the-Loop Verification */}
        <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-[#0B1022]/90 p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Flame className="h-4 w-4 text-rose-500" />
              <span>Verified External Alerts ({feedData?.alerts.length ?? 0})</span>
            </h2>

            <div className="flex items-center gap-1.5 text-xs">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'resolved')}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active Only</option>
                <option value="resolved">Resolved Only</option>
              </select>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c === 'all' ? 'All Categories' : c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isPrivilegedOperator && (
            <input
              type="text"
              value={operatorNote}
              onChange={(e) => setOperatorNote(e.target.value)}
              placeholder="Optional responder instruction note before Verify/Resolve..."
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/70 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />
          )}

          <div className="max-h-[540px] overflow-y-auto space-y-2.5 pr-1">
            {loading ? (
              <div className="space-y-2 animate-pulse">
                <div className="h-24 rounded-xl bg-slate-200 dark:bg-slate-800/70" />
                <div className="h-24 rounded-xl bg-slate-200 dark:bg-slate-800/70" />
              </div>
            ) : !feedData || feedData.alerts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500 dark:text-slate-400 space-y-2">
                <Shield className="mx-auto h-6 w-6 text-emerald-500" />
                <div className="font-semibold text-slate-700 dark:text-slate-200">
                  No verified active incidents in {selectedPreset.city} ({region.toUpperCase()}).
                </div>
                <p>
                  Switch to <strong>All India Feeds</strong> or <strong>Karnataka State</strong> to inspect nationwide NDMA SACHET / IMD Bengaluru advisories.
                </p>
              </div>
            ) : (
              feedData.alerts.map((alert) => (
                <div
                  key={alert.id}
                  onClick={() => setSelectedAlertId(alert.id)}
                  className={`cursor-pointer rounded-xl border p-3 text-xs transition-colors space-y-2 ${
                    selectedAlertId === alert.id
                      ? 'border-violet-500 bg-violet-500/8'
                      : 'border-slate-200 dark:border-slate-800 hover:border-violet-500/40'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${
                        VERIFICATION_BADGE[alert.verificationStatus] || VERIFICATION_BADGE['Official Alert']
                      }`}
                    >
                      {alert.verificationStatus}
                    </span>
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${
                        SEVERITY_BADGE[alert.severity] || SEVERITY_BADGE.ADVISORY
                      }`}
                    >
                      {alert.severity} · {alert.category}
                    </span>
                  </div>

                  <div className="font-semibold text-slate-900 dark:text-white leading-snug">{alert.title}</div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-3">{alert.description}</p>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>Source: {alert.sourceName}</span>
                    <span>Reported: {new Date(alert.firstReportedAt).toLocaleString()}</span>
                  </div>
                  {alert.expiresAt && (
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
                      Expires: {new Date(alert.expiresAt).toLocaleString()}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {alert.sourceUrl ? (
                      <a
                        href={alert.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                      >
                        <span>Verify CAP / Source</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span />
                    )}

                    {isPrivilegedOperator && (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {alert.verificationStatus !== 'Verified Incident' && alert.isActive && (
                          <button
                            type="button"
                            disabled={updatingAlertId === alert.id}
                            onClick={() => handleUpdateAlertStatus(alert, 'Verified Incident')}
                            className="rounded-lg bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                          >
                            Verify Incident
                          </button>
                        )}
                        {alert.verificationStatus !== 'Resolved Incident' && (
                          <button
                            type="button"
                            disabled={updatingAlertId === alert.id}
                            onClick={() => handleUpdateAlertStatus(alert, 'Resolved Incident')}
                            className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            Mark Resolved
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Minutes-to-Safety Intelligence Engine (SGS) + What-If Preparedness Simulator */}
      {sgs && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-[#0B1022]/90 p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                  <Compass className="h-4 w-4" />
                  <span>Minutes-to-Safety Intelligence Engine · SGS = f(H, V, A, R, C)</span>
                </div>
                <h2 className="mt-1 font-display text-xl font-bold text-slate-900 dark:text-white">
                  {sgs.localityName} Preparedness &amp; Vulnerability Gap
                </h2>
              </div>
              <div className="text-right tabular-nums">
                <div className="text-2xl font-extrabold text-slate-900 dark:text-white">
                  {sgs.safetyGapScore}
                  <span className="text-sm font-medium text-slate-500"> / 100</span>
                </div>
                <div
                  className={`text-xs font-bold ${
                    sgs.riskBand === 'CRITICAL'
                      ? 'text-rose-600 dark:text-rose-400'
                      : sgs.riskBand === 'HIGH'
                      ? 'text-orange-600 dark:text-orange-400'
                      : sgs.riskBand === 'MODERATE'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {sgs.riskBand} RISK GAP
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs tabular-nums">
              {[
                { label: 'Hazard (H)', value: sgs.components.hazardSeverityH },
                { label: 'Vulnerability (V)', value: sgs.components.vulnerabilityExposureV },
                { label: 'Access Gap (A)', value: sgs.components.accessibilityGapA },
                { label: 'Resource Gap (R)', value: sgs.components.resourceGapR },
                { label: 'Freshness (C)', value: sgs.components.dataFreshnessC },
              ].map((m) => (
                <div key={m.label} className="rounded-xl border border-slate-200 dark:border-slate-800 p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{m.label}</div>
                  <div className="mt-1 font-bold text-slate-900 dark:text-white">{m.value}/100</div>
                  <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div className="h-full bg-violet-600 rounded-full" style={{ width: `${Math.min(100, m.value)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {sgs.nearestSupportHub && (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/8 p-3.5 text-xs space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-900 dark:text-white">
                  <span className="flex items-center gap-1.5">
                    <Navigation className="h-4 w-4 text-sky-500" />
                    Nearest Verified Hub: {sgs.nearestSupportHub.name} ({sgs.nearestSupportHub.category})
                  </span>
                  <span className="tabular-nums text-sky-700 dark:text-sky-300">
                    ~{sgs.estimatedMinutesToNearestHub ?? '--'} min · {sgs.nearestSupportHub.distanceKm} km
                  </span>
                </div>
                <div className="text-slate-600 dark:text-slate-300">
                  Phone: <strong>{sgs.nearestSupportHub.phone || '112'}</strong> · {sgs.nearestSupportHub.capacityNote}
                </div>
              </div>
            )}

            {sgs.missingResources.length > 0 && (
              <div className="space-y-1.5 text-xs">
                <div className="font-semibold text-slate-800 dark:text-slate-200">Identified Coverage Gaps:</div>
                <ul className="space-y-1">
                  {sgs.missingResources.map((gap) => (
                    <li key={gap} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{gap}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 p-3 text-[11px] text-slate-600 dark:text-slate-400 flex items-start gap-2">
              <Info className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
              <span>{sgs.disclaimer}</span>
            </div>
          </div>

          {/* What-If Preparedness + Gemini Live Incident Intelligence */}
          <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/85 dark:bg-[#0B1022]/90 p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <Activity className="h-4 w-4 text-violet-500" />
              <span>What-If Preparedness Simulator &amp; AI Analyst</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { id: 'hospital_offline', label: 'Hospital Offline' },
                { id: 'corridor_flooded', label: 'Corridor Flooded (28mm/h)' },
                { id: 'heatwave_peak', label: 'Heatwave Peak (43°C)' },
                { id: 'multi_locality_surge', label: 'Multi-Locality Surge' },
              ].map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => handleRunWhatIf(sc.id)}
                  disabled={whatIfLoading}
                  className={`rounded-xl border px-3 py-2 text-left font-medium transition-colors ${
                    whatIfScenario === sc.id
                      ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {sc.label}
                </button>
              ))}
            </div>

            {whatIfResult && (
              <div className="rounded-xl border border-amber-500/35 bg-amber-500/8 p-3 text-xs space-y-1.5">
                <div className="font-bold text-amber-800 dark:text-amber-300">
                  [SIMULATION] {whatIfResult.title}
                </div>
                <div className="tabular-nums text-slate-700 dark:text-slate-200">
                  Gap Score: <strong>{whatIfResult.baselineScore} → {whatIfResult.simulatedScore}</strong> ({whatIfResult.scoreDelta >= 0 ? `+${whatIfResult.scoreDelta}` : whatIfResult.scoreDelta})
                  {whatIfResult.minutesDelta != null && (
                    <span className="ml-2">
                      · Travel Time: <strong>{whatIfResult.baselineMinutes} → {whatIfResult.simulatedMinutes} min</strong>
                    </span>
                  )}
                </div>
                {whatIfResult.alternateHub && (
                  <div className="text-[11px] text-slate-600 dark:text-slate-300">
                    Alternate Hub: {whatIfResult.alternateHub.name} ({whatIfResult.alternateHub.distanceKm} km, {whatIfResult.alternateHub.phone || '112'})
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2.5">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Ask Gemini Live Incident Analyst (Optional What-If Question, EN / ಕನ್ನಡ)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={whatIfQuestion}
                  onChange={(e) => setWhatIfQuestion(e.target.value)}
                  placeholder="e.g. What if K.R. Hospital is full during heavy rain in Mysuru?"
                  className="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs"
                />
                <button
                  type="button"
                  onClick={handleRunAiAnalysis}
                  disabled={aiLoading}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{aiLoading ? 'Analyzing...' : user ? 'Analyze' : 'Sign In'}</span>
                </button>
              </div>

              {aiAnalysis && (
                <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 p-3.5 text-xs space-y-2 max-h-72 overflow-y-auto">
                  <div className="flex items-center justify-between text-[10px] font-bold uppercase text-violet-700 dark:text-violet-300">
                    <span>[AI Advisory] {aiAnalysis.modelUsed}</span>
                    <span>Human Confirmation Required</span>
                  </div>
                  <p className="text-slate-800 dark:text-slate-100 leading-relaxed">{aiAnalysis.situationAssessment}</p>
                  {aiAnalysis.whatIfAnalysis && (
                    <div className="text-[11px] text-slate-700 dark:text-slate-300">
                      <strong>What-If:</strong> {aiAnalysis.whatIfAnalysis}
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-900 dark:text-white">
                      Last-Mile Survival Guidance ({language === 'kn' ? 'ಕನ್ನಡ' : 'EN'}):
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-slate-700 dark:text-slate-200">
                      {aiAnalysis.lastMileSurvivalGuidance.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {aiAnalysis.advisoryNotice}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
