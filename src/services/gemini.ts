import { FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export const GEMINI_MODELS = {
  reasoning: 'gemini-4-hydrogen',
  fast: 'gemini-3.1-flash-lite',
  transcribe: 'gemini-3.5-transcribe',
  tts: 'gemini-3.8-flash-lite-tts',
  live: 'gemini-3.8-live',
} as const;

export const AI_ADVISORY_NOTICE =
  'AI-generated advisory guidance only — verify facts independently and dial local emergency services (911 / 112 / 999) if in immediate danger.';

export type AiFallbackReason =
  | 'not_configured'
  | 'quota_exceeded'
  | 'timeout'
  | 'malformed_response'
  | 'unavailable';

export class GeminiServiceError extends Error {
  statusCode: number;
  reason: AiFallbackReason;

  constructor(message: string, statusCode: number, reason: AiFallbackReason) {
    super(message);
    this.name = 'GeminiServiceError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export function isGeminiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = (env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

function getAiClient(clientOverride?: GoogleGenAI | null): GoogleGenAI | null {
  if (clientOverride !== undefined) return clientOverride;
  if (!isGeminiConfigured()) return null;
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY!,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function classifyGeminiError(err: unknown): {
  reason: AiFallbackReason;
  statusCode: number;
  retryable: boolean;
  publicMessage: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return {
      reason: 'timeout',
      statusCode: 504,
      retryable: true,
      publicMessage: 'AI service timed out. Showing safe deterministic fallback guidance.',
    };
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
    return {
      reason: 'quota_exceeded',
      statusCode: 429,
      retryable: false,
      publicMessage: 'AI quota or rate limit temporarily reached. Showing safe deterministic fallback guidance.',
    };
  }
  if (lower.includes('json') || lower.includes('malformed') || lower.includes('unexpected token')) {
    return {
      reason: 'malformed_response',
      statusCode: 502,
      retryable: true,
      publicMessage: 'AI returned a malformed response. Showing safe deterministic fallback guidance.',
    };
  }
  return {
    reason: 'unavailable',
    statusCode: 503,
    retryable: !(lower.includes('400') || lower.includes('401') || lower.includes('403') || lower.includes('404')),
    publicMessage: 'AI service is temporarily unavailable. Showing safe deterministic fallback guidance.',
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetryAndTimeout<T>(fn: () => Promise<T>, timeoutMs = 20000, maxAttempts = 2, label = 'Gemini API'): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await withTimeout(fn(), timeoutMs, label);
    } catch (err) {
      lastErr = err;
      const classified = classifyGeminiError(err);
      if (!classified.retryable || i + 1 >= maxAttempts) break;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

export function safeParseJsonObject(rawText: string | undefined | null): Record<string, unknown> | null {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const VALID_LEVELS = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

export function parseAssessmentPayload(rawText: string | undefined | null) {
  const obj = safeParseJsonObject(rawText);
  if (!obj) return null;

  const urgency = VALID_LEVELS.has(String(obj.urgencyLevel || '').toUpperCase())
    ? String(obj.urgencyLevel).toUpperCase()
    : 'HIGH';
  const priority = VALID_LEVELS.has(String(obj.recommendedPriority || '').toUpperCase())
    ? String(obj.recommendedPriority).toUpperCase()
    : urgency;
  const rationale = typeof obj.rationale === 'string' && obj.rationale.trim() ? obj.rationale.trim() : null;
  if (!rationale) return null;

  const confRaw = Number(obj.confidenceScore);
  const confidenceScore = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0.65;

  const missingInfoQuestions = Array.isArray(obj.missingInfoQuestions)
    ? obj.missingInfoQuestions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 4)
    : [];

  const immediateSteps = Array.isArray(obj.immediateSteps)
    ? obj.immediateSteps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 6)
    : [];

  if (immediateSteps.length === 0) {
    immediateSteps.push('Dial local emergency services (911 / 112 / 999) if you face immediate physical danger.');
  }

  return {
    urgencyLevel: urgency,
    classification:
      typeof obj.classification === 'string' && obj.classification.trim()
        ? obj.classification.trim()
        : 'Personal Safety Assessment',
    recommendedPriority: priority,
    confidenceScore,
    rationale,
    missingInfoQuestions,
    uncertaintyNotes:
      typeof obj.uncertaintyNotes === 'string' && obj.uncertaintyNotes.trim()
        ? obj.uncertaintyNotes.trim()
        : 'AI assessment relies solely on user-provided description and cannot verify live field conditions.',
    escalateToHumanOperator: Boolean(obj.escalateToHumanOperator ?? true),
    immediateSteps,
  };
}

function buildAssessmentFallback(reason: AiFallbackReason, notice: string) {
  return {
    modelUsed: 'fallback-deterministic-triage',
    aiAvailable: false,
    isAiAdvisory: true,
    verificationStatus: 'Deterministic Safety Fallback (Unverified)',
    advisoryNotice: AI_ADVISORY_NOTICE,
    fallbackReason: reason,
    urgencyLevel: 'HIGH',
    classification: 'Safety Request (Deterministic Fallback)',
    recommendedPriority: 'HIGH',
    confidenceScore: 0.45,
    rationale: notice,
    missingInfoQuestions: [
      'Are you in a safe, well-lit location right now?',
      'Do you need medical assistance or a trusted contact check-in?',
    ],
    uncertaintyNotes: `${notice} Human operator review is recommended.`,
    escalateToHumanOperator: true,
    immediateSteps: [
      'If you are in immediate physical danger, call local emergency services (911 / 112 / 999) directly.',
      'Move toward a populated, well-lit public venue or open business.',
      'Trigger SOS to alert your configured trusted contacts and platform operators.',
    ],
  };
}

// 1. Emergency Assessment Agent (gemini-4-hydrogen + ThinkingLevel.HIGH + structured schema)
export async function runEmergencyAssessmentAgent(
  input: {
    description: string;
    locationLabel?: string;
    timeOfDay?: string;
    imageBase64?: string;
    imageMimeType?: string;
  },
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    return buildAssessmentFallback(
      'not_configured',
      'Automated AI assessment is currently unavailable. Defaulting to HIGH priority so human operators can review immediately.'
    );
  }

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (input.imageBase64 && input.imageMimeType) {
    parts.push({
      inlineData: {
        mimeType: input.imageMimeType,
        data: input.imageBase64,
      },
    });
  }
  parts.push({
    text: `Assess this safety/emergency report carefully.
Description: ${input.description}
Location context: ${input.locationLabel || 'Not specified'}
Local timestamp: ${input.timeOfDay || new Date().toISOString()}`,
  });

  try {
    const response = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.reasoning,
          contents: { parts },
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
            systemInstruction: `You are the LIFE-LINE AI Emergency Assessment Agent supporting women and youth safety.
Analyze the incoming report strictly and empathetically.
Rules:
- Never claim police, ambulance, or emergency services have been dispatched.
- Always advise calling local official emergency numbers (911/112/999) if immediate physical danger exists.
- Clearly explain WHY you assigned the priority.
- Identify missing information safely without overwhelming someone in distress.
- Flag uncertainty honestly; never invent facts.`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                urgencyLevel: { type: Type.STRING, description: 'CRITICAL, HIGH, MEDIUM, or LOW' },
                classification: { type: Type.STRING, description: 'Concise incident category' },
                recommendedPriority: { type: Type.STRING, description: 'CRITICAL, HIGH, MEDIUM, or LOW' },
                confidenceScore: { type: Type.NUMBER, description: 'Confidence between 0.0 and 1.0' },
                rationale: { type: Type.STRING, description: 'Clear explanation of why this priority was assigned' },
                missingInfoQuestions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Up to 3 short clarifying questions if safe to ask',
                },
                uncertaintyNotes: { type: Type.STRING, description: 'Explicitly notes missing facts or ambiguity' },
                escalateToHumanOperator: { type: Type.BOOLEAN },
                immediateSteps: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '3 to 4 practical, actionable safety steps',
                },
              },
              required: [
                'urgencyLevel',
                'classification',
                'recommendedPriority',
                'confidenceScore',
                'rationale',
                'missingInfoQuestions',
                'uncertaintyNotes',
                'escalateToHumanOperator',
                'immediateSteps',
              ],
            },
          },
        }),
      options?.timeoutMs ?? 20000,
      2,
      'Emergency Assessment Agent'
    );

    const parsed = parseAssessmentPayload(response.text);
    if (!parsed) {
      return buildAssessmentFallback(
        'malformed_response',
        'AI response could not be parsed cleanly. Defaulting to HIGH priority for human operator triage.'
      );
    }

    return {
      modelUsed: GEMINI_MODELS.reasoning,
      aiAvailable: true,
      isAiAdvisory: true,
      verificationStatus: 'AI Advisory Guidance (Human Review Recommended)',
      advisoryNotice: AI_ADVISORY_NOTICE,
      ...parsed,
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return buildAssessmentFallback(classified.reason, classified.publicMessage);
  }
}

