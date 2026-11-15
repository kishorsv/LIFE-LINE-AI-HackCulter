import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  Mic,
  PhoneCall,
  Radio,
  ShieldAlert,
  Square,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { EmergencyIncident, IncidentDeliveryStatus } from '../types/lifeline.ts';
import { enqueueOfflineSos, QueuedSosPayload } from '../lib/offlineSosQueue.ts';

interface SosModalProps {
  open: boolean;
  onClose: () => void;
}

interface DeliverySummaryResult {
  overallDeliveryState: IncidentDeliveryStatus;
  operatorRecorded: boolean;
  externalConfirmedCount: number;
  externalFailedCount: number;
  externalUnconfiguredCount: number;
  truthfulMessage: string;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sos_${crypto.randomUUID()}`;
  }
  return `sos_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export function SosModal({ open, onClose }: SosModalProps) {
  const { user, demoMode, contacts, apiFetch, refreshAllData } = useAuth();
  const [stage, setStage] = useState<'confirm' | 'countdown' | 'active' | 'queued_offline'>('confirm');
  const [queuedItem, setQueuedItem] = useState<QueuedSosPayload | null>(null);
  const [countdown, setCountdown] = useState(5);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [locationLabel, setLocationLabel] = useState('Detecting current coordinates...');
  const [title, setTitle] = useState('Urgent Personal Safety SOS');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Personal Safety');
  const [simulateAlert, setSimulateAlert] = useState<boolean>(demoMode || Boolean(user?.isDemoAccount));
  const [submitting, setSubmitting] = useState(false);
  const [createdIncident, setCreatedIncident] = useState<EmergencyIncident | null>(null);
  const [deliveryResults, setDeliveryResults] = useState<
    Array<{ recipient: string; channel: string; status: string; provider: string; error?: string }>
  >([]);
  const [deliveryReport, setDeliveryReport] = useState<DeliverySummaryResult | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const idempotencyKeyRef = useRef<string>(createIdempotencyKey());
  const submittingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!open) return;
    idempotencyKeyRef.current = createIdempotencyKey();
    submittingRef.current = false;
    setStage('confirm');
    setCreatedIncident(null);
    setDeliveryResults([]);
    setQueuedItem(null);
    setSimulateAlert(demoMode || Boolean(user?.isDemoAccount));
    setError('');
    setDeliveryReport(null);
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy: acc } = pos.coords;
          if (
            Number.isFinite(latitude) &&
            latitude >= -90 &&
            latitude <= 90 &&
            Number.isFinite(longitude) &&
            longitude >= -180 &&
            longitude <= 180
          ) {
            setLat(latitude);
            setLng(longitude);
            setAccuracy(Number.isFinite(acc) ? Math.round(acc) : null);
            setLocationLabel(`GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
          } else {
            setLocationLabel('Invalid GPS reading — enter address or landmark manually');
          }
        },
        () => {
          setLocationLabel('Location permission declined — enter address or landmark manually');
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    } else {
      setLocationLabel('Browser geolocation unavailable — enter landmark manually');
    }
  }, [open, demoMode, user?.isDemoAccount]);

  const triggerSosDispatch = async () => {
    if (submittingRef.current) return;
    if (!user) {
      setError('Please sign in to submit an SOS incident to operators, or dial 911/112 directly.');
      setStage('confirm');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError('');

    const payload = {
      idempotencyKey: idempotencyKeyRef.current,
      clientQueuedAt: new Date().toISOString(),
      title,
      description,
      category,
      priority: 'CRITICAL',
      latitude: lat,
      longitude: lng,
      locationLabel,
      locationAccuracyMeters: accuracy,
      isSimulated: simulateAlert,
    };

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const queued = enqueueOfflineSos({
        userId: user.id,
        userUid: user.uid,
        ...payload,
      });
      setQueuedItem(queued);
      setStage('queued_offline');
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    try {
      const res = await apiFetch<{
        incident: EmergencyIncident;
        deliveryResults: Array<{ recipient: string; channel: string; status: string; provider: string; error?: string }>;
        deliverySummary?: DeliverySummaryResult;
        deduplicated?: boolean;
      }>('/api/incidents/sos', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setCreatedIncident(res.incident);
      setDeliveryResults(res.deliveryResults || []);
      setDeliveryReport(res.deliverySummary || null);
      setStage('active');
      await refreshAllData();
    } catch (err) {
      const isNetworkFailure =
        !navigator.onLine ||
        err instanceof TypeError ||
        (err instanceof Error && /network|fetch|offline|failed to fetch/i.test(err.message));
      if (isNetworkFailure) {
        const queued = enqueueOfflineSos({
          userId: user.id,
          userUid: user.uid,
          ...payload,
        });
        setQueuedItem(queued);
        setStage('queued_offline');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to send SOS alert.');
        setStage('confirm');
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (stage !== 'countdown') return;
    if (countdown <= 0) {
      void triggerSosDispatch();
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, countdown]);

  const startVoiceNote = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setTranscribing(true);
        try {
          const reader = new FileReader();
          reader.onloadend = async () => {
            const base64 = String(reader.result || '').split(',')[1] || '';
            try {
              const res = await apiFetch<{ transcript: string }>('/api/ai/transcribe', {
                method: 'POST',
                body: JSON.stringify({ audioBase64: base64, mimeType: blob.type || 'audio/webm' }),
              });
              if (res.transcript) {
                setDescription((prev) => (prev ? `${prev}\n${res.transcript}` : res.transcript));
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Voice transcription failed.');
            } finally {
              setTranscribing(false);
            }
          };
          reader.readAsDataURL(blob);
        } catch {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError('Microphone permission unavailable for voice note transcription.');
    }
  };

  const stopVoiceNote = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const handleCancelActiveSos = async () => {
    if (!createdIncident || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await apiFetch(`/api/incidents/${createdIncident.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Cancelled', note: 'User cancelled alert and confirmed safe.' }),
      });
      await refreshAllData();
      setStage('confirm');
      setCreatedIncident(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel active SOS right now.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const overallState = deliveryReport?.overallDeliveryState || createdIncident?.deliveryStatus || 'submitted';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-2xl border border-rose-500/40 bg-white dark:bg-[#0B0F1F] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-600 text-white shadow-lg shadow-rose-600/30">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div>
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                LIFE-LINE AI Emergency SOS
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Alerts your trusted contacts & platform operators — does not dial 911/112 automatically
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setStage('confirm');
              setCreatedIncident(null);
              onClose();
            }}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Truthful Emergency Disclaimer */}
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <PhoneCall className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
          <div>
            <strong>Important Safety Disclosure:</strong> LIFE-LINE AI coordinates trusted contacts and authorized
            platform operators. It is <strong>not</strong> connected to municipal 911/112/999 dispatch. If you face
            immediate physical danger, call official emergency services directly.
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
            {error}
          </div>
        )}

        {stage === 'confirm' && (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3">
              <div className="flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 text-violet-500" />
                  Captured Location Context
                </span>
                {accuracy !== null && <span className="tabular-nums text-[11px] text-slate-500">±{accuracy}m accuracy</span>}
              </div>
              <input
                type="text"
                value={locationLabel}
                onChange={(e) => setLocationLabel(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-white"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Incident Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white"
                >
                  <option value="Personal Safety">Personal Safety / Harassment</option>
                  <option value="Medical Urgency">Medical Urgency</option>
                  <option value="Safe Transit">Unsafe Commute / Transit</option>
                  <option value="Domestic / Shelter">Domestic Support / Safe Shelter</option>
                  <option value="Youth Support">Youth Crisis Assistance</option>
                </select>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Situation Details (Optional)</label>
                <button
                  type="button"
                  onClick={recording ? stopVoiceNote : startVoiceNote}
                  disabled={transcribing}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
                    recording
                      ? 'bg-rose-600 text-white'
                      : 'border border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                  }`}
                >
                  {recording ? <Square className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
                  <span>{transcribing ? 'Transcribing...' : recording ? 'Stop Recording' : 'Voice Note (AI Transcribe)'}</span>
                </button>
              </div>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe landmarks, clothing, vehicle info, or what support you need..."
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white"
              />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 text-xs">
              <div>
                <div className="font-semibold text-slate-800 dark:text-slate-200">
                  Trusted Contacts Queued: <span className="tabular-nums text-violet-600 dark:text-violet-400">{contacts.length}</span>
                </div>
                <div className="text-slate-500 dark:text-slate-400">Plus all active LIFE-LINE AI operators</div>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={simulateAlert}
                  onChange={(e) => setSimulateAlert(e.target.checked)}
                  className="rounded border-slate-400 text-violet-600 focus:ring-violet-500"
                />
                <span className="font-medium text-amber-700 dark:text-amber-300">Simulated Sandbox Alert</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  setCountdown(5);
                  setStage('countdown');
                }}
                className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 disabled:opacity-60"
              >
                Start 5s SOS Dispatch
              </button>
            </div>
          </div>
        )}

        {stage === 'countdown' && (
          <div className="mt-6 text-center py-6 space-y-5">
            <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-4 border-rose-500 bg-rose-500/15 font-display text-4xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
              {submitting ? '...' : countdown}
            </div>
            <div>
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                {submitting ? 'Dispatching SOS Alert...' : 'Confirming SOS Activation'}
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Cancel immediately if triggered accidentally.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setStage('confirm')}
                className="rounded-xl border border-slate-300 dark:border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200"
              >
                Cancel Accidental Alert
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={triggerSosDispatch}
                className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-500 disabled:opacity-60"
              >
                Send Immediately
              </button>
            </div>
          </div>
        )}

        {stage === 'active' && createdIncident && (
          <div className="mt-5 space-y-4">
            <div
              className={`rounded-xl border p-4 flex items-start gap-3 ${
                overallState === 'delivered'
                  ? 'border-emerald-500/35 bg-emerald-500/10'
                  : overallState === 'failed'
                  ? 'border-rose-500/35 bg-rose-500/10'
                  : 'border-amber-500/35 bg-amber-500/10'
              }`}
            >
              <CheckCircle2
                className={`h-5 w-5 shrink-0 mt-0.5 ${
                  overallState === 'delivered'
                    ? 'text-emerald-500'
                    : overallState === 'failed'
                    ? 'text-rose-500'
                    : 'text-amber-500'
                }`}
              />
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <span>
                    Incident #{createdIncident.id} — {createdIncident.status}
                  </span>
                  <span className="rounded px-2 py-0.5 font-mono text-[11px] uppercase bg-slate-900/10 dark:bg-white/10">
                    delivery: {overallState}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">
                  {deliveryReport?.truthfulMessage ||
                    'Real-time operator synchronization active. Operators see your incident immediately.'}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <Radio className="h-4 w-4 text-violet-500" />
                <span>Verified Alert Delivery Audit</span>
              </div>
              {deliveryResults.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  In-app operator alert submitted. Add trusted contacts on your Dashboard to dispatch Email/SMS alerts.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {deliveryResults.map((d, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between text-xs border-b border-slate-100 dark:border-slate-800/80 pb-1 last:border-0"
                    >
                      <span className="text-slate-700 dark:text-slate-300">
                        {d.recipient} ({d.channel})
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                          d.status === 'delivered' || d.status === 'simulated'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : d.status === 'failed'
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {d.status} · {d.provider}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleCancelActiveSos}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>Mark Safe / Cancel SOS</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage('confirm');
                  setCreatedIncident(null);
                  onClose();
                }}
                className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
              >
                Return to Dashboard
              </button>
            </div>
          </div>
        )}
        {stage === 'queued_offline' && queuedItem && (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
              <WifiOff className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <span>Temporary Network Interruption — SOS Queued</span>
                  <span className="rounded px-2 py-0.5 font-mono text-[11px] uppercase bg-amber-500/20 text-amber-800 dark:text-amber-200">
                    {queuedItem.state}
                  </span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                  Your SOS report ({queuedItem.locationLabel}) is securely bound to your account (expires after 24h) and
                  will auto-submit with deduplication key <span className="font-mono">{queuedItem.idempotencyKey}</span>{' '}
                  when connectivity returns.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3.5 space-y-2">
              <div className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                Direct Cellular / Voice Emergency Numbers
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href="tel:911"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white"
                >
                  <PhoneCall className="h-3.5 w-3.5" />
                  <span>Call 911</span>
                </a>
                <a
                  href="tel:112"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-bold text-rose-700 dark:text-rose-300"
                >
                  <PhoneCall className="h-3.5 w-3.5" />
                  <span>Call 112</span>
                </a>
              </div>
            </div>

            {contacts.length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Cached Trusted Contacts ({contacts.length})
                </div>
                {contacts.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-xs">
                    <span className="text-slate-800 dark:text-slate-200">
                      {c.name} ({c.relationship})
                    </span>
                    {c.phone ? (
                      <a href={`tel:${c.phone}`} className="font-mono font-semibold text-violet-600 dark:text-violet-400 underline">
                        {c.phone}
                      </a>
                    ) : (
                      <span className="text-slate-500">{c.email}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={submitting}
                onClick={triggerSosDispatch}
                className="rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300"
              >
                Retry Dispatch Now
              </button>
              <button
                type="button"
                onClick={() => {
                  setStage('confirm');
                  setQueuedItem(null);
                  onClose();
                }}
                className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Keep Queued & Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
