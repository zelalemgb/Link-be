import axios from 'axios';
import { z } from 'zod';

const linkAgentSurfaceSchema = z.enum(['onboarding', 'clinician', 'patient', 'hew']);
const linkAgentIntentSchema = z.enum([
  'onboarding_help',
  'clinical_assistant',
  'diagnostic_recommendations',
  'diagnosis_recommendations',
  'treatment_recommendations',
  'symptom_assessment',
  'hew_guidance',
]);

const conversationTurnSchema = z.object({
  role: z.enum(['user', 'agent']),
  message: z.string().trim().min(1).max(4000),
});

export const linkAgentInteractionRequestSchema = z.object({
  surface: linkAgentSurfaceSchema,
  intent: linkAgentIntentSchema,
  locale: z.string().trim().min(2).max(16).optional(),
  payload: z.unknown().optional(),
  conversation: z.array(conversationTurnSchema).max(20).optional().default([]),
  safeMode: z.boolean().optional().default(true),
});

export type LinkAgentSurface = z.infer<typeof linkAgentSurfaceSchema>;
export type LinkAgentIntent = z.infer<typeof linkAgentIntentSchema>;
export type LinkAgentInteractionRequest = z.infer<typeof linkAgentInteractionRequestSchema>;

export const LINK_AGENT_CLINICIAN_INTENTS: LinkAgentIntent[] = [
  'clinical_assistant',
  'diagnostic_recommendations',
  'diagnosis_recommendations',
  'treatment_recommendations',
];

type LinkAgentFallbackReason =
  | 'ai_service_unavailable'
  | 'ai_service_error'
  | 'unsupported_intent'
  | 'invalid_response';

type LinkAgentStatus = 'generated' | 'fallback';

type LinkAgentSource = 'local_ai' | 'rules';

export type LinkAgentInteractionResponse = {
  success: true;
  agent: {
    model: 'link_agent_v1';
    surface: LinkAgentSurface;
    intent: LinkAgentIntent;
    status: LinkAgentStatus;
    safeMode: true;
    source: LinkAgentSource;
    fallbackReason?: LinkAgentFallbackReason;
  };
  message: string;
  content: any;
};

type LinkAgentRuntimeConfig = {
  localAiBaseUrl: string;
  localAiTimeoutMs: number;
  localAiSharedSecret: string;
};

const LEGACY_ENDPOINT_BY_INTENT: Partial<Record<LinkAgentIntent, string>> = {
  clinical_assistant: '/clinical-assistant',
  diagnostic_recommendations: '/diagnostic-recommendations',
  diagnosis_recommendations: '/diagnosis-recommendations',
  treatment_recommendations: '/treatment-recommendations',
};

const normalizePayloadObject = (payload: unknown) => {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
};

const resolveGeneratedMessage = (intent: LinkAgentIntent) => {
  if (intent === 'onboarding_help') return 'Link Agent generated setup guidance.';
  if (intent === 'clinical_assistant') return 'Link Agent generated clinician support.';
  if (intent === 'diagnostic_recommendations') return 'Link Agent generated diagnostic guidance.';
  if (intent === 'diagnosis_recommendations') return 'Link Agent generated diagnosis guidance.';
  if (intent === 'treatment_recommendations') return 'Link Agent generated treatment guidance.';
  if (intent === 'symptom_assessment') return 'Link Agent generated symptom guidance.';
  return 'Link Agent generated HEW guidance.';
};

const resolveFallbackMessage = (intent: LinkAgentIntent) => {
  if (intent === 'onboarding_help') {
    return 'Link Agent is offline. Continue guided setup with the default checklist and first patient flow.';
  }
  if (intent === 'clinical_assistant') {
    return 'Link Agent is offline. Apply CDSS checkpoints and Ethiopian Standard Treatment Guidelines.';
  }
  if (intent === 'diagnostic_recommendations') {
    return 'Link Agent is offline. Order diagnostics using CDSS prompts and local protocol.';
  }
  if (intent === 'diagnosis_recommendations') {
    return 'Link Agent is offline. Use documented history, exam findings, and CDSS guidance for diagnosis.';
  }
  if (intent === 'treatment_recommendations') {
    return 'Link Agent is offline. Use Ethiopia STG treatment pathways and escalate danger signs.';
  }
  if (intent === 'symptom_assessment') {
    return 'Link Agent is offline. Share conservative symptom advice and direct urgent cases to the nearest clinic.';
  }
  return 'Link Agent is offline. Follow HEW danger-sign protocol and referral checklist.';
};