function buildSafetyFallback(reason: AiFallbackReason, notice: string) {
  return {
    modelUsed: 'fallback-safety-guidance',
    aiAvailable: false,
    isAiAdvisory: true,
    verificationStatus: 'Deterministic Safety Fallback',
    advisoryNotice: AI_ADVISORY_NOTICE,
    fallbackReason: reason,
    summary:
      'Follow standard personal safety precautions: stay in well-lit public areas, share live location only with trusted contacts, and contact emergency services if threatened.',
    recommendations: [
      { title: 'Stay in populated areas', detail: 'Choose main roads and open storefronts over isolated shortcuts.', confidence: 0.9 },
      { title: 'Enable trusted check-in', detail: 'Share your expected arrival time with a trusted contact.', confidence: 0.9 },
    ],
    uncertaintyDisclosure: notice,
    groundingSources: [] as Array<{ title: string; uri: string }>,
  };
}

// 2. Safety Intelligence Agent (gemini-4-hydrogen + optional googleSearch grounding)
export async function runSafetyIntelligenceAgent(
  input: {
    concern: string;
    areaLabel?: string;
    timeContext?: string;
    useSearchGrounding?: boolean;
  },
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    return buildSafetyFallback(
      'not_configured',
      'Live environmental intelligence is offline; guidance reflects general safety best practices.'
    );
  }

  try {
    if (input.useSearchGrounding && input.areaLabel) {
      const searchResp = await withRetryAndTimeout(
        () =>
          ai.models.generateContent({
            model: GEMINI_MODELS.reasoning,
            contents: `Check if there are any current public transit advisories, weather alerts, or official safety notices in ${input.areaLabel} relevant to this concern: ${input.concern}. Provide practical, grounded safety recommendations and explicitly state what cannot be verified.`,
            config: {
              tools: [{ googleSearch: {} }],
              systemInstruction:
                'You are the LIFE-LINE AI Safety Intelligence Agent. Give grounded, non-alarmist practical safety recommendations. Never invent crime statistics or predict danger without verified evidence. Explicitly state uncertainty.',
            },
          }),
        options?.timeoutMs ?? 20000,
        2,
        'Safety Intelligence Search'
      );
      const chunks = searchResp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const groundingSources = chunks
        .map((c) => (c.web ? { title: c.web.title || 'Web Source', uri: c.web.uri || '' } : null))
        .filter((x): x is { title: string; uri: string } => Boolean(x?.uri));

      return {
        modelUsed: `${GEMINI_MODELS.reasoning} (Google Search Grounded)`,
        aiAvailable: true,
        isAiAdvisory: true,
        verificationStatus: 'AI Advisory + Grounded Web Sources (Verify Separately)',
        advisoryNotice: AI_ADVISORY_NOTICE,
        summary: searchResp.text || 'Grounded safety summary generated.',
        recommendations: [
          {
            title: 'Grounded Area Guidance',
            detail: searchResp.text || 'Review local advisories and stick to well-lit corridors.',
            confidence: groundingSources.length > 0 ? 0.82 : 0.65,
          },
        ],
        uncertaintyDisclosure:
          'Street-level conditions change rapidly. This AI summary reflects publicly indexed advisories and user context only.',
        groundingSources,
      };
    }

    const resp = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.reasoning,
          contents: `Analyze this personal safety concern and produce practical, evidence-aware guidance:
Concern: ${input.concern}
Area / Environment: ${input.areaLabel || 'Unknown'}
Time Context: ${input.timeContext || 'Current'}`,
          config: {
            systemInstruction:
              'You are the LIFE-LINE AI Safety Intelligence Agent. Provide calm, practical safety steps for women and youth. Explicitly distinguish verified environmental facts from uncertainties. Never predict crime or guarantee safety.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                recommendations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      detail: { type: Type.STRING },
                      confidence: { type: Type.NUMBER },
                    },
                    required: ['title', 'detail', 'confidence'],
                  },
                },
                uncertaintyDisclosure: { type: Type.STRING },
              },
              required: ['summary', 'recommendations', 'uncertaintyDisclosure'],
            },
          },
        }),
      options?.timeoutMs ?? 20000,
      2,
      'Safety Intelligence Agent'
    );

    const parsed = safeParseJsonObject(resp.text);
    if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.recommendations)) {
      return buildSafetyFallback(
        'malformed_response',
        'AI intelligence output could not be parsed cleanly; showing general safety guidance.'
      );
    }

    const recommendations = parsed.recommendations
      .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : 'Safety Step',
        detail: typeof r.detail === 'string' ? r.detail : '',
        confidence: Number.isFinite(Number(r.confidence)) ? Math.min(1, Math.max(0, Number(r.confidence))) : 0.7,
      }))
      .filter((r) => r.detail.length > 0);

    return {
      modelUsed: GEMINI_MODELS.reasoning,
      aiAvailable: true,
      isAiAdvisory: true,
      verificationStatus: 'AI Advisory Guidance (Unverified)',
      advisoryNotice: AI_ADVISORY_NOTICE,
      summary: parsed.summary,
      recommendations: recommendations.length > 0 ? recommendations : buildSafetyFallback('malformed_response', '').recommendations,
      uncertaintyDisclosure:
        typeof parsed.uncertaintyDisclosure === 'string' && parsed.uncertaintyDisclosure.trim()
          ? parsed.uncertaintyDisclosure
          : 'AI guidance cannot verify real-time street conditions.',
      groundingSources: [] as Array<{ title: string; uri: string }>,
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return buildSafetyFallback(classified.reason, classified.publicMessage);
  }
}

