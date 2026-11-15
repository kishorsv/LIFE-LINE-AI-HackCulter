import { GoogleGenAI, ThinkingLevel, Type, FunctionDeclaration } from '@google/genai';

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('400') || msg.includes('403') || msg.includes('404')) break;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// 1. Emergency Assessment Agent (gemini-4-hydrogen + ThinkingLevel.HIGH + structured schema)
export async function runEmergencyAssessmentAgent(input: {
  description: string;
  locationLabel?: string;
  timeOfDay?: string;
  imageBase64?: string;
  imageMimeType?: string;
}) {
  const ai = getAiClient();
  if (!ai) {
    return {
      modelUsed: 'fallback-deterministic-triage',
      aiAvailable: false,
      urgencyLevel: 'HIGH',
      classification: 'Unverified Safety Request (AI Offline Fallback)',
      recommendedPriority: 'HIGH',
      confidenceScore: 0.45,
      rationale:
        'Automated AI assessment is currently unavailable. Defaulting to HIGH priority so human operators and trusted contacts can review immediately.',
      missingInfoQuestions: ['Are you in a safe, well-lit location right now?', 'Do you need medical assistance or trusted contact check-in?'],
      uncertaintyNotes: 'AI service key not active; manual operator review required.',
      escalateToHumanOperator: true,
      immediateSteps: [
        'If you are in immediate physical danger, call local emergency services (911 / 112 / 999) directly.',
        'Move toward a populated, well-lit public venue or open business.',
        'Trigger SOS to alert your configured trusted contacts and platform operators.',
      ],
    };
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

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
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
    })
  );

  const parsed = JSON.parse((response.text ?? '{}').trim());
  return {
    modelUsed: 'gemini-4-hydrogen',
    aiAvailable: true,
    ...parsed,
  };
}

