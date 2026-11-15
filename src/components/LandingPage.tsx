import React, { useState } from 'react';
import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  HeartHandshake,
  Lock,
  Mail,
  MapPin,
  Navigation,
  PhoneCall,
  Radio,
  Route,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { ActiveView } from '../types/lifeline.ts';
import { useAuth } from '../contexts/AuthContext.tsx';
import { LifeLineLogo } from './LifeLineLogo.tsx';
import { ParallaxBackdrop, ScrollProgressBar, ScrollReveal } from './CinematicPrimitives.tsx';

import heroCityImg from '../assets/images/hero_city_network_1794749202766.jpg';
import problemNightImg from '../assets/images/problem_night_commute_1794749202374.jpg';
import youthWomenImg from '../assets/images/youth_women_safety_1794749203692.jpg';
import missionHorizonImg from '../assets/images/mission_future_horizon_1794749204105.jpg';

const INNOVATION_NETWORK_IMG = '/assets/aistudio/Screenshot_2026-11-15_184032_9a500a9b.png';
const EMERGENCY_RESPONSE_IMG = '/assets/aistudio/Screenshot_2026-11-15_184024_742eb26f.png';

interface LandingPageProps {
  onNavigate: (view: ActiveView) => void;
  onOpenAuth: () => void;
  onOpenSos: () => void;
}

const AI_AGENTS = [
  {
    id: 'classification',
    code: '01',
    name: 'SOS Classification Agent',
    role: 'Structured Priority Triage',
    summary:
      'Evaluates SOS text, location accuracy, and optional photo context to propose urgency tiers, ask clarifying questions, and surface rationale cleanly separate from raw verified telemetry.',
    guardrail: 'Never overrides user SOS submission or fabricates facts.',
  },
  {
    id: 'saferoute',
    code: '02',
    name: 'SafeRoute Intelligence Agent',
    role: 'Corridor Risk & Weather Correlation',
    summary:
      'Compares Google Maps Routes v2 corridors against verified nearby incidents, Open-Meteo rain/visibility telemetry, and 24/7 support hub proximity with clear comparative explanations.',
    guardrail: 'Explicitly discloses missing coverage & avoids crime predictions.',
  },
  {
    id: 'support',
    code: '03',
    name: 'Hospital & Support Matching Agent',
    role: 'Grounded Resource Discovery',
    summary:
      'Locates nearby hospitals, shelters, youth centers, and women’s crisis support hubs using Google Maps grounding and source verification timestamps.',
    guardrail: 'Only cites grounded directory or Places records.',
  },
  {
    id: 'coordination',
    code: '04',
    name: 'Emergency Coordination Agent',
    role: 'Human-Authorized Workflows',
    summary:
      'Prepares structured alert drafts for trusted contacts, operator handoffs, and Google Workspace logs via validated tool calls.',
    guardrail: 'Requires explicit human confirmation before any external send.',
  },
  {
    id: 'followup',
    code: '05',
    name: 'Incident Follow-up Agent',
    role: 'Trauma-Informed Post-SOS Care',
    summary:
      'Provides steady post-incident stabilization steps, evidence-preservation checklists, and optional Google Docs/Tasks recovery exports.',
    guardrail: 'Calm, non-judgmental, strictly privacy-scoped to the user.',
  },
  {
    id: 'assistant',
    code: '06',
    name: 'Personal Safety & Live Voice Agent',
    role: 'Bilingual Companion (EN / ಕನ್ನಡ)',
    summary:
      'Supports two-way Gemini Live audio guidance, quick safety Q&A, audio transcription, and spoken instructions when hands-free navigation is safer.',
    guardrail: 'Always advises dialing 911 / 112 / 999 in immediate danger.',
  },
] as const;

const SAFEROUTE_OPTIONS = [
  {
    id: 'transit',
    label: 'Recommended · Transit-Lit Corridor',
    duration: '14 min',
    distance: '1.1 km',
    rating: 'Lower Exposure',
    note: 'Follows main pedestrian avenue passing 2 verified 24/7 transit hubs and clear streetlamp coverage.',
    accent: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  },
  {
    id: 'direct',
    label: 'Alternative · Direct Boulevard',
    duration: '11 min',
    distance: '0.9 km',
    rating: 'Moderate Caution',
    note: '3 minutes faster, passes a construction zone with reduced foot traffic and active weather mist.',
    accent: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  },
  {
    id: 'shelter',
    label: 'Support Detour · Safe Hub Route',
    duration: '16 min',
    distance: '1.3 km',
    rating: 'Verified Support',
    note: 'Routes directly beside Safe Haven intake desk and Civic General Hospital emergency entrance.',
    accent: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  },
] as const;

const DEMO_COMMAND_INCIDENTS = [
  {
    id: 'DEMO-408',
    title: 'Late-Transit Check-In Missed',
    corridor: 'Civic Transit Hub · Valencia Corridor',
    priority: 'HIGH',
    status: 'Acknowledged',
    responder: 'Elena Vance (Operator)',
    eta: '2m 15s (DEMO)',
  },
  {
    id: 'DEMO-407',
    title: 'SOS Distress Button Triggered',
    corridor: 'North Campus Walkway · Gate 4',
    priority: 'CRITICAL',
    status: 'Resolving',
    responder: 'Campus Safe Unit + Trusted Circle',
    eta: '48s ack (DEMO)',
  },
  {
    id: 'DEMO-405',
    title: 'SafeRoute Detour Requested',
    corridor: 'Mission Station · South Plaza',
    priority: 'MEDIUM',
    status: 'Resolved',
    responder: 'Safe Haven Coordinator',
    eta: 'Safe arrival confirmed (DEMO)',
  },
] as const;

const HOW_IT_WORKS_STEPS = [
  {
    step: '01',
    id: 'detect',
    title: 'Detect',
    subtitle: 'Instant SOS & Telemetry Capture',
    desc: 'One-tap SOS with a 5-second accidental-cancel shield, missed timed journey check-in, or manual risk scan captures GPS coordinates and weather context—even queueing securely offline when signal drops.',
  },
  {
    step: '02',
    id: 'analyze',
    title: 'Analyze',
    subtitle: 'Evidence-First AI Triage',
    desc: 'The SOS Classification Agent and LIFE-LINE PULSE analyze verified incident logs, Open-Meteo conditions, and route exposure while keeping AI recommendations cleanly separated from verified facts.',
  },
  {
    step: '03',
    id: 'recommend',
    title: 'Recommend',
    subtitle: 'Safer Corridors & Grounded Help',
    desc: 'SafeRoute compares Google Maps Routes v2 options and matches nearby verified shelters, hospitals, and youth hubs with transparent reasoning and confidence levels.',
  },
  {
    step: '04',
    id: 'connect',
    title: 'Connect',
    subtitle: 'Trusted Circle & Authorized Responders',
    desc: 'Authenticated WebSocket streams sync authorized operators and support organizations in real time while sending idempotent, provider-confirmed alerts to trusted contacts.',
  },
  {
    step: '05',
    id: 'followup',
    title: 'Follow Up',
    subtitle: 'Safe Arrival & Recovery Support',
    desc: 'Safe arrival confirmation closes shared journeys, immutable audit logs record every action, and the Follow-up Agent guides calm post-incident care and documentation.',
  },
] as const;

