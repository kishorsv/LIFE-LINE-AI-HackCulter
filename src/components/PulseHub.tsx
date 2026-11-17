import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  CloudRain,
  Compass,
  Eye,
  LocateFixed,
  Lock,
  MapPin,
  Navigation,
  RefreshCw,
  Route,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
  Sun,
  Users,
  Wind,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { t } from '../i18n/translations.ts';
import { cachedFetchJson, invalidateClientCache } from '../lib/clientCache.ts';
import { LifeLineLogo } from './LifeLineLogo.tsx';
import {
  PredictiveRiskAssessment,
  SafeRouteCandidateItem,
  SafetyJourneyItem,
  SafetyReportItem,
} from '../types/lifeline.ts';

const PulseSafeRouteMap = lazy(() => import('./PulseSafeRouteMap.tsx'));

interface SafeRouteAgentOutput {
  modelUsed: string;
  aiAvailable: boolean;
  advisoryNotice: string;
  recommendedRouteIndex: number;
  safetyReasoning: string;
  cautionNotes: string[];
  confidenceScore: number;
  uncertaintyNotes: string;
}
function formatCountdown(targetIso: string, nowMs: number): { label: string; overdue: boolean } {
  const diffSec = Math.round((new Date(targetIso).getTime() - nowMs) / 1000);
  if (diffSec <= 0) {
    const overdueMins = Math.max(1, Math.floor(Math.abs(diffSec) / 60));
    return { label: `Overdue by ${overdueMins} min`, overdue: true };
  }
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return { label: `${mins}m ${String(secs).padStart(2, '0')}s`, overdue: false };
}