// 2. Safety Intelligence Agent (gemini-4-hydrogen + optional googleSearch grounding)
export async function runSafetyIntelligenceAgent(input: {
  concern: string;
  areaLabel?: string;
  timeContext?: string;
  useSearchGrounding?: boolean;
}) {
  const ai = getAiClient();
  if (!ai) {
    return {
      modelUsed: 'fallback-safety-guidance',
      aiAvailable: false,
      summary: 'Follow standard personal safety precautions: stay in well-lit public areas, share live location only with trusted contacts, and contact emergency services if threatened.',
      recommendations: [
        { title: 'Stay in populated areas', detail: 'Choose main roads and open storefronts over isolated shortcuts.', confidence: 0.9 },
        { title: 'Enable trusted check-in', detail: 'Share your expected arrival time with a trusted contact.', confidence: 0.9 },
      ],
      uncertaintyDisclosure: 'Live environmental intelligence is offline; guidance reflects general safety best practices.',
      groundingSources: [],
    };
  }

  if (input.useSearchGrounding && input.areaLabel) {
    const searchResp = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Check if there are any current public transit advisories, weather alerts, or official safety notices in ${input.areaLabel} relevant to this concern: ${input.concern}. Provide practical, grounded safety recommendations and explicitly state what cannot be verified.`,
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction:
            'You are the LIFE-LINE AI Safety Intelligence Agent. Give grounded, non-alarmist practical safety recommendations. Never invent crime statistics or predict danger without verified evidence. Explicitly state uncertainty.',
        },
      })
    );
    const chunks = searchResp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingSources = chunks
      .map((c) => (c.web ? { title: c.web.title || 'Web Source', uri: c.web.uri || '' } : null))
      .filter((x): x is { title: string; uri: string } => Boolean(x?.uri));

    return {
      modelUsed: 'gemini-4-hydrogen (Google Search Grounded)',
      aiAvailable: true,
      summary: searchResp.text || 'Grounded safety summary generated.',
      recommendations: [
        {
          title: 'Verified Area Guidance',
          detail: searchResp.text || 'Review local advisories and stick to well-lit corridors.',
          confidence: groundingSources.length > 0 ? 0.82 : 0.65,
        },
      ],
      uncertaintyDisclosure:
        'Street-level conditions change rapidly. This assessment reflects publicly indexed advisories and user context only.',
      groundingSources,
    };
  }

  const resp = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
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
    })
  );

  const parsed = JSON.parse((resp.text ?? '{}').trim());
  return {
    modelUsed: 'gemini-4-hydrogen',
    aiAvailable: true,
    ...parsed,
    groundingSources: [],
  };
}

// 3. Resource Discovery Agent (gemini-4-hydrogen + googleMaps grounding)
export async function runResourceDiscoveryAgent(input: {
  query: string;
  latitude?: number;
  longitude?: number;
}) {
  const ai = getAiClient();
  if (!ai) {
    return {
      modelUsed: 'directory-only-fallback',
      aiAvailable: false,
      summary: 'AI discovery offline. Showing verified local registry records.',
      mapsLinks: [],
    };
  }

  const hasCoords = typeof input.latitude === 'number' && typeof input.longitude === 'number';
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
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
    })
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
    modelUsed: 'gemini-4-hydrogen (Google Maps Grounded)',
    aiAvailable: true,
    summary: response.text || 'Review the grounded Google Maps resources below.',
    mapsLinks,
  };
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

export async function runEmergencyCoordinationAgent(input: {
  incidentTitle: string;
  incidentDescription: string;
  incidentStatus: string;
  locationLabel: string;
  trustedContactsCount: number;
}) {
  const ai = getAiClient();
  if (!ai) {
    return {
      modelUsed: 'fallback-coordinator',
      aiAvailable: false,
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
      coordinationSummary: 'Prepared draft alert and operator briefing awaiting human confirmation.',
    };
  }

  const resp = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
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
    })
  );

  const functionCalls = resp.functionCalls ?? [];
  return {
    modelUsed: 'gemini-4-hydrogen (Tool-Orchestrated)',
    aiAvailable: true,
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
}

// 5. AI Support Assistant (multi-turn chat + gemini-3.1-flash-lite quick check)
export async function runSupportAssistantChat(input: {
  history: Array<{ role: 'user' | 'model'; text: string }>;
  message: string;
  fastMode?: boolean;
}) {
  const ai = getAiClient();
  if (!ai) {
    return {
      modelUsed: 'offline-safety-guide',
      reply:
        'The AI Assistant is currently offline. If you are in danger, press the Emergency SOS button on your dashboard or dial your local emergency number (911 / 112 / 999).',
    };
  }

  const model = input.fastMode ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
  const systemInstruction = `You are the LIFE-LINE AI Support Assistant — a calm, supportive safety guide for women and young people.
- Answer safety questions clearly and empathetically.
- Guide users through LIFE-LINE AI features (SOS activation, Trusted Contacts, Live Google Maps routing, Nearby Support Directory, Operator Desk).
- NEVER claim to be a doctor, police officer, or emergency dispatcher, and never replace emergency professionals.
- Keep answers concise, scannable, and practical.`;

  if (input.fastMode) {
    const resp = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: input.message,
        config: { systemInstruction },
      })
    );
    return { modelUsed: 'gemini-3.1-flash-lite', reply: resp.text || '' };
  }

  const chat = ai.chats.create({
    model,
    history: input.history.map((h) => ({
      role: h.role,
      parts: [{ text: h.text }],
    })),
    config: { systemInstruction },
  });

  const resp = await withRetry(() => chat.sendMessage({ message: input.message }));
  return { modelUsed: model, reply: resp.text || '' };
}

// Audio Transcription (gemini-3.5-transcribe)
export async function transcribeAudioNote(base64Audio: string, mimeType: string) {
  const ai = getAiClient();
  if (!ai) {
    throw new Error('AI transcription service is not configured.');
  }
  const resp = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          { text: 'Transcribe this audio recording accurately for an emergency safety report.' },
        ],
      },
    })
  );
  return {
    modelUsed: 'gemini-3.5-transcribe',
    transcript: resp.text || '',
  };
}

// Calm Voice Guidance TTS (gemini-3.8-flash-lite-tts)
export async function synthesizeSafetyGuidanceSpeech(text: string, voiceName = 'Kore') {
  const ai = getAiClient();
  if (!ai) {
    throw new Error('AI speech service is not configured.');
  }
  const resp = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
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
    })
  );

  const base64Audio = resp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Speech synthesis returned no audio data.');
  }
  return {
    modelUsed: 'gemini-3.8-flash-lite-tts',
    mimeType: 'audio/wav',
    audioBase64: base64Audio,
  };
}