export function LandingPage({ onNavigate, onOpenAuth, onOpenSos }: LandingPageProps) {
  const { user, mapsApiKey, developerContactEmail, loginDemoRole } = useAuth();
  const [selectedAgentId, setSelectedAgentId] = useState<string>('classification');
  const [selectedRouteId, setSelectedRouteId] = useState<string>('transit');
  const [commandPriorityFilter, setCommandPriorityFilter] = useState<'ALL' | 'CRITICAL' | 'HIGH'>('ALL');
  const [activePipelineIndex, setActivePipelineIndex] = useState<number>(0);
  const [privacyNoticeOpen, setPrivacyNoticeOpen] = useState(false);

  const activeAgent = AI_AGENTS.find((a) => a.id === selectedAgentId) || AI_AGENTS[0];
  const activeRoute = SAFEROUTE_OPTIONS.find((r) => r.id === selectedRouteId) || SAFEROUTE_OPTIONS[0];
  const filteredDemoIncidents = DEMO_COMMAND_INCIDENTS.filter((inc) =>
    commandPriorityFilter === 'ALL' ? true : inc.priority === commandPriorityFilter
  );

  const handleGetStarted = () => {
    if (user) {
      onNavigate('dashboard');
    } else {
      onOpenAuth();
    }
  };

  const handleProtectedNav = (view: ActiveView) => {
    if (view !== 'landing' && view !== 'map' && view !== 'pulse' && !user) {
      onOpenAuth();
      return;
    }
    onNavigate(view);
  };

  const handleOpenDemoSandbox = async () => {
    if (!user) {
      await loginDemoRole('regular_user');
    }
    onNavigate('dashboard');
  };

  return (
    <div className="relative bg-[#040712] text-white selection:bg-[#E11D48] selection:text-white">
      <ScrollProgressBar />

      {/* =================================================================== */}
      {/* 01. HERO EXPERIENCE                                                 */}
      {/* =================================================================== */}
      <section
        id="section-hero"
        className="relative flex min-h-[calc(100vh-6.25rem)] flex-col justify-between overflow-hidden border-b border-white/10"
      >
        <ParallaxBackdrop
          src={heroCityImg}
          alt="Illuminated metropolitan skyline and connected urban transit corridors at dusk"
          baseScale={1.04}
          parallaxRange={30}
          zoomDelta={0.07}
          priority
        />

        {/* Deep Midnight Navy & Crimson Atmospheric Vignette */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#040814]/85 via-[#071028]/65 to-[#040712]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_75%_25%,rgba(225,29,72,0.16),transparent_55%),radial-gradient(ellipse_at_20%_75%,rgba(15,39,92,0.45),transparent_60%)]"
        />

        {/* Subtle Animated Connected Safety Network Overlay */}
        <svg
          aria-hidden="true"
          viewBox="0 0 1440 760"
          className="pointer-events-none absolute inset-0 h-full w-full opacity-45"
          preserveAspectRatio="xMidYMid slice"
        >
          <g fill="none" strokeWidth="1.2">
            <path
              d="M 180 540 Q 460 400 720 430 T 1260 240"
              stroke="rgba(255,255,255,0.28)"
              strokeDasharray="6 6"
            />
            <path
              d="M 180 540 Q 460 400 720 430 T 1260 240"
              stroke="#FB7185"
              strokeWidth="2"
              className="animate-pulse-travel"
            />
            <path
              d="M 320 210 Q 640 310 920 260 T 1280 480"
              stroke="rgba(148,163,184,0.22)"
              strokeDasharray="4 6"
            />
          </g>
          <g>
            <circle cx="180" cy="540" r="4.5" fill="#FFFFFF" />
            <circle cx="720" cy="430" r="6" fill="#E11D48" stroke="#FFFFFF" strokeWidth="2" />
            <circle cx="1260" cy="240" r="4.5" fill="#FFFFFF" />
            <circle cx="320" cy="210" r="3.5" fill="#94A3B8" />
            <circle cx="920" cy="260" r="4" fill="#FB7185" />
          </g>
        </svg>

        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-4 py-16 sm:px-6 lg:py-24">
          <div className="max-w-3xl space-y-7">
            <ScrollReveal delayMs={40}>
              <LifeLineLogo
                variant="full"
                size="md"
                tone="dark"
                showSubtitle
                subtitle="AGENTIC SAFETY & EMERGENCY INTELLIGENCE"
              />
            </ScrollReveal>

            <ScrollReveal delayMs={120}>
              <h1
                className="font-display font-extrabold tracking-tight text-white leading-[1.03]"
                style={{ fontSize: 'clamp(2.5rem, 5.4vw, 4.65rem)' }}
              >
                Every Second Matters.{' '}
                <span className="block text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-200 to-[#FB7185]">
                  Every Life Matters.
                </span>
              </h1>
            </ScrollReveal>

            <ScrollReveal delayMs={200}>
              <p className="max-w-2xl text-base sm:text-lg text-slate-300 leading-relaxed">
                An AI-powered safety and emergency response platform uniting instant SOS protection, predictive
                SafeRoute navigation, trusted circle check-ins, and human-authorized responder coordination for youth
                and women worldwide.
              </p>
            </ScrollReveal>

            <ScrollReveal delayMs={280}>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <button
                  type="button"
                  onClick={handleGetStarted}
                  className="inline-flex items-center gap-2.5 rounded-xl bg-[#E11D48] px-6 py-3.5 text-sm font-semibold text-white shadow-xl shadow-[#E11D48]/30 hover:bg-[#BE123C] transition-colors whitespace-nowrap"
                >
                  <span>{user ? 'Open Safety Dashboard' : 'Get Started'}</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <a
                  href="#section-mission"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/5 px-6 py-3.5 text-sm font-semibold text-white backdrop-blur-md hover:bg-white/10 transition-colors whitespace-nowrap"
                >
                  <span>Explore Our Mission</span>
                </a>
                <button
                  type="button"
                  onClick={() => onNavigate('pulse')}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-[#0A1633]/80 px-5 py-3.5 text-sm font-medium text-slate-200 backdrop-blur-md hover:border-white/35 hover:text-white transition-colors whitespace-nowrap"
                >
                  <Activity className="h-4 w-4 text-[#FB7185]" />
                  <span>LIFE-LINE PULSE</span>
                </button>
              </div>
            </ScrollReveal>

            <ScrollReveal delayMs={340}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <PhoneCall className="h-3.5 w-3.5 text-[#FB7185]" />
                  In immediate physical danger, always dial 911 / 112 / 999 directly.
                </span>
                <span className="text-slate-600 hidden sm:inline">•</span>
                <span>Bilingual English &amp; ಕನ್ನಡ · Offline-Ready SOS Queue</span>
              </div>
            </ScrollReveal>
          </div>
        </div>

        {/* Bottom Scroll Cue */}
        <div className="relative z-10 flex justify-center pb-7">
          <a
            href="#section-problem"
            className="group flex flex-col items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300/80 hover:text-white transition-colors"
            aria-label="Scroll down to explore the problem"
          >
            <span>Scroll to Explore</span>
            <ArrowDown className="h-4 w-4 text-[#FB7185] animate-scroll-cue" />
          </a>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 02. THE PROBLEM                                                     */}
      {/* =================================================================== */}
      <section
        id="section-problem"
        className="relative flex min-h-[82vh] items-center overflow-hidden border-b border-white/10"
      >
        <ParallaxBackdrop
          src={problemNightImg}
          alt="Young woman checking her smartphone at a rain-dampened city transit station at dusk"
          baseScale={1.04}
          parallaxRange={34}
          zoomDelta={0.07}
          imgClassName="object-center sm:object-[65%_center]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#040712]/95 via-[#070E24]/82 to-[#040712]/40"
        />

        <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
          <div className="max-w-2xl space-y-6">
            <ScrollReveal>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                02 · THE REALITY WE REFUSE TO ACCEPT
              </div>
            </ScrollReveal>

            <ScrollReveal delayMs={80}>
              <h2
                className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                style={{ fontSize: 'clamp(2.1rem, 4.2vw, 3.5rem)' }}
              >
                Safety Should Never Be a Privilege.
              </h2>
            </ScrollReveal>

            <ScrollReveal delayMs={160}>
              <p className="text-base sm:text-lg text-slate-200 leading-relaxed">
                Every evening, millions of students, young workers, and women navigate dark transit platforms, late
                shift commutes, and unfamiliar neighborhoods alone—relying on disconnected chat threads, buried
                helpline numbers, and map apps blind to street lighting, weather exposure, or verified nearby refuge.
              </p>
            </ScrollReveal>

            <ScrollReveal delayMs={240}>
              <div className="grid gap-5 border-t border-white/15 pt-7 sm:grid-cols-3">
                <div>
                  <div className="font-display text-sm font-bold text-white">Fragmented Tools</div>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Switching between maps, messages, and emergency contacts wastes critical seconds during distress.
                  </p>
                </div>
                <div>
                  <div className="font-display text-sm font-bold text-white">Zero Route Context</div>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Standard navigation optimizes strictly for speed, ignoring weather visibility and verified safe hubs.
                  </p>
                </div>
                <div>
                  <div className="font-display text-sm font-bold text-white">Unstructured Handoffs</div>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Responders and loved ones receive vague messages instead of structured location and priority triage.
                  </p>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 03. OUR INNOVATION                                                  */}
      {/* =================================================================== */}
      <section
        id="section-innovation"
        className="relative overflow-hidden border-b border-white/10 py-20 lg:py-28"
      >
        <ParallaxBackdrop
          src={INNOVATION_NETWORK_IMG}
          alt="Connected global safety intelligence network with human silhouettes"
          baseScale={1.06}
          parallaxRange={28}
          zoomDelta={0.05}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#040712]/95 via-[#070E24]/85 to-[#040712]/95"
        />

        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 space-y-12">
          <div className="max-w-3xl space-y-4">
            <ScrollReveal>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                03 · OUR INNOVATION · LIFE-LINE PULSE
              </div>
            </ScrollReveal>
            <ScrollReveal delayMs={80}>
              <h2
                className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                style={{ fontSize: 'clamp(2rem, 3.8vw, 3.25rem)' }}
              >
                Predictive Safety &amp; Multi-Agent Intelligence — With Strict Human Oversight.
              </h2>
            </ScrollReveal>
            <ScrollReveal delayMs={150}>
              <p className="text-base text-slate-300 leading-relaxed">
                LIFE-LINE PULSE fuses verified incident databases, live Open-Meteo weather telemetry, and Google Maps
                grounding into transparent risk scoring, while six specialized Gemini AI agents assist triage, routing,
                and recovery without ever fabricating data or dispatching autonomously.
              </p>
            </ScrollReveal>
          </div>

          {/* Interactive Animated Multi-Agent Architecture Console */}
          <ScrollReveal delayMs={200}>
            <div className="grid gap-6 lg:grid-cols-12 rounded-3xl border border-white/15 bg-[#070E24]/80 p-5 sm:p-8 backdrop-blur-xl shadow-2xl">
              {/* Left: Agent Selector Network */}
              <div className="lg:col-span-5 space-y-2.5">
                <div className="flex items-center justify-between pb-2 border-b border-white/10">
                  <span className="font-mono text-xs uppercase tracking-wider text-slate-400">
                    6 Specialized Safety Agents
                  </span>
                  <span className="font-mono text-[11px] text-emerald-400">Human-Authorized</span>
                </div>
                {AI_AGENTS.map((agent) => {
                  const selected = agent.id === activeAgent.id;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => setSelectedAgentId(agent.id)}
                      className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                        selected
                          ? 'border-[#E11D48]/70 bg-[#E11D48]/15 text-white shadow-lg shadow-[#E11D48]/10'
                          : 'border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`font-mono text-xs font-bold ${
                            selected ? 'text-[#FB7185]' : 'text-slate-500'
                          }`}
                        >
                          {agent.code}
                        </span>
                        <div className="truncate">
                          <div className="font-display text-sm font-bold truncate">{agent.name}</div>
                          <div className="text-[11px] text-slate-400 truncate">{agent.role}</div>
                        </div>
                      </div>
                      <ChevronRight
                        className={`h-4 w-4 shrink-0 transition-transform ${
                          selected ? 'text-[#FB7185] translate-x-0.5' : 'text-slate-500'
                        }`}
                      />
                    </button>
                  );
                })}
              </div>

              {/* Right: Animated Network Topology + Selected Agent Spec */}
              <div className="lg:col-span-7 flex flex-col justify-between gap-6 rounded-2xl border border-white/10 bg-[#050A19]/90 p-6">
                {/* Animated SVG Signal Hub */}
                <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#040712] p-4">
                  <svg
                    viewBox="0 0 640 190"
                    className="w-full h-auto"
                    role="img"
                    aria-label="LIFE-LINE AI Multi-Agent Intelligence Network Diagram"
                  >
                    <g stroke="rgba(148,163,184,0.2)" strokeWidth="1.5" fill="none">
                      <line x1="95" y1="45" x2="320" y2="95" />
                      <line x1="95" y1="95" x2="320" y2="95" />
                      <line x1="95" y1="145" x2="320" y2="95" />
                      <line x1="320" y1="95" x2="545" y2="55" />
                      <line x1="320" y1="95" x2="545" y2="135" />
                    </g>
                    <g fill="none" stroke="#E11D48" strokeWidth="2.2">
                      <path d="M95 45 L320 95 L545 55" className="animate-pulse-travel" />
                      <path d="M95 145 L320 95 L545 135" className="animate-pulse-travel" />
                    </g>

                    {/* Input Evidence Nodes */}
                    <g fontFamily="monospace" fontSize="10" fill="#CBD5E1">
                      <rect x="16" y="30" width="130" height="30" rx="6" fill="#0B1633" stroke="#334155" />
                      <text x="28" y="49">Verified GPS + SOS</text>
                      <rect x="16" y="80" width="130" height="30" rx="6" fill="#0B1633" stroke="#334155" />
                      <text x="28" y="99">Open-Meteo Weather</text>
                      <rect x="16" y="130" width="130" height="30" rx="6" fill="#0B1633" stroke="#334155" />
                      <text x="28" y="149">Google Maps Places</text>
                    </g>

                    {/* Center Core */}
                    <g>
                      <circle cx="320" cy="95" r="36" fill="#0B1633" stroke="#E11D48" strokeWidth="2" />
                      <text
                        x="320"
                        y="92"
                        textAnchor="middle"
                        fill="#FFFFFF"
                        fontSize="11"
                        fontWeight="700"
                        fontFamily="sans-serif"
                      >
                        PULSE
                      </text>
                      <text
                        x="320"
                        y="107"
                        textAnchor="middle"
                        fill="#FB7185"
                        fontSize="9"
                        fontFamily="monospace"
                      >
                        AGENT CORE
                      </text>
                    </g>

                    {/* Output Guardrailed Nodes */}
                    <g fontFamily="monospace" fontSize="10" fill="#E2E8F0">
                      <rect x="480" y="38" width="144" height="34" rx="6" fill="#0B1633" stroke="#10B981" strokeOpacity="0.6" />
                      <text x="492" y="59">Advisory + Evidence</text>
                      <rect x="480" y="118" width="144" height="34" rx="6" fill="#0B1633" stroke="#E11D48" strokeOpacity="0.7" />
                      <text x="492" y="139">Human-Gated Action</text>
                    </g>
                  </svg>
                </div>

                {/* Selected Agent Details */}
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#FB7185]">
                      AGENT {activeAgent.code} · {activeAgent.role}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>Strict Fact / Advisory Separation</span>
                    </span>
                  </div>
                  <h3 className="font-display text-2xl font-bold text-white">{activeAgent.name}</h3>
                  <p className="text-sm text-slate-300 leading-relaxed">{activeAgent.summary}</p>
                  <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
                    <strong>Safety Guardrail:</strong> {activeAgent.guardrail}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => handleProtectedNav('agents')}
                    className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-xs font-bold text-[#0A1633] hover:bg-slate-200 transition-colors"
                  >
                    <Bot className="h-4 w-4 text-[#E11D48]" />
                    <span>Open 6-Agent Workspace</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('pulse')}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-xs font-semibold text-white hover:bg-white/10 transition-colors"
                  >
                    <span>Launch LIFE-LINE PULSE</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 04. AI SAFEROUTE                                                    */}
      {/* =================================================================== */}
      <section
        id="section-saferoute"
        className="relative overflow-hidden border-b border-white/10 bg-[#050917] py-20 lg:py-28"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 space-y-10">
          <div className="grid gap-8 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-7 space-y-4">
              <ScrollReveal>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                  04 · AI SAFEROUTE INTELLIGENCE
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={80}>
                <h2
                  className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                  style={{ fontSize: 'clamp(2rem, 3.8vw, 3.25rem)' }}
                >
                  Choose the Safer Path — Not Just the Shortest Line.
                </h2>
              </ScrollReveal>
            </div>
            <div className="lg:col-span-5">
              <ScrollReveal delayMs={140}>
                <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
                  Powered by Google Maps Platform Routes v2 and Places grounding, SafeRoute compares walking, transit,
                  and driving corridors with transparent safety reasoning, live weather context, and shareable check-in
                  journeys for your trusted circle.
                </p>
              </ScrollReveal>
            </div>
          </div>

          <ScrollReveal delayMs={180}>
            <div className="grid gap-6 lg:grid-cols-12">
              {/* Interactive Route Cards */}
              <div className="lg:col-span-4 space-y-3">
                {SAFEROUTE_OPTIONS.map((route) => {
                  const selected = route.id === activeRoute.id;
                  return (
                    <button
                      key={route.id}
                      type="button"
                      onClick={() => setSelectedRouteId(route.id)}
                      className={`w-full rounded-2xl border p-4 text-left transition-all ${
                        selected
                          ? 'border-[#E11D48]/70 bg-[#0B1633] shadow-xl shadow-black/40'
                          : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${route.accent}`}>
                          {route.rating}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-300">
                          {route.duration} · {route.distance}
                        </span>
                      </div>
                      <div className="mt-2 font-display text-sm font-bold text-white">{route.label}</div>
                      <p className="mt-1 text-xs text-slate-400 leading-relaxed">{route.note}</p>
                    </button>
                  );
                })}

                <div className="flex flex-wrap gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => onNavigate('pulse')}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#E11D48] px-4 py-3 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors"
                  >
                    <Route className="h-4 w-4" />
                    <span>Compute Live SafeRoute</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('map')}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-xs font-semibold text-white hover:bg-white/10 transition-colors"
                  >
                    <Compass className="h-4 w-4 text-sky-400" />
                    <span>Live Map</span>
                  </button>
                </div>
              </div>

              {/* Large Map Canvas (Live Google Map when key configured; architectural preview fallback otherwise) */}
              <div className="lg:col-span-8 relative overflow-hidden rounded-3xl border border-white/15 bg-[#070E24] min-h-[420px] sm:min-h-[470px] shadow-2xl">
                {mapsApiKey ? (
                  <APIProvider apiKey={mapsApiKey}>
                    <GoogleMap
                      defaultCenter={{ lat: 37.7749, lng: -122.4194 }}
                      defaultZoom={13}
                      mapId="DEMO_MAP_ID"
                      colorScheme="DARK"
                      internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                      disableDefaultUI={false}
                      className="h-full w-full min-h-[420px] sm:min-h-[470px]"
                    >
                      <AdvancedMarker position={{ lat: 37.7819, lng: -122.4126 }} title="Youth Support Hub">
                        <Pin background="#0EA5E9" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
                      </AdvancedMarker>
                      <AdvancedMarker position={{ lat: 37.7656, lng: -122.4218 }} title="Safe Haven Support Hub">
                        <Pin background="#10B981" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
                      </AdvancedMarker>
                      <AdvancedMarker position={{ lat: 37.7749, lng: -122.4194 }} title="Origin Corridor">
                        <Pin background="#E11D48" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
                      </AdvancedMarker>
                    </GoogleMap>
                  </APIProvider>
                ) : (
                  <div className="relative flex h-full min-h-[420px] sm:min-h-[470px] flex-col justify-between p-6">
                    {/* Tactical Vector Corridor Map Canvas */}
                    <svg
                      viewBox="0 0 800 440"
                      className="absolute inset-0 h-full w-full object-cover opacity-85"
                      role="img"
                      aria-label="SafeRoute Corridor Architectural Preview"
                    >
                      <defs>
                        <radialGradient id="srGlow" cx="50%" cy="50%" r="55%">
                          <stop offset="0%" stopColor="#0F295C" stopOpacity="0.45" />
                          <stop offset="100%" stopColor="#050917" stopOpacity="0" />
                        </radialGradient>
                      </defs>
                      <rect width="800" height="440" fill="#060B1D" />
                      <circle cx="420" cy="220" r="240" fill="url(#srGlow)" />
                      {/* Urban Grid */}
                      <g stroke="#162344" strokeWidth="1">
                        {[70, 140, 210, 280, 350].map((y) => (
                          <line key={y} x1="0" y1={y} x2="800" y2={y} />
                        ))}
                        {[100, 200, 300, 400, 500, 600, 700].map((x) => (
                          <line key={x} x1={x} y1="0" x2={x} y2="440" />
                        ))}
                      </g>
                      {/* Alternative Direct Corridor */}
                      <path
                        d="M 130 330 L 420 245 L 670 115"
                        fill="none"
                        stroke="#F59E0B"
                        strokeOpacity={selectedRouteId === 'direct' ? 0.95 : 0.25}
                        strokeWidth={selectedRouteId === 'direct' ? 5 : 2.5}
                        strokeDasharray="8 6"
                      />
                      {/* Recommended Transit-Lit Corridor */}
                      <path
                        d="M 130 330 Q 250 185 430 165 T 670 115"
                        fill="none"
                        stroke="#10B981"
                        strokeOpacity={selectedRouteId === 'transit' ? 1 : 0.35}
                        strokeWidth={selectedRouteId === 'transit' ? 6 : 3}
                        strokeLinecap="round"
                      />
                      {/* Support Hub Detour */}
                      <path
                        d="M 130 330 Q 340 355 510 270 T 670 115"
                        fill="none"
                        stroke="#38BDF8"
                        strokeOpacity={selectedRouteId === 'shelter' ? 0.95 : 0.3}
                        strokeWidth={selectedRouteId === 'shelter' ? 5 : 2.5}
                        strokeLinecap="round"
                      />
                      {/* Pins */}
                      <g>
                        <circle cx="130" cy="330" r="10" fill="#E11D48" stroke="#FFFFFF" strokeWidth="2.5" />
                        <text x="146" y="334" fill="#FFFFFF" fontSize="12" fontFamily="monospace">
                          ORIGIN · USER DEPARTURE
                        </text>
                        <circle cx="430" cy="165" r="8" fill="#10B981" stroke="#FFFFFF" strokeWidth="2" />
                        <text x="360" y="147" fill="#A7F3D0" fontSize="11" fontFamily="monospace">
                          24/7 SAFE HUB + TRANSIT
                        </text>
                        <circle cx="510" cy="270" r="8" fill="#38BDF8" stroke="#FFFFFF" strokeWidth="2" />
                        <text x="450" y="294" fill="#BAE6FD" fontSize="11" fontFamily="monospace">
                          CIVIC HOSPITAL ENTRANCE
                        </text>
                        <circle cx="670" cy="115" r="10" fill="#FFFFFF" stroke="#0A1633" strokeWidth="3" />
                        <text x="560" y="96" fill="#FFFFFF" fontSize="12" fontFamily="monospace">
                          SAFE DESTINATION
                        </text>
                      </g>
                    </svg>

                    <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
                      <span className="rounded-lg border border-white/15 bg-[#040712]/85 px-3 py-1.5 font-mono text-[11px] text-slate-300 backdrop-blur-md">
                        ARCHITECTURAL CORRIDOR PREVIEW · Configure Google Maps Key for Live Tiles
                      </span>
                      <span className="rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-1.5 font-mono text-[11px] font-semibold text-emerald-300">
                        Journey Sharing + Timed Check-Ins
                      </span>
                    </div>
                  </div>
                )}

                {/* Bottom Glass Route Explanation Strip */}
                <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/15 bg-[#040712]/88 px-4 py-3 backdrop-blur-xl">
                  <div className="flex items-center gap-3">
                    <Navigation className="h-4 w-4 text-[#FB7185] shrink-0" />
                    <div className="text-xs">
                      <span className="font-semibold text-white">{activeRoute.label}</span>
                      <span className="hidden sm:inline text-slate-400"> — {activeRoute.note}</span>
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold tabular-nums text-white">
                    {activeRoute.duration} · {activeRoute.distance}
                  </span>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 05. EMERGENCY RESPONSE                                              */}
      {/* =================================================================== */}
      <section
        id="section-response"
        className="relative flex min-h-[82vh] items-center overflow-hidden border-b border-white/10"
      >
        <ParallaxBackdrop
          src={EMERGENCY_RESPONSE_IMG}
          alt="Emergency responders operating beside an illuminated ambulance on a rain-slicked city street at night"
          baseScale={1.06}
          parallaxRange={34}
          zoomDelta={0.07}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-l from-[#040712]/96 via-[#070E24]/82 to-[#040712]/45"
        />

        <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
          <div className="ml-auto max-w-2xl space-y-6">
            <ScrollReveal>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                05 · CRITICAL EMERGENCY RESPONSE
              </div>
            </ScrollReveal>

            <ScrollReveal delayMs={80}>
              <h2
                className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                style={{ fontSize: 'clamp(2.1rem, 4.1vw, 3.4rem)' }}
              >
                Reliable SOS Orchestration Under Extreme Pressure.
              </h2>
            </ScrollReveal>

            <ScrollReveal delayMs={160}>
              <p className="text-base sm:text-lg text-slate-200 leading-relaxed">
                When an alert is triggered, LIFE-LINE AI enforces a 5-second accidental-cancel guard, locks alerts to
                unique idempotency keys, queues safely offline when networks fail, and reports only provider-confirmed
                delivery states to your trusted circle and authorized operators.
              </p>
            </ScrollReveal>

            <ScrollReveal delayMs={240}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/15 bg-[#060B1D]/80 p-4 backdrop-blur-md">
                  <div className="font-mono text-[11px] text-[#FB7185]">01 · QUEUED &rarr; SUBMITTED &rarr; DELIVERED</div>
                  <div className="mt-1 font-display text-sm font-bold text-white">Truthful Provider Receipts</div>
                  <p className="mt-1 text-xs text-slate-300">
                    Never claims an alert was delivered unless SMTP, Resend, or Twilio confirms transmission.
                  </p>
                </div>
                <div className="rounded-2xl border border-white/15 bg-[#060B1D]/80 p-4 backdrop-blur-md">
                  <div className="font-mono text-[11px] text-emerald-400">02 · USER-SCOPED &amp; DEDUPLICATED</div>
                  <div className="mt-1 font-display text-sm font-bold text-white">Offline Resilience</div>
                  <p className="mt-1 text-xs text-slate-300">
                    Service Worker caches core SOS assets while idempotency keys prevent duplicate alerts on reconnect.
                  </p>
                </div>
              </div>
            </ScrollReveal>

            <ScrollReveal delayMs={300}>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => (user ? onOpenSos() : onOpenAuth())}
                  className="inline-flex items-center gap-2.5 rounded-xl bg-[#E11D48] px-6 py-3 text-sm font-semibold text-white shadow-xl shadow-[#E11D48]/30 hover:bg-[#BE123C] transition-colors"
                >
                  <ShieldAlert className="h-4 w-4" />
                  <span>{user ? 'Open SOS Workflow' : 'Sign In to Activate SOS'}</span>
                </button>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 06. LIVE COMMAND CENTER (DEMO DATA LABELED)                         */}
      {/* =================================================================== */}
      <section
        id="section-command"
        className="relative overflow-hidden border-b border-white/10 bg-[#040712] py-20 lg:py-28"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(15,39,92,0.42),transparent_65%)]"
        />

        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 space-y-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl space-y-3">
              <ScrollReveal>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                  06 · OPERATOR COMMAND CENTER
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={80}>
                <h2
                  className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                  style={{ fontSize: 'clamp(2rem, 3.8vw, 3.2rem)' }}
                >
                  Real-Time Dispatch, Responder Duty &amp; Audit Integrity.
                </h2>
              </ScrollReveal>
            </div>
            <ScrollReveal delayMs={140}>
              <span className="inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3.5 py-2 font-mono text-xs font-bold text-amber-200">
                DEMO DATA · SIMULATED TELEMETRY PREVIEW
              </span>
            </ScrollReveal>
          </div>

          <ScrollReveal delayMs={180}>
            <div className="rounded-3xl border border-white/15 bg-[#070E24]/90 p-5 sm:p-7 shadow-2xl backdrop-blur-xl">
              {/* Top Console Strip */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <LifeLineLogo variant="mark" size="xs" tone="dark" />
                  <div>
                    <div className="font-display text-sm font-bold text-white">
                      Command Desk Preview (Demo Dataset)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Role-gated WebSocket queue · Replay recovery · Immutable operator audit logs
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(['ALL', 'CRITICAL', 'HIGH'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setCommandPriorityFilter(f)}
                      className={`rounded-lg px-3 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                        commandPriorityFilter === f
                          ? 'bg-[#E11D48] text-white'
                          : 'border border-white/15 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {/* Console Body */}
              <div className="mt-6 grid gap-6 lg:grid-cols-12">
                <div className="lg:col-span-8 space-y-3">
                  {filteredDemoIncidents.map((inc) => (
                    <div
                      key={inc.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#050A19] px-4 py-3.5"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-xs font-bold text-slate-400">{inc.id}</span>
                          <span
                            className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                              inc.priority === 'CRITICAL'
                                ? 'bg-[#E11D48]/20 text-[#FB7185]'
                                : inc.priority === 'HIGH'
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'bg-sky-500/20 text-sky-300'
                            }`}
                          >
                            {inc.priority}
                          </span>
                          <span className="font-display text-sm font-bold text-white">{inc.title}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-[#FB7185]" />
                            {inc.corridor}
                          </span>
                          <span>· Responder: {inc.responder}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xs font-semibold text-emerald-400">{inc.status}</div>
                        <div className="font-mono text-[11px] tabular-nums text-slate-400">{inc.eta}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Right Metrics Panel (Strictly Labeled DEMO DATA) */}
                <div className="lg:col-span-4 flex flex-col justify-between gap-4 rounded-2xl border border-white/10 bg-[#050A19] p-5">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono uppercase tracking-wider text-slate-400">Simulated Telemetry</span>
                      <span className="font-mono text-[10px] text-amber-300">DEMO DATA</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <div className="text-[11px] text-slate-400">Target Ack SLA</div>
                        <div className="mt-1 font-display text-xl font-extrabold tabular-nums text-white">
                          &lt; 1.2s
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <div className="text-[11px] text-slate-400">RBAC Personas</div>
                        <div className="mt-1 font-display text-xl font-extrabold tabular-nums text-white">
                          4 Roles
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 text-xs text-slate-300">
                      <div className="flex items-center gap-2">
                        <Radio className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Authenticated WS + sequence replay recovery</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Lock className="h-3.5 w-3.5 text-[#FB7185]" />
                        <span>Internal operator notes stripped from user feeds</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleProtectedNav('operator')}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-xs font-bold text-[#0A1633] hover:bg-slate-200 transition-colors"
                  >
                    <span>Open Operator Command Center</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 07. YOUTH AND WOMEN SAFETY                                          */}
      {/* =================================================================== */}
      <section
        id="section-safety"
        className="relative flex min-h-[82vh] items-center overflow-hidden border-b border-white/10"
      >
        <ParallaxBackdrop
          src={youthWomenImg}
          alt="Two young women walking confidently together across an illuminated university campus at twilight"
          baseScale={1.04}
          parallaxRange={32}
          zoomDelta={0.06}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#040712] via-[#040712]/72 to-[#040712]/55"
        />

        <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
          <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-6 space-y-5">
              <ScrollReveal>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                  07 · DESIGNED FOR YOUTH &amp; WOMEN
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={80}>
                <h2
                  className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                  style={{ fontSize: 'clamp(2.1rem, 4vw, 3.35rem)' }}
                >
                  Built Around Trust, Dignity, and Everyday Freedom.
                </h2>
              </ScrollReveal>
              <ScrollReveal delayMs={150}>
                <p className="text-base text-slate-200 leading-relaxed">
                  Personal safety tools should feel empowering—never intrusive. Share journeys only when you choose,
                  check in effortlessly in English or ಕನ್ನಡ, and access vetted women’s shelters and youth support centers
                  without exposing private location trails.
                </p>
              </ScrollReveal>
            </div>

            <div className="lg:col-span-6 grid gap-4 sm:grid-cols-2">
              <ScrollReveal delayMs={120}>
                <div className="h-full rounded-2xl border border-white/15 bg-[#060B1D]/82 p-5 backdrop-blur-xl">
                  <Users className="h-5 w-5 text-[#FB7185]" />
                  <h3 className="mt-3 font-display text-base font-bold text-white">Trusted Circle &amp; Check-Ins</h3>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Share live journeys with automatic check-in timers, safe arrival confirmations, and Gmail/Calendar
                    check-in integrations.
                  </p>
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={200}>
                <div className="h-full rounded-2xl border border-white/15 bg-[#060B1D]/82 p-5 backdrop-blur-xl">
                  <HeartHandshake className="h-5 w-5 text-emerald-400" />
                  <h3 className="mt-3 font-display text-base font-bold text-white">Verified Support Directory</h3>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Discover women’s crisis shelters, campus hubs, and medical desks with explicit source citations and
                    verification timestamps.
                  </p>
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={260}>
                <div className="h-full rounded-2xl border border-white/15 bg-[#060B1D]/82 p-5 backdrop-blur-xl">
                  <Lock className="h-5 w-5 text-sky-400" />
                  <h3 className="mt-3 font-display text-base font-bold text-white">Privacy-Conscious Reporting</h3>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Report hazard zones anonymously or on-record while retaining full data deletion and consent
                    controls inside Profile Settings.
                  </p>
                </div>
              </ScrollReveal>
              <ScrollReveal delayMs={320}>
                <div className="h-full rounded-2xl border border-white/15 bg-[#060B1D]/82 p-5 backdrop-blur-xl">
                  <Clock className="h-5 w-5 text-amber-300" />
                  <h3 className="mt-3 font-display text-base font-bold text-white">Bilingual Accessibility</h3>
                  <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
                    Switch seamlessly between English and Kannada (ಕನ್ನಡ), including voice-guided AI assistance when
                    typing isn’t safe.
                  </p>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 08. HOW IT WORKS                                                    */}
      {/* =================================================================== */}
      <section
        id="section-how-it-works"
        className="relative overflow-hidden border-b border-white/10 bg-[#050917] py-20 lg:py-28"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 space-y-12">
          <div className="max-w-2xl space-y-3">
            <ScrollReveal>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[#FB7185]">
                08 · END-TO-END ORCHESTRATION
              </div>
            </ScrollReveal>
            <ScrollReveal delayMs={80}>
              <h2
                className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
                style={{ fontSize: 'clamp(2rem, 3.8vw, 3.2rem)' }}
              >
                Detect &rarr; Analyze &rarr; Recommend &rarr; Connect &rarr; Follow Up.
              </h2>
            </ScrollReveal>
          </div>

          <ScrollReveal delayMs={140}>
            <div className="relative">
              {/* Connecting Pulse Line on Desktop */}
              <div
                aria-hidden="true"
                className="hidden lg:block absolute left-10 right-10 top-8 h-[2px] bg-white/10"
              >
                <div
                  className="h-full bg-gradient-to-r from-[#0F275C] via-[#E11D48] to-emerald-400 transition-all duration-500"
                  style={{ width: `${((activePipelineIndex + 1) / HOW_IT_WORKS_STEPS.length) * 100}%` }}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-5">
                {HOW_IT_WORKS_STEPS.map((item, idx) => {
                  const active = idx === activePipelineIndex;
                  const passed = idx <= activePipelineIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActivePipelineIndex(idx)}
                      className={`group relative rounded-2xl border p-5 text-left transition-all ${
                        active
                          ? 'border-[#E11D48]/80 bg-[#0B1633] shadow-xl shadow-[#E11D48]/10'
                          : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                      }`}
                    >
                      <div className="relative z-10 flex items-center justify-between">
                        <span
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-full font-mono text-xs font-bold transition-colors ${
                            passed ? 'bg-[#E11D48] text-white' : 'bg-[#0B1633] text-slate-400 border border-white/15'
                          }`}
                        >
                          {item.step}
                        </span>
                        <ArrowRight
                          className={`h-4 w-4 transition-transform ${
                            active ? 'text-[#FB7185] translate-x-0.5' : 'text-slate-600'
                          }`}
                        />
                      </div>
                      <h3 className="mt-4 font-display text-lg font-bold text-white">{item.title}</h3>
                      <div className="mt-0.5 text-[11px] font-medium text-[#FB7185]">{item.subtitle}</div>
                      <p className="mt-2.5 text-xs text-slate-300 leading-relaxed">{item.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 09. OUR MISSION                                                     */}
      {/* =================================================================== */}
      <section
        id="section-mission"
        className="relative flex min-h-[78vh] items-center overflow-hidden border-b border-white/10"
      >
        <ParallaxBackdrop
          src={missionHorizonImg}
          alt="First dawn light over a modern city harbor horizon beneath a deep midnight navy sky"
          baseScale={1.04}
          parallaxRange={30}
          zoomDelta={0.07}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#040712]/80 via-[#071028]/65 to-[#040712]/92"
        />

        <div className="relative z-10 mx-auto max-w-5xl px-4 py-24 text-center sm:px-6 space-y-6">
          <ScrollReveal>
            <div className="text-xs font-semibold uppercase tracking-[0.26em] text-[#FB7185]">
              09 · OUR MISSION
            </div>
          </ScrollReveal>
          <ScrollReveal delayMs={90}>
            <h2
              className="font-display font-extrabold tracking-tight text-white leading-[1.06]"
              style={{ fontSize: 'clamp(2.25rem, 4.8vw, 4rem)' }}
            >
              Building a Future Where Safety Comes First.
            </h2>
          </ScrollReveal>
          <ScrollReveal delayMs={170}>
            <p className="mx-auto max-w-2xl text-base sm:text-lg text-slate-200 leading-relaxed">
              Technology cannot replace human care—but when designed with honesty, strict privacy, and resilient
              engineering, it can eliminate hesitation, guide safer choices, and bring trusted support within reach when
              every second counts.
            </p>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 10. FINAL CALL TO ACTION                                            */}
      {/* =================================================================== */}
      <section
        id="section-cta"
        className="relative overflow-hidden border-b border-white/10 bg-[#040712] py-20 lg:py-28"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(225,29,72,0.16),transparent_60%)]"
        />

        <div className="relative z-10 mx-auto max-w-4xl px-4 text-center sm:px-6 space-y-7">
          <ScrollReveal>
            <div className="flex justify-center">
              <LifeLineLogo variant="mark" size="lg" tone="dark" />
            </div>
          </ScrollReveal>
          <ScrollReveal delayMs={80}>
            <h2
              className="font-display font-extrabold tracking-tight text-white leading-[1.08]"
              style={{ fontSize: 'clamp(2.1rem, 4.5vw, 3.6rem)' }}
            >
              Be Part of a Safer Tomorrow.
            </h2>
          </ScrollReveal>
          <ScrollReveal delayMs={150}>
            <p className="mx-auto max-w-xl text-sm sm:text-base text-slate-300 leading-relaxed">
              Create your personal safety profile, add trusted contacts, explore LIFE-LINE PULSE SafeRoute telemetry, or
              inspect every RBAC role inside the live platform.
            </p>
          </ScrollReveal>
          <ScrollReveal delayMs={220}>
            <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
              <button
                type="button"
                onClick={handleGetStarted}
                className="inline-flex items-center gap-2 rounded-xl bg-[#E11D48] px-7 py-3.5 text-sm font-semibold text-white shadow-xl shadow-[#E11D48]/30 hover:bg-[#BE123C] transition-colors"
              >
                <span>{user ? 'Go to Dashboard' : 'Join LIFE-LINE AI'}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => (user ? onNavigate('dashboard') : onOpenAuth())}
                className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/5 px-7 py-3.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
              >
                <span>Access Platform</span>
              </button>
              <button
                type="button"
                onClick={handleOpenDemoSandbox}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-5 py-3.5 text-sm font-medium text-slate-300 hover:border-white/35 hover:text-white transition-colors"
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span>Try Judge Sandbox</span>
              </button>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* =================================================================== */}
      {/* 11. PREMIUM FOOTER                                                  */}
      {/* =================================================================== */}
      <footer className="bg-[#03050E] text-slate-400">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 md:grid-cols-12">
            {/* Brand & Mission */}
            <div className="md:col-span-5 space-y-4">
              <LifeLineLogo
                variant="full"
                size="sm"
                tone="dark"
                showSubtitle
                subtitle="SAFETY & EMERGENCY INTELLIGENCE"
              />
              <p className="max-w-sm text-xs leading-relaxed text-slate-400">
                LIFE-LINE AI is an agentic youth and women’s safety platform combining verified routing, trusted circle
                journeys, offline-resilient SOS workflows, and human-authorized emergency coordination.
              </p>
              <p className="text-[11px] text-slate-500">
                Important disclosure: LIFE-LINE AI does not dial or replace municipal 911 / 112 / 999 emergency
                dispatch.
              </p>
            </div>

            {/* Platform Navigation */}
            <div className="md:col-span-4 space-y-3">
              <div className="font-display text-xs font-bold uppercase tracking-wider text-white">
                Platform Navigation
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <a href="#section-hero" className="hover:text-white transition-colors">
                  Overview
                </a>
                <button
                  type="button"
                  onClick={() => onNavigate('pulse')}
                  className="text-left hover:text-white transition-colors"
                >
                  LIFE-LINE PULSE
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('map')}
                  className="text-left hover:text-white transition-colors"
                >
                  Live Support Map
                </button>
                <button
                  type="button"
                  onClick={() => handleProtectedNav('dashboard')}
                  className="text-left hover:text-white transition-colors"
                >
                  Safety Dashboard
                </button>
                <button
                  type="button"
                  onClick={() => handleProtectedNav('agents')}
                  className="text-left hover:text-white transition-colors"
                >
                  6 AI Agents Hub
                </button>
                <button
                  type="button"
                  onClick={() => handleProtectedNav('operator')}
                  className="text-left hover:text-white transition-colors"
                >
                  Command Center
                </button>
              </div>
            </div>

            {/* Contact & Privacy */}
            <div className="md:col-span-3 space-y-3 text-xs">
              <div className="font-display text-xs font-bold uppercase tracking-wider text-white">
                Contact &amp; Trust
              </div>
              <div className="space-y-2">
                {developerContactEmail ? (
                  <a
                    href={`mailto:${developerContactEmail}`}
                    className="inline-flex items-center gap-1.5 hover:text-white transition-colors"
                  >
                    <Mail className="h-3.5 w-3.5 text-[#FB7185]" />
                    <span>{developerContactEmail}</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={onOpenAuth}
                    className="inline-flex items-center gap-1.5 text-left hover:text-white transition-colors"
                  >
                    <Mail className="h-3.5 w-3.5 text-[#FB7185]" />
                    <span>Access Support &amp; Auth Desk</span>
                  </button>
                )}
                <div>
                  <button
                    type="button"
                    onClick={() => setPrivacyNoticeOpen((v) => !v)}
                    className="hover:text-white transition-colors"
                  >
                    Privacy &amp; Data Sovereignty Policy
                  </button>
                </div>
                <div>
                  <a
                    href="https://cloud.google.com/maps-platform/terms?utm_campaign=gmp_mcp_codeassist_v1_aistudio"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white transition-colors"
                  >
                    Google Maps Platform Terms
                  </a>
                </div>
              </div>
            </div>
          </div>

          {privacyNoticeOpen && (
            <div className="mt-6 rounded-2xl border border-white/10 bg-[#070E24] p-4 text-xs text-slate-300 leading-relaxed">
              <strong className="text-white">Privacy &amp; Data Sovereignty:</strong> Location telemetry is captured on
              explicit user action, SafeRoute calculation, or SOS trigger. Offline SOS queues are isolated per
              authenticated user and automatically purged on sign-out. Full profile export &amp; deletion controls are
              available under Profile Settings.
            </div>
          )}

          <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-6 text-[11px] text-slate-500">
            <span>&copy; {new Date().getFullYear()} LIFE-LINE AI · Youth &amp; Women Public Safety Platform.</span>
            <span>Truthful telemetry · Human-in-the-loop AI governance</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
