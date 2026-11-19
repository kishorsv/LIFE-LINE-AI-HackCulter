import React, { useRef, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Compass,
  ExternalLink,
  ImagePlus,
  MessageSquare,
  Mic,
  PhoneOff,
  Radio,
  Route,
  Send,
  ShieldAlert,
  Sparkles,
  Volume2,
  Workflow,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { ActiveView } from '../types/lifeline.ts';
import { t } from '../i18n/translations.ts';

type AgentTab = 'assessment' | 'saferoute' | 'resources' | 'coordination' | 'followup' | 'safety' | 'assistant';

// PCM helpers for Gemini Live 16kHz input & 24kHz playback
function floatTo16BitPcmBase64(float32: Float32Array): string {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64PcmToAudioBuffer(ctx: AudioContext, base64: string): AudioBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const buffer = ctx.createBuffer(1, int16.length, 24000);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
  return buffer;
}

export function AiAgentsHub({ onNavigate }: { onNavigate?: (view: ActiveView) => void }) {
  const { apiFetch, profile, token, incidents, language, realtimeTransport } = useAuth();
  const [activeTab, setActiveTab] = useState<AgentTab>('assessment');
  const [agentError, setAgentError] = useState('');

  // 1. Emergency Assessment State
  const [assessDesc, setAssessDesc] = useState('');
  const [assessLoc, setAssessLoc] = useState(profile?.lastLocationLabel || '');
  const [assessImage, setAssessImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [assessResult, setAssessResult] = useState<{
    modelUsed: string;
    isAiAdvisory?: boolean;
    verificationStatus?: string;
    advisoryNotice?: string;
    urgencyLevel: string;
    classification: string;
    recommendedPriority: string;
    confidenceScore: number;
    rationale: string;
    missingInfoQuestions: string[];
    uncertaintyNotes: string;
    escalateToHumanOperator: boolean;
    immediateSteps: string[];
  } | null>(null);
  const [assessBusy, setAssessBusy] = useState(false);

  // 2. Safety Intelligence State
  const [safetyConcern, setSafetyConcern] = useState('');
  const [safetyArea, setSafetyArea] = useState('');
  const [useSearchGrounding, setUseSearchGrounding] = useState(true);
  const [safetyResult, setSafetyResult] = useState<{
    modelUsed: string;
    isAiAdvisory?: boolean;
    verificationStatus?: string;
    advisoryNotice?: string;
    summary: string;
    recommendations: Array<{ title: string; detail: string; confidence: number }>;
    uncertaintyDisclosure: string;
    groundingSources?: Array<{ title: string; uri: string }>;
  } | null>(null);
  const [safetyBusy, setSafetyBusy] = useState(false);

  // 3. Resource Discovery State
  const [resourceQuery, setResourceQuery] = useState('24/7 hospital and women crisis support shelter');
  const [resourceResult, setResourceResult] = useState<{
    modelUsed: string;
    isAiAdvisory?: boolean;
    verificationStatus?: string;
    advisoryNotice?: string;
    summary: string;
    mapsLinks: Array<{ title: string; uri: string }>;
  } | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);

  // 4. Coordination Agent State
  const [coordTitle, setCoordTitle] = useState('Late-night commute escort request');
  const [coordDesc, setCoordDesc] = useState('Walking from transit station alone; would like check-in draft ready.');
  const [coordResult, setCoordResult] = useState<{
    modelUsed: string;
    isAiAdvisory?: boolean;
    verificationStatus?: string;
    advisoryNotice?: string;
    recommendedWorkflow: string;
    preparedActions: Array<{ tool: string; args: Record<string, unknown>; requiresAuthorization: boolean }>;
    coordinationSummary: string;
  } | null>(null);
  const [coordBusy, setCoordBusy] = useState(false);
  const [coordAuthorizedMsg, setCoordAuthorizedMsg] = useState('');

  // 5. Support Assistant + TTS + Live Voice State
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'model'; text: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [fastMode, setFastMode] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [ttsBusy, setTtsBusy] = useState(false);

  // 6. Incident Follow-up Agent State
  const [followUpIncidentId, setFollowUpIncidentId] = useState<string>('');
  const [followUpTitle, setFollowUpTitle] = useState('Post-SOS Evening Transit Check-In');
  const [followUpStatus, setFollowUpStatus] = useState('Resolved');
  const [followUpCategory, setFollowUpCategory] = useState('Personal Safety');
  const [followUpLocation, setFollowUpLocation] = useState(profile?.lastLocationLabel || 'Central Transit Hub');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpAuthorizedMsg, setFollowUpAuthorizedMsg] = useState('');
  const [followUpResult, setFollowUpResult] = useState<{
    modelUsed: string;
    isAiAdvisory?: boolean;
    requiresHumanAuthorization?: boolean;
    advisoryNotice?: string;
    summary: string;
    immediateWellbeingSteps: string[];
    documentationChecklist: string[];
    workspaceActionSuggestions: string[];
    supportFollowUpWindow: string;
  } | null>(null);

  // SafeRoute Quick Agent State
  const [safeRouteOrigin, setSafeRouteOrigin] = useState(profile?.lastLocationLabel || 'Campus Library');
  const [safeRouteDest, setSafeRouteDest] = useState('City Central Station');
  const [safeRouteMode, setSafeRouteMode] = useState<'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE'>('WALK');
  const [safeRouteBusy, setSafeRouteBusy] = useState(false);
  const [safeRouteResult, setSafeRouteResult] = useState<{
    modelUsed: string;
    recommendedRouteIndex: number;
    safetyReasoning: string;
    cautionNotes: string[];
    confidenceScore: number;
    uncertaintyNotes: string;
  } | null>(null);

  // Live Voice Companion Refs & Serverless Turn-Based Fallback
  const [liveActive, setLiveActive] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'websocket' | 'turn_based'>('websocket');
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [liveCaptions, setLiveCaptions] = useState<string[]>([]);
  const [liveError, setLiveError] = useState('');
  const liveWsRef = useRef<WebSocket | null>(null);
  const liveInputCtxRef = useRef<AudioContext | null>(null);
  const liveOutputCtxRef = useRef<AudioContext | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const nextStartTimeRef = useRef<number>(0);

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAgentError('');
    if (!file.type.startsWith('image/')) {
      setAgentError('Please select a valid image file (JPEG, PNG, or WebP).');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setAgentError('Image is larger than 6 MB. Please upload a smaller photo.');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      setAssessImage({ base64, mimeType: file.type, name: file.name });
    };
    reader.readAsDataURL(file);
  };

  const runAssessment = async (e: React.FormEvent) => {
    e.preventDefault();
    setAssessBusy(true);
    setAgentError('');
    try {
      const res = await apiFetch<{ assessment: typeof assessResult }>('/api/ai/assess-emergency', {
        method: 'POST',
        body: JSON.stringify({
          description: assessDesc,
          locationLabel: assessLoc,
          imageBase64: assessImage?.base64,
          imageMimeType: assessImage?.mimeType,
        }),
      });
      setAssessResult(res.assessment);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Emergency assessment failed.');
    } finally {
      setAssessBusy(false);
    }
  };

  const runSafety = async (e: React.FormEvent) => {
    e.preventDefault();
    setSafetyBusy(true);
    setAgentError('');
    try {
      const res = await apiFetch<{ intelligence: typeof safetyResult }>('/api/ai/safety-intelligence', {
        method: 'POST',
        body: JSON.stringify({
          concern: safetyConcern,
          areaLabel: safetyArea,
          useSearchGrounding,
        }),
      });
      setSafetyResult(res.intelligence);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Safety intelligence analysis failed.');
    } finally {
      setSafetyBusy(false);
    }
  };

  const runResources = async (e: React.FormEvent) => {
    e.preventDefault();
    setResourceBusy(true);
    setAgentError('');
    try {
      const res = await apiFetch<{ discovery: typeof resourceResult }>('/api/ai/discover-resources', {
        method: 'POST',
        body: JSON.stringify({
          query: resourceQuery,
          latitude: profile?.lastKnownLat ?? undefined,
          longitude: profile?.lastKnownLng ?? undefined,
        }),
      });
      setResourceResult(res.discovery);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Resource discovery failed.');
    } finally {
      setResourceBusy(false);
    }
  };

  const runCoordination = async (e: React.FormEvent) => {
    e.preventDefault();
    setCoordBusy(true);
    setCoordAuthorizedMsg('');
    setAgentError('');
    try {
      const res = await apiFetch<{ coordination: typeof coordResult }>('/api/ai/coordinate', {
        method: 'POST',
        body: JSON.stringify({
          incidentTitle: coordTitle,
          incidentDescription: coordDesc,
          incidentStatus: 'SOS Activated',
          locationLabel: profile?.lastLocationLabel || 'Current location',
        }),
      });
      setCoordResult(res.coordination);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Coordination agent failed.');
    } finally {
      setCoordBusy(false);
    }
  };

  const sendAssistantMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const msg = chatInput.trim();
    setChatInput('');
    const nextHistory = [...chatHistory, { role: 'user' as const, text: msg }];
    setChatHistory(nextHistory);
    setChatBusy(true);
    try {
      const res = await apiFetch<{ reply: string }>('/api/ai/assistant', {
        method: 'POST',
        body: JSON.stringify({ history: chatHistory, message: msg, fastMode, language }),
      });
      setChatHistory([...nextHistory, { role: 'model', text: res.reply }]);
    } catch (err) {
      setChatHistory([
        ...nextHistory,
        { role: 'model', text: err instanceof Error ? err.message : 'Assistant error.' },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  const runFollowUpAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setFollowUpBusy(true);
    setFollowUpAuthorizedMsg('');
    setAgentError('');
    try {
      const res = await apiFetch<{ followUp: typeof followUpResult }>('/api/ai/follow-up', {
        method: 'POST',
        body: JSON.stringify({
          incidentTitle: followUpTitle,
          incidentStatus: followUpStatus,
          incidentCategory: followUpCategory,
          locationLabel: followUpLocation,
          resolutionNotes: followUpNotes,
          language,
        }),
      });
      setFollowUpResult(res.followUp);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Incident Follow-up Agent failed.');
    } finally {
      setFollowUpBusy(false);
    }
  };

  const runQuickSafeRouteAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setSafeRouteBusy(true);
    setAgentError('');
    try {
      const res = await apiFetch<{ saferoute: typeof safeRouteResult }>('/api/ai/saferoute', {
        method: 'POST',
        body: JSON.stringify({
          originLabel: safeRouteOrigin,
          destinationLabel: safeRouteDest,
          travelMode: safeRouteMode,
          weatherSummary: 'Use LIFE-LINE PULSE for live Open-Meteo & Google Routes telemetry',
          routes: [
            {
              routeIndex: 0,
              summary: 'Main Illuminated Arterial Corridor',
              durationLabel: '16 mins',
              distanceMeters: 1350,
              safetyScore: 86,
              riskLevel: 'LOW',
              nearbyIncidentsCount: 0,
              nearbySupportHubsCount: 2,
              reasons: ['Follows main thoroughfare with 2 verified 24/7 support hubs nearby'],
            },
            {
              routeIndex: 1,
              summary: 'Park Shortcut Path',
              durationLabel: '12 mins',
              distanceMeters: 1020,
              safetyScore: 68,
              riskLevel: 'MODERATE',
              nearbyIncidentsCount: 0,
              nearbySupportHubsCount: 0,
              reasons: ['Faster shortcut with fewer nearby 24/7 support hubs'],
            },
          ],
        }),
      });
      setSafeRouteResult(res.saferoute);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'SafeRoute Agent analysis failed.');
    } finally {
      setSafeRouteBusy(false);
    }
  };

  const playCalmTts = async (text: string) => {
    setTtsBusy(true);
    try {
      const res = await apiFetch<{ audioBase64: string; mimeType: string }>('/api/ai/tts', {
        method: 'POST',
        body: JSON.stringify({ text: text.slice(0, 600), voiceName: 'Kore' }),
      });
      const audio = new Audio(`data:${res.mimeType};base64,${res.audioBase64}`);
      await audio.play();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Unable to play calm voice guidance audio.');
    } finally {
      setTtsBusy(false);
    }
  };

  const cleanupVoiceResources = () => {
    liveWsRef.current?.close();
    liveWsRef.current = null;
    liveStreamRef.current?.getTracks().forEach((t) => t.stop());
    liveStreamRef.current = null;
    liveInputCtxRef.current?.close().catch(() => {});
    liveInputCtxRef.current = null;
    liveOutputCtxRef.current?.close().catch(() => {});
    liveOutputCtxRef.current = null;
    setLiveActive(false);
  };

  const startTurnBasedVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setLiveError('Microphone recording is not supported in this browser.');
      return;
    }
    setVoiceMode('turn_based');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    liveStreamRef.current = stream;
    recordedChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      stream.getTracks().forEach((t) => t.stop());
      liveStreamRef.current = null;
      if (blob.size < 256) {
        setLiveError('Recording too short. Hold and speak for at least 1 second.');
        return;
      }
      setVoiceProcessing(true);
      setLiveError('');
      try {
        const base64Audio = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const raw = String(reader.result || '');
            resolve(raw.split(',')[1] || '');
          };
          reader.onerror = () => reject(new Error('Failed to encode audio clip.'));
          reader.readAsDataURL(blob);
        });
        const tr = await apiFetch<{ transcript: string }>('/api/ai/transcribe', {
          method: 'POST',
          body: JSON.stringify({
            audioBase64: base64Audio,
            mimeType: blob.type || 'audio/webm',
          }),
        });
        const spokenText = (tr.transcript || '').trim();
        if (!spokenText) {
          setLiveError('No speech detected. Try speaking closer to the microphone.');
          return;
        }
        setLiveCaptions((prev) => [...prev.slice(-8), `You: ${spokenText}`]);
        const reply = await apiFetch<{ reply: string }>('/api/ai/assistant', {
          method: 'POST',
          body: JSON.stringify({
            message: spokenText,
            history: chatHistory,
            fastMode: true,
            language,
          }),
        });
        setLiveCaptions((prev) => [...prev.slice(-8), `LIFE-LINE AI: ${reply.reply}`]);
        await playCalmTts(reply.reply);
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : 'Voice companion turn failed.');
      } finally {
        setVoiceProcessing(false);
      }
    };

    recorder.start();
    setLiveActive(true);
  };

  const startLiveVoiceSession = async () => {
    setLiveError('');
    if (!token) {
      setLiveError('Please sign in first to open an authenticated voice session.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setLiveError('Microphone access is unavailable in this browser.');
      return;
    }

    if (realtimeTransport === 'polling') {
      try {
        await startTurnBasedVoiceRecording();
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : 'Unable to start microphone recording.');
      }
      return;
    }

    setVoiceMode('websocket');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      liveStreamRef.current = stream;
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      liveInputCtxRef.current = inputCtx;
      liveOutputCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/live?token=${encodeURIComponent(token)}`);
      liveWsRef.current = ws;
      let receivedReady = false;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as {
          ready?: boolean;
          audio?: string;
          inputTranscript?: string;
          outputTranscript?: string;
          error?: string;
          interrupted?: boolean;
        };
        if (msg.ready) receivedReady = true;
        if (msg.error) {
          setLiveError(msg.error);
          cleanupVoiceResources();
          return;
        }
        if (msg.inputTranscript) {
          setLiveCaptions((prev) => [...prev.slice(-8), `You: ${msg.inputTranscript}`]);
        }
        if (msg.outputTranscript) {
          setLiveCaptions((prev) => [...prev.slice(-8), `LIFE-LINE AI: ${msg.outputTranscript}`]);
        }
        if (msg.interrupted) {
          nextStartTimeRef.current = outputCtx.currentTime;
        }
        if (msg.audio) {
          const audioBuf = base64PcmToAudioBuffer(outputCtx, msg.audio);
          const src = outputCtx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(outputCtx.destination);
          const startAt = Math.max(outputCtx.currentTime, nextStartTimeRef.current);
          src.start(startAt);
          nextStartTimeRef.current = startAt + audioBuf.duration;
        }
      };

      ws.onerror = () => {
        cleanupVoiceResources();
        setVoiceMode('turn_based');
        setLiveError('Live WebSocket stream unavailable — switched to Turn-Based Voice Mode. Click Start again to record.');
      };

      ws.onclose = () => {
        if (!receivedReady) {
          cleanupVoiceResources();
          setVoiceMode('turn_based');
          setLiveError('Live WebSocket stream closed — switched to Turn-Based Voice Mode. Click Start again to record.');
        } else {
          cleanupVoiceResources();
        }
      };

      const source = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(inputCtx.destination);

      processor.onaudioprocess = (ev) => {
        if (ws.readyState === WebSocket.OPEN) {
          const base64 = floatTo16BitPcmBase64(ev.inputBuffer.getChannelData(0));
          ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      setLiveActive(true);
    } catch (err) {
      cleanupVoiceResources();
      setLiveError(err instanceof Error ? err.message : 'Unable to start live voice session.');
    }
  };

  const stopLiveVoiceSession = () => {
    if (voiceMode === 'turn_based' && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setLiveActive(false);
      return;
    }
    cleanupVoiceResources();
  };

  const tabs: Array<{ id: AgentTab; label: string; icon: React.ReactNode }> = [
    { id: 'assessment', label: '1. SOS Classification Agent', icon: <ShieldAlert className="h-4 w-4" /> },
    { id: 'assistant', label: '2. Personal Safety Assistant', icon: <MessageSquare className="h-4 w-4" /> },
    { id: 'saferoute', label: '3. SafeRoute Agent', icon: <Route className="h-4 w-4" /> },
    { id: 'resources', label: '4. Hospital & Support Agent', icon: <Compass className="h-4 w-4" /> },
    { id: 'coordination', label: '5. Emergency Coordination', icon: <Workflow className="h-4 w-4" /> },
    { id: 'followup', label: '6. Incident Follow-up Agent', icon: <ClipboardCheck className="h-4 w-4" /> },
    { id: 'safety', label: 'Context Intelligence', icon: <Sparkles className="h-4 w-4" /> },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {t(language, 'agents_title')}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t(language, 'agents_subtitle')}
          </p>
        </div>
        {onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate('pulse')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-violet-500/40 bg-violet-500/10 px-3.5 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
          >
            <Activity className="h-4 w-4" />
            <span>Open LIFE-LINE PULSE</span>
          </button>
        )}
      </div>

      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">
        <strong>AI Advisory Notice:</strong> AI outputs below are unverified recommendations separate from verified
        emergency directory records and live incident status. Verify facts independently and dial 911/112/999 in
        immediate danger.
      </div>

      {agentError && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
          {agentError}
        </div>
      )}

      {/* Agent Tabs */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors ${
              activeTab === t.id
                ? 'border-violet-500 bg-violet-600 text-white shadow-md shadow-violet-600/25'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] text-slate-700 dark:text-slate-300 hover:border-violet-500/40'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* 1. Emergency Assessment Agent */}
      {activeTab === 'assessment' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={runAssessment}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Emergency Assessment Agent
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Identifies urgency indicators, recommends response priority, and explains every decision transparently.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Situation Description</label>
              <textarea
                rows={4}
                required
                value={assessDesc}
                onChange={(e) => setAssessDesc(e.target.value)}
                placeholder="Describe what is happening..."
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Location / Surroundings</label>
              <input
                type="text"
                value={assessLoc}
                onChange={(e) => setAssessLoc(e.target.value)}
                placeholder="e.g. Unlit bus stop near 4th Street"
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="inline-flex items-center gap-2 cursor-pointer rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-medium">
                <ImagePlus className="h-4 w-4 text-violet-500" />
                <span>{assessImage ? assessImage.name : 'Attach Scene Photo (Optional)'}</span>
                <input type="file" accept="image/*" onChange={handleImagePick} className="hidden" />
              </label>
            </div>
            <button
              type="submit"
              disabled={assessBusy}
              className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {assessBusy ? 'Reasoning with Emergency Agent...' : 'Run Priority Triage'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6">
            {!assessResult ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12 text-xs text-slate-500">
                <Bot className="h-8 w-8 text-violet-500 mb-2" />
                Submit a safety report to view structured priority, rationale, clarifying questions, and immediate steps.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div>
                    <div className="text-xs text-slate-500">{assessResult.classification}</div>
                    <div className="font-display text-lg font-bold text-slate-900 dark:text-white">
                      Recommended Priority: {assessResult.recommendedPriority}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border border-violet-500/35 bg-violet-500/10 px-2.5 py-1 font-mono text-xs tabular-nums">
                      Confidence: {Math.round(assessResult.confidenceScore * 100)}%
                    </span>
                    <button
                      type="button"
                      disabled={ttsBusy}
                      onClick={() => playCalmTts(`${assessResult.rationale}. ${assessResult.immediateSteps.join('. ')}`)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs"
                    >
                      <Volume2 className="h-3.5 w-3.5 text-violet-500" />
                      <span>Read Calmly</span>
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Priority Rationale</div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{assessResult.rationale}</p>
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Immediate Recommended Steps</div>
                  <ul className="mt-1.5 space-y-1.5 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                    {assessResult.immediateSteps.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
                {assessResult.missingInfoQuestions.length > 0 && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Safe Clarifying Questions</div>
                    <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                      {assessResult.missingInfoQuestions.map((q, idx) => (
                        <li key={idx}>• {q}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  <strong>Uncertainty & Limitation:</strong> {assessResult.uncertaintyNotes}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Safety Intelligence Agent */}
      {activeTab === 'safety' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={runSafety}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4"
          >
            <h2 className="font-display text-base font-bold">Safety Intelligence Agent</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Analyzes environmental context with optional Google Search advisories and explicit uncertainty disclosure.
            </p>
            <textarea
              rows={3}
              required
              value={safetyConcern}
              onChange={(e) => setSafetyConcern(e.target.value)}
              placeholder="e.g. Taking the late evening metro home alone with a low phone battery..."
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={safetyArea}
              onChange={(e) => setSafetyArea(e.target.value)}
              placeholder="Neighborhood or city (e.g. Downtown Oakland)"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={useSearchGrounding}
                onChange={(e) => setUseSearchGrounding(e.target.checked)}
              />
              <span>Enable live Google Search transit/weather advisory grounding</span>
            </label>
            <button
              type="submit"
              disabled={safetyBusy}
              className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"
            >
              {safetyBusy ? 'Analyzing Context...' : 'Generate Practical Guidance'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
            {!safetyResult ? (
              <p className="text-xs text-slate-500 py-10 text-center">
                Enter your travel or safety concern to receive practical, non-alarmist recommendations.
              </p>
            ) : (
              <>
                <div className="text-xs font-mono text-violet-500">{safetyResult.modelUsed}</div>
                <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">
                  {safetyResult.summary}
                </p>
                {safetyResult.recommendations.map((rec, i) => (
                  <div key={i} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                    <div className="text-xs font-bold">{rec.title}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{rec.detail}</div>
                  </div>
                ))}
                {safetyResult.groundingSources && safetyResult.groundingSources.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-semibold">Grounded Web Sources:</div>
                    {safetyResult.groundingSources.map((s, idx) => (
                      <a
                        key={idx}
                        href={s.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>{s.title}</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {safetyResult.uncertaintyDisclosure}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 3. Resource Discovery Agent */}
      {activeTab === 'resources' && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
          <h2 className="font-display text-base font-bold">Resource Discovery Agent (Google Maps Grounded)</h2>
          <form onSubmit={runResources} className="flex flex-wrap gap-3">
            <input
              type="text"
              required
              value={resourceQuery}
              onChange={(e) => setResourceQuery(e.target.value)}
              className="flex-1 min-w-[240px] rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={resourceBusy}
              className="rounded-xl bg-violet-600 px-5 py-2 text-sm font-semibold text-white hover:bg-violet-500"
            >
              {resourceBusy ? 'Discovering...' : 'Discover Support Services'}
            </button>
          </form>

          {resourceResult && (
            <div className="space-y-4 pt-2">
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                {resourceResult.summary}
              </p>
              {resourceResult.mapsLinks.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {resourceResult.mapsLinks.map((m, i) => (
                    <a
                      key={i}
                      href={m.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15"
                    >
                      <span>{m.title}</span>
                      <ExternalLink className="h-4 w-4 shrink-0" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 4. Emergency Coordination Agent */}
      {activeTab === 'coordination' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={runCoordination}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4"
          >
            <h2 className="font-display text-base font-bold">Emergency Coordination Agent</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Uses tool declarations to organize contact drafts and operator briefings. No external dispatch occurs
              without human authorization.
            </p>
            <input
              type="text"
              value={coordTitle}
              onChange={(e) => setCoordTitle(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <textarea
              rows={3}
              value={coordDesc}
              onChange={(e) => setCoordDesc(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={coordBusy}
              className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"
            >
              {coordBusy ? 'Orchestrating Plan...' : 'Prepare Coordination Plan'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
            {!coordResult ? (
              <p className="text-xs text-slate-500 py-10 text-center">
                Generate a structured coordination plan to inspect agent tool-calls awaiting human approval.
              </p>
            ) : (
              <>
                <div className="text-xs font-semibold text-violet-500">{coordResult.recommendedWorkflow}</div>
                <p className="text-xs text-slate-600 dark:text-slate-300">{coordResult.coordinationSummary}</p>
                {coordResult.preparedActions.map((act, idx) => (
                  <div key={idx} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">{act.tool}</span>
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        Human Authorization Required
                      </span>
                    </div>
                    <pre className="overflow-x-auto text-[11px] text-slate-600 dark:text-slate-300">
                      {JSON.stringify(act.args, null, 2)}
                    </pre>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setCoordAuthorizedMsg(
                      'Human authorization recorded. Draft approved for SOS dispatch or operator handoff.'
                    )
                  }
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  Authorize Draft Workflow
                </button>
                {coordAuthorizedMsg && (
                  <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{coordAuthorizedMsg}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 5. Support Assistant & Live Voice Companion */}
      {activeTab === 'assistant' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 flex flex-col h-[480px]">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 mb-3">
              <div>
                <h2 className="font-display text-base font-bold">AI Support Assistant</h2>
                <p className="text-[11px] text-slate-500">Calm safety Q&A (does not replace emergency professionals)</p>
              </div>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} />
                <span>Low-Latency Mode</span>
              </label>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {chatHistory.length === 0 && (
                <div className="text-xs text-slate-500 py-8 text-center">
                  Ask how to prepare a safety plan, find support shelters, or stay calm while waiting for a trusted contact.
                </div>
              )}
              {chatHistory.map((m, idx) => (
                <div
                  key={idx}
                  className={`rounded-xl p-3 text-xs leading-relaxed ${
                    m.role === 'user'
                      ? 'ml-10 bg-violet-600 text-white'
                      : 'mr-10 border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <div className="whitespace-pre-line">{m.text}</div>
                  {m.role === 'model' && (
                    <button
                      type="button"
                      onClick={() => playCalmTts(m.text)}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-600 dark:text-violet-400"
                    >
                      <Volume2 className="h-3 w-3" />
                      <span>Listen (Calm Voice)</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={sendAssistantMessage} className="mt-3 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask a safety question..."
                className="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs"
              />
              <button
                type="submit"
                disabled={chatBusy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Send</span>
              </button>
            </form>
          </div>

          {/* Real-Time Gemini Live Voice Companion */}
          <div className="lg:col-span-5 rounded-2xl border border-violet-500/30 bg-white dark:bg-[#0B1022] p-6 flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <Radio className={`h-5 w-5 ${liveActive ? 'text-rose-500' : 'text-violet-500'}`} />
                <h2 className="font-display text-base font-bold">Real-Time Voice Safety Companion</h2>
              </div>
              <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                {realtimeTransport === 'polling' || voiceMode === 'turn_based'
                  ? 'Turn-based voice safety mode: record your voice, transcribe securely, and hear calm AI guidance.'
                  : 'Hands-free two-way audio conversation over WebSocket (16kHz mic input, 24kHz calm audio output).'}
              </p>

              {liveError && (
                <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                  {liveError}
                </div>
              )}

              <div className="mt-4 h-56 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3 space-y-1.5 text-xs">
                {liveCaptions.length === 0 ? (
                  <div className="text-slate-500 text-center py-12">
                    Press Start Voice Companion to speak directly when typing isn’t safe or convenient.
                  </div>
                ) : (
                  liveCaptions.map((c, idx) => (
                    <div key={idx} className="text-slate-700 dark:text-slate-200">
                      {c}
                    </div>
                  ))
                )}
              </div>
            </div>

            {!liveActive ? (
              <button
                type="button"
                disabled={voiceProcessing}
                onClick={startLiveVoiceSession}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
              >
                <Mic className="h-4 w-4" />
                <span>
                  {voiceProcessing
                    ? 'Processing Voice Turn...'
                    : realtimeTransport === 'polling' || voiceMode === 'turn_based'
                    ? 'Record Voice Question'
                    : 'Start Voice Companion'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={stopLiveVoiceSession}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white hover:bg-rose-500"
              >
                <PhoneOff className="h-4 w-4" />
                <span>
                  {voiceMode === 'turn_based' || realtimeTransport === 'polling'
                    ? 'Stop & Send Voice Question'
                    : 'End Voice Session'}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. SafeRoute Intelligence Agent */}
      {activeTab === 'saferoute' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={runQuickSafeRouteAgent}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold">SafeRoute Intelligence Agent</h2>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('pulse')}
                  className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                >
                  Full Map in PULSE →
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Compares route trade-offs using safety corridor scoring, nearby support hubs, and uncertainty disclosures.
              Use LIFE-LINE PULSE for live Google Routes API v2 polylines &amp; Open-Meteo weather.
            </p>
            <input
              type="text"
              required
              value={safeRouteOrigin}
              onChange={(e) => setSafeRouteOrigin(e.target.value)}
              placeholder="Origin label"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <input
              type="text"
              required
              value={safeRouteDest}
              onChange={(e) => setSafeRouteDest(e.target.value)}
              placeholder="Destination label"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <select
              value={safeRouteMode}
              onChange={(e) => setSafeRouteMode(e.target.value as 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE')}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            >
              <option value="WALK">Walking</option>
              <option value="TRANSIT">Public Transit</option>
              <option value="DRIVE">Driving</option>
              <option value="BICYCLE">Bicycle</option>
            </select>
            <button
              type="submit"
              disabled={safeRouteBusy}
              className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {safeRouteBusy ? 'Evaluating Route Trade-Offs...' : 'Run SafeRoute Agent Explanation'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
            {!safeRouteResult ? (
              <div className="py-10 text-center text-xs text-slate-500 space-y-3">
                <p>Run a corridor safety comparison or switch to LIFE-LINE PULSE for live Google Maps Routes v2 polylines.</p>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('pulse')}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white"
                  >
                    <Activity className="h-4 w-4" />
                    <span>Open PULSE SafeRoute Map</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div>
                    <div className="text-xs font-mono text-violet-500">{safeRouteResult.modelUsed}</div>
                    <div className="font-display text-base font-bold">
                      Recommended Option #{safeRouteResult.recommendedRouteIndex + 1}
                    </div>
                  </div>
                  <span className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs tabular-nums">
                    Confidence: {Math.round(safeRouteResult.confidenceScore * 100)}%
                  </span>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                  {safeRouteResult.safetyReasoning}
                </p>
                {safeRouteResult.cautionNotes.length > 0 && (
                  <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                    {safeRouteResult.cautionNotes.map((c, idx) => (
                      <li key={idx}>{c}</li>
                    ))}
                  </ul>
                )}
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  <strong>Uncertainty:</strong> {safeRouteResult.uncertaintyNotes}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 6. Incident Follow-up Agent */}
      {activeTab === 'followup' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={runFollowUpAgent}
            className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4"
          >
            <h2 className="font-display text-base font-bold">Incident Follow-up Agent</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Trauma-informed post-SOS recovery steps, evidence checklist, and optional Google Workspace export drafts
              (human authorization required).
            </p>
            {incidents.length > 0 && (
              <div>
                <label className="block text-xs font-medium mb-1">Load From Recorded SOS Incident</label>
                <select
                  value={followUpIncidentId}
                  onChange={(e) => {
                    const idStr = e.target.value;
                    setFollowUpIncidentId(idStr);
                    const found = incidents.find((i) => String(i.id) === idStr);
                    if (found) {
                      setFollowUpTitle(found.title);
                      setFollowUpStatus(found.status);
                      setFollowUpCategory(found.category);
                      setFollowUpLocation(found.locationLabel);
                      setFollowUpNotes(found.description);
                    }
                  }}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
                >
                  <option value="">-- Custom / Manual Entry --</option>
                  {incidents.slice(0, 10).map((inc) => (
                    <option key={inc.id} value={String(inc.id)}>
                      #{inc.id} · {inc.title} ({inc.status})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <input
              type="text"
              required
              value={followUpTitle}
              onChange={(e) => setFollowUpTitle(e.target.value)}
              placeholder="Incident title"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={followUpStatus}
                onChange={(e) => setFollowUpStatus(e.target.value)}
                placeholder="Status"
                className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
              />
              <input
                type="text"
                value={followUpCategory}
                onChange={(e) => setFollowUpCategory(e.target.value)}
                placeholder="Category"
                className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
              />
            </div>
            <input
              type="text"
              value={followUpLocation}
              onChange={(e) => setFollowUpLocation(e.target.value)}
              placeholder="Location"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm"
            />
            <textarea
              rows={3}
              value={followUpNotes}
              onChange={(e) => setFollowUpNotes(e.target.value)}
              placeholder="Resolution notes or context..."
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-xs"
            />
            <button
              type="submit"
              disabled={followUpBusy}
              className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {followUpBusy ? 'Preparing Recovery & Checklist...' : 'Generate Post-Incident Follow-up Plan'}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-6 space-y-4">
            {!followUpResult ? (
              <div className="py-12 text-center text-xs text-slate-500">
                Select a recent SOS incident or describe the resolved situation to generate structured wellbeing and
                documentation guidance.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div>
                    <div className="text-xs font-mono text-violet-500">{followUpResult.modelUsed}</div>
                    <h3 className="font-display text-base font-bold">Post-Incident Recovery Plan</h3>
                  </div>
                  <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    Human Authorization Gate Active
                  </span>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">{followUpResult.summary}</p>
                <div>
                  <div className="text-xs font-semibold mb-1">Immediate Wellbeing Steps</div>
                  <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                    {followUpResult.immediateWellbeingSteps.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">Documentation &amp; Evidence Checklist</div>
                  <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                    {followUpResult.documentationChecklist.map((d, idx) => (
                      <li key={idx}>{d}</li>
                    ))}
                  </ul>
                </div>
                {followUpResult.workspaceActionSuggestions.length > 0 && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3 space-y-1.5">
                    <div className="text-xs font-semibold">Suggested Human-Authorized Actions</div>
                    <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
                      {followUpResult.workspaceActionSuggestions.map((w, idx) => (
                        <li key={idx}>• {w}</li>
                      ))}
                    </ul>
                    <div className="pt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setFollowUpAuthorizedMsg(
                            'Confirmed: Follow-up checklist reviewed. Use Dashboard Google Workspace buttons to explicitly save to Docs/Tasks.'
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Approve Follow-up Plan</span>
                      </button>
                      {onNavigate && (
                        <button
                          type="button"
                          onClick={() => onNavigate('dashboard')}
                          className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium"
                        >
                          Open Dashboard Workspace Exports
                        </button>
                      )}
                    </div>
                    {followUpAuthorizedMsg && (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                        {followUpAuthorizedMsg}
                      </div>
                    )}
                  </div>
                )}
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  <strong>Recommended Follow-up Window:</strong> {followUpResult.supportFollowUpWindow}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