const buildFallbackContent = (
  intent: LinkAgentIntent,
  payload: Record<string, unknown>
) => {
  if (intent === 'onboarding_help') {
    return {
      checklist: [
        'Confirm facility and owner profile details.',
        'Select setup mode (recommended/modules/full clinic).',
        'Add first patient and complete one consultation flow.',
      ],
      note: 'Onboarding guidance is running in safe fallback mode.',
      _offline: true,
    };
  }

  if (intent === 'clinical_assistant') {
    return {
      success: true,
      analysis: {
        differentialDiagnosis: [
          {
            diagnosis: 'AI advisor offline',
            probability: 'Low',
            reasoning: 'Use CDSS hard-stops and local clinician judgment.',
            supportingFindings: [],
          },
        ],
        recommendedTests: [],
        treatmentOptions: [],
        redFlags: ['Escalate immediately if any danger sign is present.'],
        followUpPlan: 'Proceed with CDSS checkpoints and Ethiopian STG.',
        _offline: true,
      },
    };
  }

  if (intent === 'diagnostic_recommendations') {
    return {
      success: true,
      recommendations: {
        laboratoryTests: [],
        imagingStudies: [],
        redFlags: ['If instability is present, prioritize urgent referral.'],
        costConsiderations: 'Use lowest-cost essential tests first.',
        _offline: true,
      },
    };
  }

  if (intent === 'diagnosis_recommendations') {
    return {
      success: true,
      diagnosis: {
        workingDiagnosis: 'AI advisor offline',
        confidence: 'Low',
        differentialDiagnoses: [],
        keyFindings: [],
        nextSteps: ['Use CDSS and focused exam findings to finalize diagnosis.'],
        redFlagAssessment: 'Escalate if danger signs are present.',
        _offline: true,
      },
    };
  }

  if (intent === 'treatment_recommendations') {
    return {
      success: true,
      treatment: {
        immediateActions: [],
        pharmacotherapy: [],
        nonPharmacological: [],
        monitoring: ['Monitor vitals and response to first-line treatment.'],
        referralCriteria: ['Refer when danger signs or treatment failure is present.'],
        patientEducation: ['Provide return precautions and follow-up timing.'],
        followUpPlan: 'Use Ethiopian STG for definitive treatment.',
        _offline: true,
      },
    };
  }

  if (intent === 'symptom_assessment') {
    const rawMessage = String(payload.message || '').trim();
    return {
      response:
        rawMessage.length > 0
          ? 'I am in fallback mode. If symptoms are severe or worsening, seek care at the nearest Link-affiliated clinic now.'
          : 'Describe your symptoms briefly, and seek urgent care if there is breathing difficulty, chest pain, bleeding, or confusion.',
      urgency: 'review',
      nextSteps: [
        'Monitor symptoms closely.',
        'Visit the nearest clinic if symptoms worsen or persist.',
      ],
      safetyNotes: [
        'This guidance does not replace a clinician assessment.',
      ],
      _offline: true,
    };
  }

  return {
    guidance: [
      'Use danger-sign checklist first.',
      'Capture focused notes and referral reason.',
      'Escalate urgent cases to linked facility immediately.',
    ],
    _offline: true,
  };
};

const hasOfflineMarker = (content: unknown): boolean => {
  if (!content || typeof content !== 'object') return false;
  const record = content as Record<string, unknown>;
  if (record._offline === true) return true;
  for (const key of ['analysis', 'recommendations', 'diagnosis', 'treatment']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && (nested as Record<string, unknown>)._offline === true) {
      return true;
    }
  }
  return false;
};

const buildResponse = ({
  surface,
  intent,
  status,
  source,
  content,
  message,
  fallbackReason,
}: {
  surface: LinkAgentSurface;
  intent: LinkAgentIntent;
  status: LinkAgentStatus;
  source: LinkAgentSource;
  content: any;
  message: string;
  fallbackReason?: LinkAgentFallbackReason;
}): LinkAgentInteractionResponse => ({
  success: true,
  agent: {
    model: 'link_agent_v1',
    surface,
    intent,
    status,
    safeMode: true,
    source,
    ...(fallbackReason ? { fallbackReason } : {}),
  },
  message,
  content,
});