// 3. Resource Discovery Agent (gemini-4-hydrogen + googleMaps grounding)
export async function runResourceDiscoveryAgent(
  input: {
    query: string;
    latitude?: number;
    longitude?: number;
  },
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    return {
      modelUsed: 'directory-only-fallback',
      aiAvailable: false,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      fallbackReason: 'not_configured' as AiFallbackReason,
      summary: 'AI discovery offline. Showing verified local registry records on the Live Map.',
      mapsLinks: [] as Array<{ title: string; uri: string }>,
    };
  }

  const hasCoords =
    typeof input.latitude === 'number' &&
    Number.isFinite(input.latitude) &&
    typeof input.longitude === 'number' &&
    Number.isFinite(input.longitude);

  try {
    const response = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.reasoning,
          contents: `Find verified nearby support resources (hospitals, urgent clinics, crisis support centers, youth/women shelters, or police/public transit hubs) for: "${input.query}". State clearly what hours or details could be verified and remind the user to call ahead to confirm live capacity.`,
          config: {
            tools: [{ googleMaps: {} }],
            ...(hasCoords
              ? {
                  toolConfig: {
                    retrievalConfig: {
                      latLng: {
                        latitude: input.latitude!,
                        longitude: input.longitude!,
                      },
                    },
                  },
                }
              : {}),
            systemInstruction:
              'You are the LIFE-LINE AI Resource Discovery Agent. Only cite places returned by Google Maps grounding. Never fabricate phone numbers, addresses, or 24/7 availability.',
          },
        }),
      options?.timeoutMs ?? 20000,
      2,
      'Resource Discovery Agent'
    );

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const mapsLinks = chunks
      .map((c) => {
        const m = c.maps;
        if (!m?.uri) return null;
        return {
          title: m.title || 'Google Maps Place',
          uri: m.uri,
        };
      })
      .filter((x): x is { title: string; uri: string } => Boolean(x));

    return {
      modelUsed: `${GEMINI_MODELS.reasoning} (Google Maps Grounded)`,
      aiAvailable: true,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      summary: response.text || 'Review the grounded Google Maps resources below.',
      mapsLinks,
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return {
      modelUsed: 'directory-only-fallback',
      aiAvailable: false,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      fallbackReason: classified.reason,
      summary: `${classified.publicMessage} Use the Live Map Support Directory to inspect verified coordinates and phone numbers.`,
      mapsLinks: [] as Array<{ title: string; uri: string }>,
    };
  }
}