function JourneyCheckInCountdown({ targetIso }: { targetIso: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const countdown = formatCountdown(targetIso, nowMs);
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-[11px] font-semibold ${
        countdown.overdue
          ? 'bg-rose-500/20 text-rose-700 dark:text-rose-300'
          : 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
      }`}
    >
      <Clock className="h-3.5 w-3.5" />
      <span>Next safety check-in: {countdown.label}</span>
    </div>
  );
}

export function PulseHub({ onOpenAuth, onOpenSos }: { onOpenAuth: () => void; onOpenSos: () => void }) {
  const { user, profile, contacts, journeys, language, mapsApiKey, apiFetch, refreshJourneys } = useAuth();
  const [subTab, setSubTab] = useState<'risk' | 'saferoute' | 'reports'>('risk');

  // Location state (defaults to user profile lastKnown coords or San Francisco Civic Center)
  const [lat, setLat] = useState<number>(profile?.lastKnownLat ?? 37.7749);
  const [lng, setLng] = useState<number>(profile?.lastKnownLng ?? -122.4194);
  const [locationLabel, setLocationLabel] = useState<string>(
    profile?.lastLocationLabel || 'San Francisco Civic Center Corridor'
  );

  // Predictive Risk state
  const [risk, setRisk] = useState<PredictiveRiskAssessment | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState('');

  // SafeRoute state
  const [destLat, setDestLat] = useState<number>((profile?.lastKnownLat ?? 37.7749) + 0.0115);
  const [destLng, setDestLng] = useState<number>((profile?.lastKnownLng ?? -122.4194) + 0.014);
  const [destLabel, setDestLabel] = useState<string>('Market St / Ferry Transit Hub');
  const [travelMode, setTravelMode] = useState<'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE'>('WALK');
  const [routes, setRoutes] = useState<SafeRouteCandidateItem[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState<number>(0);
  const [routeError, setRouteError] = useState('');
  const [routeLoading, setRouteLoading] = useState(false);
  const [agentAnalysis, setAgentAnalysis] = useState<SafeRouteAgentOutput | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  // Journey Sharing state
  const [checkInMinutes, setCheckInMinutes] = useState<number>(15);
  const [journeyBusy, setJourneyBusy] = useState(false);
  const [journeyMessage, setJourneyMessage] = useState('');

  // Safety Reports state
  const [reports, setReports] = useState<SafetyReportItem[]>([]);
  const [showAllReports, setShowAllReports] = useState(false);
  const [reportCat, setReportCat] = useState('Poor Lighting');
  const [reportSeverity, setReportSeverity] = useState<'LOW' | 'MODERATE' | 'HIGH'>('MODERATE');
  const [reportDesc, setReportDesc] = useState('');
  const [reportAnonymous, setReportAnonymous] = useState(true);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportFeedback, setReportFeedback] = useState('');

  const evaluateRisk = useCallback(
    async (targetLat = lat, targetLng = lng, label = locationLabel) => {
      setRiskLoading(true);
      setRiskError('');
      try {
        const res = await apiFetch<{ risk: PredictiveRiskAssessment }>('/api/pulse/risk', {
          method: 'POST',
          body: JSON.stringify({ latitude: targetLat, longitude: targetLng, locationLabel: label, radiusKm: 3.5 }),
        });
        setRisk(res.risk);
      } catch (err) {
        setRiskError(err instanceof Error ? err.message : 'Unable to evaluate predictive risk.');
      } finally {
        setRiskLoading(false);
      }
    },
    [apiFetch, lat, lng, locationLabel]
  );

  const loadReports = useCallback(async (signal?: AbortSignal, forceRefresh = false) => {
    try {
      const data = await cachedFetchJson<{ reports?: SafetyReportItem[] }>(
        'public:pulse-reports',
        async (s) => {
          const res = await fetch('/api/pulse/reports', { signal: s });
          if (!res.ok) throw new Error('Failed to load reports');
          return res.json() as Promise<{ reports?: SafetyReportItem[] }>;
        },
        { ttlMs: 15_000, staleWhileRevalidateMs: 45_000, signal, forceRefresh }
      );
      if (!signal?.aborted && data.reports) setReports(data.reports);
    } catch {
      // ignore offline or abort
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void evaluateRisk(lat, lng, locationLabel);
    void loadReports(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detectGps = () => {
    if (!('geolocation' in navigator)) {
      setRiskError('Browser geolocation unavailable on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nLat = pos.coords.latitude;
        const nLng = pos.coords.longitude;
        if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
          setLat(nLat);
          setLng(nLng);
          const lbl = `Live GPS (${nLat.toFixed(4)}, ${nLng.toFixed(4)})`;
          setLocationLabel(lbl);
          void evaluateRisk(nLat, nLng, lbl);
        }
      },
      () => {
        setRiskError('Location permission denied. Enter coordinates or pick a corridor manually.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const computeSafeRoutes = async () => {
    setRouteLoading(true);
    setRouteError('');
    setAgentAnalysis(null);
    try {
      const resp = await fetch('/api/maps/saferoute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originLat: lat,
          originLng: lng,
          destinationLat: destLat,
          destinationLng: destLng,
          travelMode,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        available?: boolean;
        routes?: SafeRouteCandidateItem[];
        error?: string;
      };
      if (!resp.ok || !data.available) {
        setRoutes([]);
        setRouteError(data.error || 'SafeRoute routing is unavailable right now.');
        return;
      }
      const list = data.routes || [];
      setRoutes(list);
      const recIdx = list.findIndex((r) => r.isRecommended);
      setSelectedRouteIdx(recIdx >= 0 ? recIdx : 0);
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : 'Failed to compute SafeRoutes.');
    } finally {
      setRouteLoading(false);
    }
  };

  const explainWithSafeRouteAgent = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    if (routes.length === 0) return;
    setAgentLoading(true);
    setRouteError('');
    try {
      const weatherStr = risk?.weather.available
        ? `${risk.weather.weatherLabel}, ${risk.weather.temperatureC}°C, wind ${risk.weather.windSpeedKmh} km/h`
        : 'Weather telemetry unavailable';
      const res = await apiFetch<{ saferoute: SafeRouteAgentOutput }>('/api/ai/saferoute', {
        method: 'POST',
        body: JSON.stringify({
          originLabel: locationLabel,
          destinationLabel: destLabel,
          travelMode,
          weatherSummary: weatherStr,
          routes,
        }),
      });
      setAgentAnalysis(res.saferoute);
      setSelectedRouteIdx(res.saferoute.recommendedRouteIndex);
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : 'SafeRoute Agent failed.');
    } finally {
      setAgentLoading(false);
    }
  };

  const startJourneyShare = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setJourneyBusy(true);
    setJourneyMessage('');
    try {
      const chosenRoute = routes[selectedRouteIdx];
      await apiFetch<{ journey: SafetyJourneyItem }>('/api/journeys', {
        method: 'POST',
        body: JSON.stringify({
          originLabel: locationLabel,
          originLat: lat,
          originLng: lng,
          destinationLabel: destLabel,
          destinationLat: destLat,
          destinationLng: destLng,
          travelMode,
          selectedRouteSummary: chosenRoute
            ? `${chosenRoute.summary} (${chosenRoute.durationLabel}, Safety ${chosenRoute.safetyScore}/100)`
            : `${travelMode} SafeRoute to ${destLabel}`,
          routeRiskLevel: chosenRoute?.riskLevel || risk?.riskLevel || 'LOW',
          checkInIntervalMinutes: checkInMinutes,
          expectedDurationMinutes: chosenRoute ? Math.max(15, Math.round(chosenRoute.durationSeconds / 60) + 10) : 30,
        }),
      });
      await refreshJourneys();
      setJourneyMessage('Shared journey activated! Trusted contacts and check-in reminder timer are now live.');
    } catch (err) {
      setJourneyMessage(err instanceof Error ? err.message : 'Could not start journey sharing.');
    } finally {
      setJourneyBusy(false);
    }
  };

  const handleJourneyAction = async (id: number, action: 'checkin' | 'arrive' | 'escalate' | 'refresh') => {
    setJourneyBusy(true);
    setJourneyMessage('');
    try {
      await apiFetch(`/api/journeys/${id}/${action}`, { method: 'POST' });
      await refreshJourneys();
      if (action === 'checkin') setJourneyMessage('Safe check-in logged; timer reset.');
      if (action === 'arrive') setJourneyMessage('Safe arrival confirmed! Journey closed.');
      if (action === 'refresh') setJourneyMessage('Route risk and weather conditions refreshed.');
      if (action === 'escalate') {
        setJourneyMessage('Journey escalated — opening SOS dispatch dialog.');
        onOpenSos();
      }
    } catch (err) {
      setJourneyMessage(err instanceof Error ? err.message : `Failed to execute ${action}.`);
    } finally {
      setJourneyBusy(false);
    }
  };

  const submitSafetyReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      onOpenAuth();
      return;
    }
    setReportBusy(true);
    setReportFeedback('');
    try {
      await apiFetch('/api/pulse/reports', {
        method: 'POST',
        body: JSON.stringify({
          category: reportCat,
          severity: reportSeverity,
          description: reportDesc,
          latitude: lat,
          longitude: lng,
          locationLabel,
          isAnonymous: reportAnonymous,
        }),
      });
      setReportDesc('');
      invalidateClientCache('public:pulse-reports');
      setReportFeedback('Safety report saved. Predictive Risk scores will include this verified community report.');
      await Promise.all([loadReports(undefined, true), evaluateRisk(lat, lng, locationLabel)]);
    } catch (err) {
      setReportFeedback(err instanceof Error ? err.message : 'Failed to submit report.');
    } finally {
      setReportBusy(false);
    }
  };

  const riskBadgeStyle =
    risk?.riskLevel === 'ELEVATED'
      ? 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300'
      : risk?.riskLevel === 'MODERATE'
      ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
      : risk?.riskLevel === 'LOW'
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : 'border-slate-400/40 bg-slate-500/15 text-slate-700 dark:text-slate-300';

  const activeJourneys = journeys.filter((j) => j.status === 'Active');

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header Banner */}
      <div className="rounded-3xl border border-violet-500/25 bg-gradient-to-br from-slate-900 via-[#0E152D] to-[#1A1038] p-6 text-white shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-1.5">
            <div className="flex items-center gap-3">
              <LifeLineLogo variant="mark" size="sm" tone="dark" />
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/35 bg-violet-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-violet-200">
                <Activity className="h-3.5 w-3.5 text-emerald-400" />
                <span>LIFE-LINE PULSE · Evidence-Driven Predictive Intelligence</span>
              </div>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold">{t(language, 'pulse_title')}</h1>
            <p className="text-xs sm:text-sm text-slate-300">{t(language, 'pulse_subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={detectGps}
              className="inline-flex items-center gap-2 rounded-xl border border-violet-400/40 bg-white/10 px-3.5 py-2 text-xs font-semibold text-white hover:bg-white/20"
            >
              <LocateFixed className="h-4 w-4 text-emerald-400" />
              <span>Use Live GPS</span>
            </button>
            <button
              type="button"
              onClick={() => void evaluateRisk(lat, lng, locationLabel)}
              disabled={riskLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${riskLoading ? 'animate-spin' : ''}`} />
              <span>Refresh PULSE Telemetry</span>
            </button>
          </div>
        </div>

        {/* Shared Location Coordinate Bar */}
        <div className="mt-5 grid gap-3 sm:grid-cols-4 bg-white/5 rounded-2xl p-3.5 border border-white/10 text-xs">
          <div className="sm:col-span-2">
            <label className="block text-[11px] text-slate-400 mb-1">Active Corridor / Location Label</label>
            <input
              type="text"
              value={locationLabel}
              onChange={(e) => setLocationLabel(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-slate-950/60 px-3 py-1.5 text-white"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Latitude</label>
            <input
              type="number"
              step="0.0001"
              value={lat}
              onChange={(e) => setLat(Number(e.target.value))}
              className="w-full rounded-lg border border-white/15 bg-slate-950/60 px-3 py-1.5 font-mono text-white"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Longitude</label>
            <input
              type="number"
              step="0.0001"
              value={lng}
              onChange={(e) => setLng(Number(e.target.value))}
              className="w-full rounded-lg border border-white/15 bg-slate-950/60 px-3 py-1.5 font-mono text-white"
            />
          </div>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSubTab('risk')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            subTab === 'risk'
              ? 'bg-violet-600 text-white shadow-md'
              : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] text-slate-700 dark:text-slate-300'
          }`}
        >
          <Shield className="h-4 w-4" />
          <span>{t(language, 'pulse_risk_tab')}</span>
        </button>
        <button
          type="button"
          onClick={() => setSubTab('saferoute')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            subTab === 'saferoute'
              ? 'bg-violet-600 text-white shadow-md'
              : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] text-slate-700 dark:text-slate-300'
          }`}
        >
          <Route className="h-4 w-4" />
          <span>{t(language, 'pulse_saferoute_tab')}</span>
          {activeJourneys.length > 0 && (
            <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {activeJourneys.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('reports')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            subTab === 'reports'
              ? 'bg-violet-600 text-white shadow-md'
              : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] text-slate-700 dark:text-slate-300'
          }`}
        >
          <Lock className="h-4 w-4" />
          <span>{t(language, 'pulse_reports_tab')}</span>
          <span className="rounded-full bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold">
            {reports.length}
          </span>
        </button>
      </div>

      {riskError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-xs text-rose-700 dark:text-rose-300">
          {riskError}
        </div>
      )}

      {/* TAB 1: PREDICTIVE RISK INTELLIGENCE */}
      {subTab === 'risk' && risk && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-5">
            {/* Risk Indicator Overview */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Transparent Corridor Assessment
                  </span>
                  <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                    {risk.locationLabel}
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <div className={`rounded-xl border px-3.5 py-2 text-center ${riskBadgeStyle}`}>
                    <div className="text-[10px] font-bold uppercase tracking-wider">Risk Level</div>
                    <div className="font-display text-lg font-extrabold">{risk.riskLevel}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-3.5 py-2 text-center">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">Confidence</div>
                    <div className="font-display text-lg font-bold tabular-nums text-violet-600 dark:text-violet-400">
                      {Math.round(risk.confidence * 100)}%
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{risk.summary}</p>

              <div className="grid gap-3 sm:grid-cols-4 text-xs">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-slate-500">Verified Incidents (3.5km)</div>
                  <div className="font-display text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                    {risk.counts.verifiedNearbyIncidents}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-slate-500">Community Reports</div>
                  <div className="font-display text-lg font-bold tabular-nums text-slate-900 dark:text-white">
                    {risk.counts.communityReportsCount}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-slate-500">24/7 Safe Havens</div>
                  <div className="font-display text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {risk.counts.open24hSupportHubs}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="text-slate-500">Demo Data Excluded</div>
                  <div className="font-display text-lg font-bold tabular-nums text-amber-600 dark:text-amber-400">
                    {risk.counts.simulatedIncidentsExcluded}
                  </div>
                </div>
              </div>

              {/* Supporting Evidence Ledger */}
              <div className="space-y-2.5 pt-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200">
                  <span>Supporting Evidence & Data Sources</span>
                  <span className="text-[11px] font-mono text-slate-500">
                    Evaluated {new Date(risk.evaluatedAt).toLocaleTimeString()}
                  </span>
                </div>
                {risk.evidence.map((ev, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-3.5 text-xs space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{ev.factor}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                          ev.impact === 'elevates_risk'
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            : ev.impact === 'mitigates_risk'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : ev.impact === 'unavailable'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-slate-500/15 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {ev.impact.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-300">{ev.detail}</p>
                    <div className="text-[11px] text-slate-500 flex items-center justify-between">
                      <span>Source: {ev.source}</span>
                      <span>{new Date(ev.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column: Live Open-Meteo Telemetry & Safety Actions */}
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <CloudRain className="h-4 w-4 text-sky-500" />
                  <span>Open-Meteo Weather Telemetry</span>
                </h3>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                    risk.weather.available
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                      : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                  }`}
                >
                  {risk.weather.available ? 'LIVE' : 'UNAVAILABLE'}
                </span>
              </div>

              {risk.weather.available ? (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/60 p-3">
                    <div className="text-slate-500">Temperature</div>
                    <div className="font-display text-lg font-bold text-slate-900 dark:text-white">
                      {risk.weather.temperatureC ?? '--'}°C
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/60 p-3">
                    <div className="text-slate-500 flex items-center gap-1">
                      <Wind className="h-3 w-3" /> Wind Speed
                    </div>
                    <div className="font-display text-lg font-bold text-slate-900 dark:text-white">
                      {risk.weather.windSpeedKmh ?? '--'} km/h
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/60 p-3">
                    <div className="text-slate-500 flex items-center gap-1">
                      <Eye className="h-3 w-3" /> Visibility
                    </div>
                    <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      {risk.weather.visibilityMeters != null ? `${Math.round(risk.weather.visibilityMeters / 1000)} km` : 'Unknown'}
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/60 p-3">
                    <div className="text-slate-500 flex items-center gap-1">
                      <Sun className="h-3 w-3" /> Lighting Window
                    </div>
                    <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      {risk.weather.isDay === true ? 'Daylight' : risk.weather.isDay === false ? 'Nighttime' : 'Unknown'}
                    </div>
                  </div>
                  <div className="col-span-2 text-[11px] text-slate-500">
                    Condition: <strong>{risk.weather.weatherLabel}</strong> · Updated{' '}
                    {new Date(risk.weather.retrievedAt).toLocaleTimeString()}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {risk.weather.reason || 'Weather API unreachable right now. Weather hazards could not be evaluated.'}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-3">
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">Practical Safety Guidance</h3>
              <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                {risk.mitigationGuidance.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setSubTab('saferoute')}
                className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-violet-500"
              >
                Plan SafeRoute & Share Journey
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: AI SAFEROUTE & JOURNEY SHARING */}
      {subTab === 'saferoute' && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-12">
            {/* Route Planner Controls */}
            <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4">
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Compass className="h-5 w-5 text-violet-500" />
                <span>Google Routes v2 SafeRoute Comparison</span>
              </h2>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Destination Label</label>
                  <input
                    type="text"
                    value={destLabel}
                    onChange={(e) => setDestLabel(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-slate-900 dark:text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Dest Lat</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={destLat}
                      onChange={(e) => setDestLat(Number(e.target.value))}
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Dest Lng</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={destLng}
                      onChange={(e) => setDestLng(Number(e.target.value))}
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Travel Mode</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['WALK', 'DRIVE', 'TRANSIT', 'BICYCLE'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setTravelMode(m)}
                        className={`rounded-lg border py-1.5 font-semibold ${
                          travelMode === m
                            ? 'border-violet-500 bg-violet-600 text-white'
                            : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    disabled={routeLoading}
                    onClick={computeSafeRoutes}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
                  >
                    <Navigation className="h-4 w-4" />
                    <span>{routeLoading ? 'Computing Routes...' : 'Compare SafeRoutes'}</span>
                  </button>
                  {routes.length > 0 && (
                    <button
                      type="button"
                      disabled={agentLoading}
                      onClick={explainWithSafeRouteAgent}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3.5 py-2.5 font-semibold text-violet-700 dark:text-violet-300"
                    >
                      <Sparkles className="h-4 w-4" />
                      <span>{agentLoading ? 'Analyzing...' : 'AI Explain'}</span>
                    </button>
                  )}
                </div>
              </div>

              {routeError && (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {routeError}
                </div>
              )}

              {/* Candidate Route Options */}
              {routes.length > 0 && (
                <div className="space-y-2.5">
                  {routes.map((r, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedRouteIdx(idx)}
                      className={`w-full text-left rounded-xl border p-3.5 transition-all space-y-1.5 ${
                        selectedRouteIdx === idx
                          ? 'border-violet-500 bg-violet-500/10'
                          : 'border-slate-200 dark:border-slate-800 hover:border-violet-500/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-xs text-slate-900 dark:text-white">
                          {r.summary}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {r.isRecommended && (
                            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                              SAFEST PICK
                            </span>
                          )}
                          <span className="rounded bg-slate-900/10 dark:bg-white/10 px-2 py-0.5 font-mono text-[11px] font-bold">
                            Score {r.safetyScore}/100
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-300">
                        <span>{r.durationLabel}</span>
                        <span>{(r.distanceMeters / 1000).toFixed(2)} km</span>
                        <span>{r.nearbyIncidentsCount} incident(s)</span>
                        <span>{r.nearbySupportHubsCount} hub(s)</span>
                      </div>
                      <ul className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
                        {r.reasons.map((reason, ri) => (
                          <li key={ri}>• {reason}</li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
              )}

              {agentAnalysis && (
                <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-xs space-y-2">
                  <div className="flex items-center justify-between font-bold text-emerald-800 dark:text-emerald-200">
                    <span>SafeRoute Agent Reasoning ({agentAnalysis.modelUsed})</span>
                    <span>{Math.round(agentAnalysis.confidenceScore * 100)}% conf</span>
                  </div>
                  <p className="text-slate-700 dark:text-slate-200">{agentAnalysis.safetyReasoning}</p>
                  <ul className="list-disc pl-4 text-slate-600 dark:text-slate-300 space-y-0.5">
                    {agentAnalysis.cautionNotes.map((c, idx) => (
                      <li key={idx}>{c}</li>
                    ))}
                  </ul>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">{agentAnalysis.advisoryNotice}</p>
                </div>
              )}
            </div>

            {/* Interactive Map + Active Journey Sharing Panel */}
            <div className="lg:col-span-7 space-y-5">
              <div className="h-[340px] rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-950 relative">
                {mapsApiKey ? (
                  <Suspense
                    fallback={
                      <div className="h-full w-full flex items-center justify-center text-xs text-slate-400 animate-pulse">
                        Loading interactive SafeRoute map...
                      </div>
                    }
                  >
                    <PulseSafeRouteMap
                      mapsApiKey={mapsApiKey}
                      lat={lat}
                      lng={lng}
                      destLat={destLat}
                      destLng={destLng}
                      destLabel={destLabel}
                      routes={routes}
                      selectedRouteIdx={selectedRouteIdx}
                    />
                  </Suspense>
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-300">
                    Google Maps JavaScript API key not configured for visual canvas. Server-side predictive risk & journey sharing remain active.
                  </div>
                )}
              </div>

              {/* Start Shared Journey Card */}
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <Users className="h-4 w-4 text-emerald-500" />
                      <span>Journey Sharing & Safety Check-In Timer</span>
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Shares your route corridor with {contacts.length} configured trusted contact(s) and reminds you to check in.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <label className="text-slate-500">Check-in every</label>
                    <select
                      value={checkInMinutes}
                      onChange={(e) => setCheckInMinutes(Number(e.target.value))}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5"
                    >
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                    </select>
                  </div>
                </div>

                {journeyMessage && (
                  <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                    {journeyMessage}
                  </div>
                )}

                <button
                  type="button"
                  disabled={journeyBusy}
                  onClick={startJourneyShare}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-60"
                >
                  <Send className="h-4 w-4" />
                  <span>{t(language, 'pulse_start_journey')}</span>
                </button>

                {/* Active Shared Journeys */}
                {journeys.length > 0 && (
                  <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      Your Shared Journeys ({journeys.length})
                    </div>
                    {journeys.slice(0, 5).map((j) => (
                      <div
                        key={j.id}
                        className={`rounded-xl border p-3.5 text-xs space-y-2 ${
                          j.status === 'Active'
                            ? 'border-emerald-500/40 bg-emerald-500/5'
                            : 'border-slate-200 dark:border-slate-800 opacity-85'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-slate-900 dark:text-white">
                            {j.originLabel} → {j.destinationLabel}
                          </span>
                          <span className="rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase bg-slate-900/10 dark:bg-white/10">
                            {j.status}
                          </span>
                        </div>
                        <div className="text-slate-500 dark:text-slate-400">
                          {j.selectedRouteSummary} · Risk: <strong>{j.routeRiskLevel}</strong>
                        </div>
                        {j.status === 'Active' && <JourneyCheckInCountdown targetIso={j.nextCheckInDueAt} />}
                        {j.status === 'Active' && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <button
                              type="button"
                              disabled={journeyBusy}
                              onClick={() => handleJourneyAction(j.id, 'checkin')}
                              className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-500"
                            >
                              {t(language, 'pulse_checkin_safe')}
                            </button>
                            <button
                              type="button"
                              disabled={journeyBusy}
                              onClick={() => handleJourneyAction(j.id, 'arrive')}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>{t(language, 'pulse_confirm_arrival')}</span>
                            </button>
                            <button
                              type="button"
                              disabled={journeyBusy}
                              onClick={() => handleJourneyAction(j.id, 'refresh')}
                              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 font-semibold"
                            >
                              {t(language, 'pulse_refresh_route')}
                            </button>
                            <button
                              type="button"
                              disabled={journeyBusy}
                              onClick={() => handleJourneyAction(j.id, 'escalate')}
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 font-semibold text-white hover:bg-rose-500"
                            >
                              <ShieldAlert className="h-3.5 w-3.5" />
                              <span>Escalate SOS</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: PRIVACY-CONSCIOUS COMMUNITY SAFETY REPORTS */}
      {subTab === 'reports' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={submitSafetyReport}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4"
          >
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Lock className="h-5 w-5 text-violet-500" />
              <span>Submit Privacy-Conscious Safety Report</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Report street lighting outages, unsafe transit stops, or hazard conditions to inform predictive risk scores.
              Anonymous mode removes your user ID from the report record.
            </p>

            {reportFeedback && (
              <div className="rounded-xl border border-violet-500/35 bg-violet-500/10 p-3 text-xs text-violet-700 dark:text-violet-300">
                {reportFeedback}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Category</label>
                <select
                  value={reportCat}
                  onChange={(e) => setReportCat(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                >
                  <option value="Poor Lighting">Poor Street Lighting</option>
                  <option value="Unsafe Transit Stop">Unsafe Transit Stop</option>
                  <option value="Harassment Concern">Harassment / Stalking Alert</option>
                  <option value="Isolated Alleyway">Isolated / Unmonitored Area</option>
                  <option value="Broken Emergency Phone">Broken Emergency Callbox</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Severity</label>
                <select
                  value={reportSeverity}
                  onChange={(e) => setReportSeverity(e.target.value as 'LOW' | 'MODERATE' | 'HIGH')}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                >
                  <option value="LOW">LOW</option>
                  <option value="MODERATE">MODERATE</option>
                  <option value="HIGH">HIGH</option>
                </select>
              </div>
            </div>

            <div className="text-xs">
              <label className="block font-medium mb-1">Observed Details</label>
              <textarea
                rows={3}
                required
                value={reportDesc}
                onChange={(e) => setReportDesc(e.target.value)}
                placeholder="Describe objective conditions (e.g., 3 streetlights out near station north exit)..."
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={reportAnonymous}
                onChange={(e) => setReportAnonymous(e.target.checked)}
                className="rounded border-slate-400 text-violet-600"
              />
              <span>Submit anonymously (omit my user ID from stored safety report)</span>
            </label>

            <button
              type="submit"
              disabled={reportBusy}
              className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {reportBusy ? 'Submitting...' : 'Submit Safety Report'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span>Verified Community & Hazard Feed ({reports.length})</span>
            </h3>
            {reports.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center text-xs text-slate-500">
                No community safety reports logged yet. Submit an observation on the left to contribute real corridor context.
              </div>
            ) : (
              <div className="space-y-3">
                {(showAllReports ? reports : reports.slice(0, 8)).map((rep) => (
                  <div key={rep.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-slate-900 dark:text-white">
                        {rep.category} · {rep.locationLabel}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                          rep.severity === 'HIGH'
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            : rep.severity === 'MODERATE'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-slate-500/15 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {rep.severity}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-300">{rep.description}</p>
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> {rep.latitude.toFixed(4)}, {rep.longitude.toFixed(4)}
                      </span>
                      <span>
                        {rep.reporterLabel} · {new Date(rep.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
                {reports.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllReports((v) => !v)}
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-800 py-2 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:bg-violet-500/5"
                  >
                    {showAllReports ? 'Show Fewer Reports' : `Show All ${reports.length} Safety Reports`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