const buildFallbackResponse = (
  request: LinkAgentInteractionRequest,
  reason: LinkAgentFallbackReason
): LinkAgentInteractionResponse => {
  const payload = normalizePayloadObject(request.payload);
  return buildResponse({
    surface: request.surface,
    intent: request.intent,
    status: 'fallback',
    source: 'rules',
    content: buildFallbackContent(request.intent, payload),
    message: resolveFallbackMessage(request.intent),
    fallbackReason: reason,
  });
};

const callLocalLinkAgentEndpoint = async (
  request: LinkAgentInteractionRequest,
  config: LinkAgentRuntimeConfig
) => {
  return axios.post(
    `${config.localAiBaseUrl}/link-agent/respond`,
    {
      surface: request.surface,
      intent: request.intent,
      locale: request.locale,
      payload: normalizePayloadObject(request.payload),
      conversation: request.conversation || [],
      safeMode: true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(config.localAiSharedSecret ? { 'x-ai-key': config.localAiSharedSecret } : {}),
      },
      timeout: config.localAiTimeoutMs,
    }
  );
};

const callLegacyClinicianEndpoint = async (
  request: LinkAgentInteractionRequest,
  config: LinkAgentRuntimeConfig
) => {
  const endpoint = LEGACY_ENDPOINT_BY_INTENT[request.intent];
  if (!endpoint) return null;

  const payload = normalizePayloadObject(request.payload);
  const response = await axios.post(`${config.localAiBaseUrl}${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      ...(config.localAiSharedSecret ? { 'x-ai-key': config.localAiSharedSecret } : {}),
    },
    timeout: config.localAiTimeoutMs,
  });
  return response.data;
};

const normalizeStructuredResponse = (
  request: LinkAgentInteractionRequest,
  data: any
): LinkAgentInteractionResponse | null => {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;

  if (record.agent && typeof record.agent === 'object' && 'content' in record) {
    const agentRecord = record.agent as Record<string, unknown>;
    const status = agentRecord.status === 'fallback' ? 'fallback' : 'generated';
    return buildResponse({
      surface: request.surface,
      intent: request.intent,
      status,
      source: status === 'fallback' ? 'rules' : 'local_ai',
      content: record.content,
      message:
        typeof record.message === 'string' && record.message.trim().length > 0
          ? record.message
          : status === 'fallback'
            ? resolveFallbackMessage(request.intent)
            : resolveGeneratedMessage(request.intent),
      fallbackReason:
        status === 'fallback' && typeof agentRecord.fallbackReason === 'string'
          ? (agentRecord.fallbackReason as LinkAgentFallbackReason)
          : undefined,
    });
  }

  const offline = hasOfflineMarker(record);
  return buildResponse({
    surface: request.surface,
    intent: request.intent,
    status: offline ? 'fallback' : 'generated',
    source: offline ? 'rules' : 'local_ai',
    content: record,
    message: offline ? resolveFallbackMessage(request.intent) : resolveGeneratedMessage(request.intent),
    fallbackReason: offline ? 'ai_service_unavailable' : undefined,
  });
};

export const runLinkAgentInteraction = async (
  request: LinkAgentInteractionRequest,
  config: LinkAgentRuntimeConfig
): Promise<LinkAgentInteractionResponse> => {
  try {
    const response = await callLocalLinkAgentEndpoint(request, config);
    const normalized = normalizeStructuredResponse(request, response.data);
    if (normalized) return normalized;
  } catch (error: any) {
    const status = Number(error?.response?.status || 0);
    const shouldTryLegacyClinicianEndpoint =
      status === 404 && LINK_AGENT_CLINICIAN_INTENTS.includes(request.intent);

    if (!shouldTryLegacyClinicianEndpoint) {
      const fallbackReason: LinkAgentFallbackReason =
        status >= 500 || status === 0 ? 'ai_service_unavailable' : 'ai_service_error';
      return buildFallbackResponse(request, fallbackReason);
    }
  }

  if (LINK_AGENT_CLINICIAN_INTENTS.includes(request.intent)) {
    try {
      const legacyData = await callLegacyClinicianEndpoint(request, config);
      const normalized = normalizeStructuredResponse(request, legacyData);
      if (normalized) return normalized;
    } catch {
      return buildFallbackResponse(request, 'ai_service_unavailable');
    }
  }

  return buildFallbackResponse(request, 'invalid_response');
};