// 4. Emergency Coordination Agent (gemini-4-hydrogen with FunctionDeclarations & HITL gate)
const prepareTrustedContactAlertDecl: FunctionDeclaration = {
  name: 'prepareTrustedContactAlert',
  description: 'Organizes a structured emergency alert draft for trusted contacts without sending it until authorized.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      urgency: { type: Type.STRING },
      shortMessage: { type: Type.STRING },
      recommendedChannel: { type: Type.STRING },
    },
    required: ['urgency', 'shortMessage', 'recommendedChannel'],
  },
};

const prepareOperatorBriefingDecl: FunctionDeclaration = {
  name: 'prepareOperatorBriefing',
  description: 'Prepares a concise incident coordination briefing for human emergency operators.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      priority: { type: Type.STRING },
      recommendedWorkflow: { type: Type.STRING },
      keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['priority', 'recommendedWorkflow', 'keyFacts'],
  },
};

export async function runEmergencyCoordinationAgent(
  input: {
    incidentTitle: string;
    incidentDescription: string;
    incidentStatus: string;
    locationLabel: string;
    trustedContactsCount: number;
  },
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const buildFallbackCoord = (reason: AiFallbackReason, summary: string) => ({
    modelUsed: 'fallback-coordinator',
    aiAvailable: false,
    isAiAdvisory: true,
    advisoryNotice: AI_ADVISORY_NOTICE,
    fallbackReason: reason,
    recommendedWorkflow: 'Notify trusted contacts and escalate to operator desk for manual acknowledgment.',
    preparedActions: [
      {
        tool: 'prepareTrustedContactAlert',
        args: {
          urgency: 'HIGH',
          shortMessage: `SOS Alert: ${input.incidentTitle} near ${input.locationLabel}. Please check in immediately.`,
          recommendedChannel: 'in_app + email',
        },
        requiresAuthorization: true,
      },
    ],
    coordinationSummary: summary,
  });

  const ai = getAiClient(options?.client);
  if (!ai) {
    return buildFallbackCoord(
      'not_configured',
      'Prepared draft alert and operator briefing awaiting human confirmation.'
    );
  }

  try {
    const resp = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.reasoning,
          contents: `Organize the coordination plan for this incident:
Title: ${input.incidentTitle}
Description: ${input.incidentDescription}
Current Status: ${input.incidentStatus}
Location: ${input.locationLabel}
Configured Trusted Contacts: ${input.trustedContactsCount}

Call both tools to prepare the trusted contact alert draft and the operator briefing.`,
          config: {
            tools: [{ functionDeclarations: [prepareTrustedContactAlertDecl, prepareOperatorBriefingDecl] }],
            systemInstruction:
              'You are the LIFE-LINE AI Emergency Coordination Agent. Use your tools to prepare structured drafts for trusted contacts and human operators. Never execute external dispatch autonomously — require human authorization.',
          },
        }),
      options?.timeoutMs ?? 20000,
      2,
      'Emergency Coordination Agent'
    );

    const functionCalls = resp.functionCalls ?? [];
    return {
      modelUsed: `${GEMINI_MODELS.reasoning} (Tool-Orchestrated)`,
      aiAvailable: true,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      recommendedWorkflow:
        input.incidentStatus === 'SOS Activated' || input.incidentStatus === 'Alert Sent'
          ? '1. Authorize Trusted Contact Dispatch · 2. Operator Acknowledgment · 3. Live Location Escort / Resource Routing'
          : 'Continue active operator monitoring until user confirms safe resolution.',
      preparedActions: functionCalls.map((fc) => ({
        tool: fc.name,
        args: fc.args,
        requiresAuthorization: true,
      })),
      coordinationSummary:
        resp.text ||
        'Structured coordination drafts prepared. Human authorization is required before transmitting external messages.',
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return buildFallbackCoord(classified.reason, classified.publicMessage);
  }
}

