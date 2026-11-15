import React from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  Compass,
  Lock,
  MapPin,
  Radio,
  Shield,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';
import { ActiveView } from '../types/lifeline.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { LifeLineLogo } from './LifeLineLogo.tsx';

interface LandingPageProps {
  onNavigate: (view: ActiveView) => void;
  onOpenAuth: () => void;
  onOpenSos: () => void;
}

export function LandingPage({ onNavigate, onOpenAuth, onOpenSos }: LandingPageProps) {
  const { user, loginDemoRole } = useAuth();

  const handlePrimaryStart = () => {
    if (user) {
      onNavigate('dashboard');
    } else {
      onOpenAuth();
    }
  };

  const handleEmergencySupport = async () => {
    if (user) {
      onOpenSos();
    } else {
      onOpenAuth();
    }
  };

  const handleExploreDemo = async () => {
    if (!user) {
      await loginDemoRole('regular_user');
    }
    onNavigate('dashboard');
  };

  const agents = [
    {
      name: 'SOS Classification Agent',
      role: 'Deep Priority Triage',
      desc: 'Analyzes text, location context, and photos to classify urgency, ask safe clarifying questions, and explain every priority rationale.',
    },
    {
      name: 'SafeRoute Intelligence Agent',
      role: 'Predictive Corridor Scoring',
      desc: 'Compares Google Maps Routes v2 options alongside verified incidents, Open-Meteo weather, and 24/7 support hub proximity.',
    },
    {
      name: 'Hospital & Support Matching Agent',
      role: 'Verified Nearby Support',
      desc: 'Locates nearby hospitals, shelters, youth centers, and women’s helplines using live Google Maps grounding and source timestamps.',
    },
    {
      name: 'Emergency Coordination Agent',
      role: 'Human-Authorized Workflows',
      desc: 'Organizes trusted contact drafts and operator briefings via structured tool calls—always requiring human confirmation before dispatch.',
    },
    {
      name: 'Incident Follow-up Agent',
      role: 'Trauma-Informed Post-SOS Care',
      desc: 'Guides post-incident wellbeing steps, evidence preservation checklists, and optional Google Docs/Tasks documentation exports.',
    },
    {
      name: 'Personal Safety Assistant & Live Voice',
      role: 'Bilingual Guidance (EN / ಕನ್ನಡ)',
      desc: 'Provides real-time two-way voice guidance, calm safety Q&A, audio transcription, and steady TTS instructions when typing is unsafe.',
    },
  ];

  const workflowSteps = [
    { step: '01', title: 'Activate & Capture Context', desc: 'Tap SOS or launch LIFE-LINE PULSE. Geolocation, weather telemetry, and optional voice context are captured with a 5s cancel guard.' },
    { step: '02', title: 'Alert Trusted Circle & Operators', desc: 'Real-time WebSocket dispatch notifies authorized operators and delivers multi-channel alerts with honest provider confirmation logs.' },
    { step: '03', title: '6-Agent Triage & SafeRoute', desc: 'Six specialized AI agents assess priority, surface verified nearby shelters/hospitals, and compare safer Google Maps Routes v2 corridors.' },
    { step: '04', title: 'Human Acknowledgment & Follow-Up', desc: 'Authorized responders acknowledge alerts, coordinate assistance in real time, and support safe arrival & post-incident recovery.' },
  ];

  return (
    <div className="bg-slate-50 dark:bg-[#060916] text-slate-900 dark:text-slate-100">
      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-slate-200 dark:border-violet-500/15">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(124,58,237,0.22),_transparent_55%),radial-gradient(ellipse_at_bottom_left,_rgba(225,29,72,0.12),_transparent_50%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:py-20">
          <div className="grid items-center gap-12 lg:grid-cols-12">
            {/* Hero Copy */}
            <div className="lg:col-span-6 space-y-6">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-600 dark:text-violet-400">
                Youth & Women Public Safety Ecosystem
              </div>
              <h1 className="font-display text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-5xl lg:text-[3.35rem] leading-[1.08]">
                Your Safety. Your Support.{' '}
                <span className="bg-gradient-to-r from-violet-500 via-purple-400 to-fuchsia-400 bg-clip-text text-transparent">
                  One Intelligent Lifeline.
                </span>
              </h1>
              <p className="max-w-xl text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                LIFE-LINE AI combines instant SOS workflows, <strong>LIFE-LINE PULSE</strong> predictive risk &amp;
                SafeRoute intelligence, real-time operator synchronization, and six transparent Gemini-powered safety
                agents built with strict human oversight.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handlePrimaryStart}
                  className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500 transition-colors"
                >
                  <span>Get Started</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={handleEmergencySupport}
                  className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-rose-600/25 hover:bg-rose-500 transition-colors"
                >
                  <ShieldAlert className="h-4 w-4" />
                  <span>Access Emergency Support</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('pulse')}
                  className="inline-flex items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3 text-sm font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20 transition-colors"
                >
                  <Activity className="h-4 w-4" />
                  <span>Open PULSE</span>
                </button>
                <button
                  type="button"
                  onClick={handleExploreDemo}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/70 px-5 py-3 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:border-violet-500/50 transition-colors"
                >
                  <span>Explore Platform</span>
                </button>
              </div>

              <div className="pt-2 text-xs text-slate-500 dark:text-slate-400">
                Transparent limitations: LIFE-LINE AI supports personal safety & community response and does not
                replace official emergency numbers (911 / 112 / 999).
              </div>
            </div>

            {/* Hero Animated Safety Intelligence Visualization */}
            <div className="lg:col-span-6">
              <div className="relative rounded-3xl border border-slate-200/90 dark:border-violet-500/30 bg-white/80 dark:bg-[#0B1126]/90 p-5 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 mb-4">
                  <div className="flex items-center gap-2">
                    <Radio className="h-4 w-4 text-violet-500" />
                    <span className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      Safety Intelligence Console
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    SIMULATED TELEMETRY PREVIEW
                  </span>
                </div>

                {/* Animated Radar + Route Network SVG */}
                <div className="relative overflow-hidden rounded-2xl border border-slate-200 dark:border-violet-500/20 bg-slate-950 p-4">
                  <svg viewBox="0 0 520 260" className="w-full h-auto" role="img" aria-label="Animated Safety Intelligence Radar">
                    <defs>
                      <radialGradient id="radarGlow" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.38" />
                        <stop offset="65%" stopColor="#4C1D95" stopOpacity="0.12" />
                        <stop offset="100%" stopColor="#050814" stopOpacity="0" />
                      </radialGradient>
                      <linearGradient id="routeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#A855F7" />
                        <stop offset="100%" stopColor="#38BDF8" />
                      </linearGradient>
                    </defs>

                    {/* Subtle grid */}
                    <g stroke="#1E293B" strokeWidth="1" opacity="0.65">
                      <line x1="0" y1="65" x2="520" y2="65" />
                      <line x1="0" y1="130" x2="520" y2="130" />
                      <line x1="0" y1="195" x2="520" y2="195" />
                      <line x1="130" y1="0" x2="130" y2="260" />
                      <line x1="260" y1="0" x2="260" y2="260" />
                      <line x1="390" y1="0" x2="390" y2="260" />
                    </g>

                    {/* Radar rings */}
                    <circle cx="260" cy="130" r="108" fill="url(#radarGlow)" />
                    <circle cx="260" cy="130" r="95" fill="none" stroke="#6D28D9" strokeWidth="1" strokeDasharray="4 4" opacity="0.55" />
                    <circle cx="260" cy="130" r="62" fill="none" stroke="#8B5CF6" strokeWidth="1" opacity="0.45" />
                    <circle cx="260" cy="130" r="30" fill="none" stroke="#A78BFA" strokeWidth="1.2" opacity="0.7" />

                    {/* Animated Sweep Line */}
                    <line x1="260" y1="130" x2="345" y2="75" stroke="#C084FC" strokeWidth="2" opacity="0.85">
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from="0 260 130"
                        to="360 260 130"
                        dur="6s"
                        repeatCount="indefinite"
                      />
                    </line>

                    {/* Safe Corridor Route */}
                    <path
                      d="M 80 205 Q 170 175 260 130 T 430 70"
                      fill="none"
                      stroke="url(#routeGrad)"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />

                    {/* Verified Support Nodes */}
                    <g>
                      <circle cx="430" cy="70" r="7" fill="#10B981" />
                      <text x="378" y="54" fill="#A7F3D0" fontSize="11" fontFamily="monospace">
                        24/7 SAFE HUB
                      </text>
                    </g>
                    <g>
                      <circle cx="80" cy="205" r="7" fill="#38BDF8" />
                      <text x="58" y="232" fill="#BAE6FD" fontSize="11" fontFamily="monospace">
                        TRANSIT CORRIDOR
                      </text>
                    </g>

                    {/* Center Protected User Node */}
                    <circle cx="260" cy="130" r="14" fill="#E11D48" opacity="0.28">
                      <animate attributeName="r" values="10;22;10" dur="2.4s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.45;0.08;0.45" dur="2.4s" repeatCount="indefinite" />
                    </circle>
                    <circle cx="260" cy="130" r="7" fill="#F43F5E" stroke="#FFFFFF" strokeWidth="2" />
                  </svg>
                </div>

                {/* 3 Compact Telemetry Cards */}
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-3">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">SOS Guard</div>
                    <div className="mt-0.5 font-display text-sm font-bold text-rose-600 dark:text-rose-400">
                      5s Cancel Shield
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-3">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">AI Agents</div>
                    <div className="mt-0.5 font-display text-sm font-bold tabular-nums text-violet-600 dark:text-violet-400">
                      6 Active Specialists
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-3">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Operator Sync</div>
                    <div className="mt-0.5 font-display text-sm font-bold text-emerald-600 dark:text-emerald-400">
                      Real-Time WS
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Problem & Vision */}
      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1226] p-6">
            <LifeLineLogo variant="mark" size="sm" />
            <h2 className="mt-4 font-display text-lg font-bold text-slate-900 dark:text-white">Why LIFE-LINE AI Exists</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Women and young people commuting, studying, or navigating unfamiliar areas often face fragmented tools:
              static helpline lists, slow contact alerts, and zero structured triage when seconds matter.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1226] p-6">
            <MapPin className="h-6 w-6 text-emerald-500" />
            <h2 className="mt-4 font-display text-lg font-bold text-slate-900 dark:text-white">Verified Location Intelligence</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Live Google Maps routes, Places API (New) support discovery, and explicit source & verification timestamps
              prevent hallucinations about shelter capacity or 24/7 availability.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1226] p-6">
            <Lock className="h-6 w-6 text-rose-500" />
            <h2 className="mt-4 font-display text-lg font-bold text-slate-900 dark:text-white">Human-in-the-Loop Safety</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Role-based access control, immutable audit logs, explicit confirmation before Google Workspace actions,
              and honest uncertainty disclosures keep humans firmly in control.
            </p>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="border-y border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#090E20]">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white sm:text-3xl">
              How Emergency Support Works
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              End-to-end coordination from a single SOS tap to responder acknowledgment and safe resolution.
            </p>
          </div>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {workflowSteps.map((w) => (
              <div
                key={w.step}
                className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D142B] p-5"
              >
                <div className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">STEP {w.step}</div>
                <h3 className="mt-2 font-display text-base font-bold text-slate-900 dark:text-white">{w.title}</h3>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{w.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agentic AI Capabilities */}
      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white sm:text-3xl">
              Six Specialized Safety AI Agents
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Server-side Gemini orchestration with structured reasoning, Google Search/Maps grounding, and deterministic fallbacks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => (user ? onNavigate('agents') : onOpenAuth())}
            className="inline-flex items-center gap-2 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
          >
            <Bot className="h-4 w-4" />
            <span>Open AI Agents Hub</span>
          </button>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <div
              key={a.name}
              className="rounded-2xl border border-slate-200 dark:border-violet-500/20 bg-white dark:bg-[#0C1226] p-5 hover:border-violet-500/50 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-violet-600 dark:text-violet-400 font-semibold">
                <span>{a.role}</span>
                <Sparkles className="h-4 w-4" />
              </div>
              <h3 className="mt-2 font-display text-base font-bold text-slate-900 dark:text-white">{a.name}</h3>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{a.desc}</p>
            </div>
          ))}

          {/* Direct Map Explorer Card */}
          <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-transparent to-violet-500/10 p-5 flex flex-col justify-between">
            <div>
              <Compass className="h-6 w-6 text-emerald-500" />
              <h3 className="mt-3 font-display text-base font-bold text-slate-900 dark:text-white">
                Interactive Live Support Map
              </h3>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Explore nearby hospitals, shelters, youth centers, and safe routes powered by Google Maps Platform.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('map')}
              className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
            >
              <span>Launch Live Map</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* Clearly Labeled Demo Impact Statistics */}
      <section className="border-t border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#090E20]">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
            <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              Platform Response Benchmarks
            </h2>
            <span className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 font-mono text-[11px] font-medium text-amber-700 dark:text-amber-300">
              DEMO TARGET BENCHMARKS · LABELED SIMULATION DATA
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Activity className="h-4 w-4 text-rose-500" />
                <span>SOS Dispatch Latency (Demo Target)</span>
              </div>
              <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                &lt; 1.2s
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Users className="h-4 w-4 text-violet-500" />
                <span>Supported Roles (RBAC)</span>
              </div>
              <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                4 Personas
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Bot className="h-4 w-4 text-purple-500" />
                <span>Specialized Safety Agents</span>
              </div>
              <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                6 Agents
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <Shield className="h-4 w-4 text-emerald-500" />
                <span>Relational Persistence Schema</span>
              </div>
              <div className="mt-2 font-display text-2xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                16 Tables
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-[#050814]">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <LifeLineLogo variant="compact" size="xs" />
            <span>
              Agentic Safety &amp; Emergency Response Intelligence Platform (Youth &amp; Women Safety).
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="https://cloud.google.com/maps-platform/terms?utm_campaign=gmp_mcp_codeassist_v1_aistudio"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              Google Maps Platform Terms
            </a>
            <button type="button" onClick={() => onNavigate('map')} className="hover:underline">
              Support Directory
            </button>
            <button type="button" onClick={handleExploreDemo} className="hover:underline">
              Judge Sandbox
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
