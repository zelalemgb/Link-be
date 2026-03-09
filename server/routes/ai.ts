import express from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = express.Router();
const ALLOWED_IMAGE_MIMETYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/dicom',
    'image/dicom',
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: Number(process.env.AI_IMAGE_MAX_BYTES || 5_000_000),
    },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_MIMETYPES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}`));
        }
    },
});
// Local AI service (Ollama + RAG) — replaces Supabase/OpenAI edge functions
const localAiBaseUrl      = process.env.LOCAL_AI_SERVICE_URL  || 'http://127.0.0.1:8000';
const localAiTimeoutMs    = Number(process.env.LOCAL_AI_TIMEOUT_MS || 120_000);
const localAiSharedSecret = process.env.AI_SHARED_SECRET || '';

// Legacy vision endpoint config (kept for /predict backward compatibility)
const medGemmaServiceUrl   = `${localAiBaseUrl}/predict`;
const medGemmaTimeoutMs    = localAiTimeoutMs;
const medGemmaSharedSecret = localAiSharedSecret;

const allowPublicAi = process.env.AI_PUBLIC_ENABLED === 'true';
const isAiDebug     = process.env.AI_DEBUG === 'true';

// Function to call the python service
async function callMedGemma(prompt: string, imageBuffer?: Buffer, filename?: string) {
    const form = new FormData();
    form.append('prompt', prompt);
    if (imageBuffer && filename) {
        form.append('image', imageBuffer, filename);
    }

    try {
        const response = await axios.post(medGemmaServiceUrl, form, {
            headers: {
                ...form.getHeaders(),
                ...(medGemmaSharedSecret ? { 'x-medgemma-key': medGemmaSharedSecret } : {}),
            },
            timeout: medGemmaTimeoutMs,
        });
        return response.data;
    } catch (error: any) {
        if (isAiDebug) {
            console.error('Error calling MedGemma:', {
                message: error.message,
                status: error.response?.status,
            });
        } else {
            console.error('Error calling MedGemma');
        }
        throw new Error('Failed to analyze data');
    }
}

/**
 * Call the local AI service (Ollama + RAG) instead of Supabase Edge Functions.
 * No patient data ever leaves the facility — fully offline-capable.
 */
async function callLocalAiEndpoint(req: any, res: any, endpoint: string, action: string) {
    try {
        const { tenantId, facilityId, profileId, role } = req.user!;

        const response = await axios.post(
            `${localAiBaseUrl}${endpoint}`,
            req.body || {},
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(localAiSharedSecret ? { 'x-ai-key': localAiSharedSecret } : {}),
                },
                timeout: localAiTimeoutMs,
            },
        );

        if (tenantId) {
            await recordAuditEvent({
                action,
                eventType: 'create',
                entityType: 'ai_request',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { endpoint, local: true },
            });
        }

        return res.json(response.data);
    } catch (error: any) {
        if (isAiDebug) console.error(`Local AI [${endpoint}] error:`, error?.message);
        // Graceful offline degradation — return a structured offline response
        return res.json({
            success: true,
            _offline: true,
            message: 'AI advisor temporarily offline. Apply CDSS rule engine and Ethiopian Standard Treatment Guidelines.',
        });
    }
}

/** Legacy Supabase function bridge — kept for non-clinical utility functions */
async function invokeSupabaseFunction(req: any, res: any, functionName: string, action: string) {
    try {
        const { tenantId, facilityId, profileId, role } = req.user!;
        const { data, error } = await supabaseAdmin.functions.invoke(functionName, {
            body: req.body || {},
        });

        if (error) {
            return res.status(500).json({ error: error.message || 'Function invocation failed' });
        }

        if (tenantId) {
            await recordAuditEvent({
                action,
                eventType: 'create',
                entityType: 'ai_request',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { function: functionName },
            });
        }

        return res.json(data);
    } catch (error: any) {
        console.error('AI Function Route Error', error?.message || error);
        return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
}

if (allowPublicAi) {
    console.log('[AI Routes] Registering /analyze-public endpoint');
    // Public endpoint for testing (no auth required)
    router.post('/analyze-public', upload.single('image'), async (req, res) => {
        try {
            const { prompt } = req.body;
            if (!prompt) {
                return res.status(400).json({ error: 'Prompt is required' });
            }

            const startTime = Date.now();
            const result = await callMedGemma(prompt, req.file?.buffer, req.file?.originalname);
            const duration = Date.now() - startTime;

            if (isAiDebug) {
                console.log(`AI Analysis completed in ${duration}ms`);
            }

            res.json(result);
        } catch (error: any) {
            console.error('AI Analysis Route Error');
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
}

// Authenticated endpoint
router.post('/analyze', requireUser, requireScopedUser, upload.single('image'), async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const { profileId, tenantId, facilityId, role } = req.user!;
        const userId = profileId || 'anonymous';
        if (isAiDebug) {
            console.log(`Processing AI analysis request for user ${userId}`);
        }
        const startTime = Date.now();

        const result = await callMedGemma(prompt, req.file?.buffer, req.file?.originalname);

        const duration = Date.now() - startTime;
        if (isAiDebug) {
            console.log(`AI Analysis completed in ${duration}ms`);
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'ai_analyze',
                eventType: 'create',
                entityType: 'ai_request',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: {
                    prompt_length: typeof prompt === 'string' ? prompt.length : 0,
                    has_image: Boolean(req.file),
                },
            });
        }

        res.json(result);
    } catch (error: any) {
        console.error('AI Analysis Route Error');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Clinical AI endpoints — served by local Ollama + RAG service ──────────────
// All patient data stays on-premises. No cloud API calls. Offline-capable.

router.post('/clinical-assistant', requireUser, requireScopedUser, (req, res) => {
    return callLocalAiEndpoint(req, res, '/clinical-assistant', 'ai_clinical_assistant');
});

router.post('/diagnostic-recommendations', requireUser, requireScopedUser, (req, res) => {
    return callLocalAiEndpoint(req, res, '/diagnostic-recommendations', 'ai_diagnostic_recommendations');
});

router.post('/diagnosis-recommendations', requireUser, requireScopedUser, (req, res) => {
    return callLocalAiEndpoint(req, res, '/diagnosis-recommendations', 'ai_diagnosis_recommendations');
});

router.post('/treatment-recommendations', requireUser, requireScopedUser, (req, res) => {
    return callLocalAiEndpoint(req, res, '/treatment-recommendations', 'ai_treatment_recommendations');
});

/**
 * POST /api/ai/learn
 * Called internally after a provider accepts or modifies an AI suggestion.
 * Strips identifiers and sends anonymised case to the RAG knowledge base.
 * The local ML service embeds it — future similar queries get this as context.
 */
router.post('/learn', requireUser, requireScopedUser, async (req, res) => {
    try {
        const response = await axios.post(
            `${localAiBaseUrl}/learn`,
            req.body || {},
            {
                headers: {
                    'Content-Type': 'application/json',
                    ...(localAiSharedSecret ? { 'x-ai-key': localAiSharedSecret } : {}),
                },
                timeout: 15_000,
            },
        );
        return res.json(response.data);
    } catch (error: any) {
        if (isAiDebug) console.error('RAG /learn error:', error?.message);
        return res.json({ success: false, message: 'RAG learning endpoint temporarily unavailable.' });
    }
});

// ── Non-clinical utility functions — still use Supabase Edge Functions ─────────

router.post('/medication-return-suggestions', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'medication-return-suggestions', 'ai_medication_return_suggestions');
});

export default router;