// 5. AI Support Assistant (multi-turn chat + gemini-3.1-flash-lite quick check)
export async function runSupportAssistantChat(
  input: {
    history: Array<{ role: 'user' | 'model'; text: string }>;
    message: string;
    fastMode?: boolean;
  },
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    return {
      modelUsed: 'offline-safety-guide',
      aiAvailable: false,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      fallbackReason: 'not_configured' as AiFallbackReason,
      reply:
        'The AI Assistant is currently offline. If you are in danger, press the Emergency SOS button on your dashboard or dial your local emergency number (911 / 112 / 999).',
    };
  }

  const model = input.fastMode ? GEMINI_MODELS.fast : GEMINI_MODELS.reasoning;
  const systemInstruction = `You are the LIFE-LINE AI Support Assistant — a calm, supportive safety guide for women and young people.
- Answer safety questions clearly and empathetically.
- Guide users through LIFE-LINE AI features (SOS activation, Trusted Contacts, Live Google Maps routing, Nearby Support Directory, Operator Desk).
- NEVER claim to be a doctor, police officer, or emergency dispatcher, and never replace emergency professionals.
- Keep answers concise, scannable, and practical.`;

  try {
    if (input.fastMode) {
      const resp = await withRetryAndTimeout(
        () =>
          ai.models.generateContent({
            model: GEMINI_MODELS.fast,
            contents: input.message,
            config: { systemInstruction },
          }),
        options?.timeoutMs ?? 15000,
        2,
        'AI Support Assistant (Fast)'
      );
      return {
        modelUsed: GEMINI_MODELS.fast,
        aiAvailable: true,
        isAiAdvisory: true,
        advisoryNotice: AI_ADVISORY_NOTICE,
        reply: resp.text || '',
      };
    }

    const chat = ai.chats.create({
      model,
      history: input.history.slice(-20).map((h) => ({
        role: h.role,
        parts: [{ text: h.text }],
      })),
      config: { systemInstruction },
    });

    const resp = await withRetryAndTimeout(
      () => chat.sendMessage({ message: input.message }),
      options?.timeoutMs ?? 20000,
      2,
      'AI Support Assistant'
    );
    return {
      modelUsed: model,
      aiAvailable: true,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      reply: resp.text || '',
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return {
      modelUsed: 'offline-safety-guide',
      aiAvailable: false,
      isAiAdvisory: true,
      advisoryNotice: AI_ADVISORY_NOTICE,
      fallbackReason: classified.reason,
      reply: `${classified.publicMessage} If you are in immediate danger, trigger Emergency SOS or dial local emergency services (911 / 112 / 999).`,
    };
  }
}

