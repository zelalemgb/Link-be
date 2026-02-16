import express from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: Number(process.env.AI_IMAGE_MAX_BYTES || 5_000_000),
    },
});
const medGemmaServiceUrl = process.env.MEDGEMMA_SERVICE_URL || 'http://127.0.0.1:8000/predict';
const medGemmaTimeoutMs = Number(process.env.MEDGEMMA_TIMEOUT_MS || 90000);
const medGemmaSharedSecret = process.env.MEDGEMMA_SHARED_SECRET || '';
const allowPublicAi = process.env.AI_PUBLIC_ENABLED === 'true';
const isAiDebug = process.env.AI_DEBUG === 'true';

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

router.post('/clinical-assistant', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'ai-clinical-assistant', 'ai_clinical_assistant');
});

router.post('/diagnostic-recommendations', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'diagnostic-recommendations', 'ai_diagnostic_recommendations');
});

router.post('/diagnosis-recommendations', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'diagnosis-recommendations', 'ai_diagnosis_recommendations');
});

router.post('/treatment-recommendations', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'treatment-recommendations', 'ai_treatment_recommendations');
});

router.post('/medication-return-suggestions', requireUser, requireScopedUser, (req, res) => {
    return invokeSupabaseFunction(req, res, 'medication-return-suggestions', 'ai_medication_return_suggestions');
});

export default router;