// Audio Transcription (gemini-3.5-transcribe)
export async function transcribeAudioNote(
  base64Audio: string,
  mimeType: string,
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    throw new GeminiServiceError('AI transcription service is not configured.', 503, 'not_configured');
  }
  try {
    const resp = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.transcribe,
          contents: {
            parts: [
              { inlineData: { mimeType, data: base64Audio } },
              { text: 'Transcribe this audio recording accurately for an emergency safety report.' },
            ],
          },
        }),
      options?.timeoutMs ?? 15000,
      2,
      'Audio Transcription'
    );
    return {
      modelUsed: GEMINI_MODELS.transcribe,
      transcript: resp.text || '',
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    throw new GeminiServiceError(classified.publicMessage, classified.statusCode, classified.reason);
  }
}

// Calm Voice Guidance TTS (gemini-3.8-flash-lite-tts)
export async function synthesizeSafetyGuidanceSpeech(
  text: string,
  voiceName = 'Kore',
  options?: { client?: GoogleGenAI | null; timeoutMs?: number }
) {
  const ai = getAiClient(options?.client);
  if (!ai) {
    throw new GeminiServiceError('AI speech service is not configured.', 503, 'not_configured');
  }
  try {
    const resp = await withRetryAndTimeout(
      () =>
        ai.models.generateContent({
          model: GEMINI_MODELS.tts,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text,
                  speechMetadata: {
                    style: 'Calm, reassuring, steady, and clear safety coordinator',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
      options?.timeoutMs ?? 15000,
      2,
      'Calm Voice TTS'
    );

    const base64Audio = resp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new GeminiServiceError('Speech synthesis returned no audio data.', 502, 'malformed_response');
    }
    return {
      modelUsed: GEMINI_MODELS.tts,
      mimeType: 'audio/wav',
      audioBase64: base64Audio,
    };
  } catch (err) {
    if (err instanceof GeminiServiceError) throw err;
    const classified = classifyGeminiError(err);
    throw new GeminiServiceError(classified.publicMessage, classified.statusCode, classified.reason);
  }
}
