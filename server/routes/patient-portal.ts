import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requirePatientSession, requirePatientCsrf } from '../middleware/patient-auth';
import { recordAuditEvent } from '../services/audit-log';
import {
  grantPatientPortalConsent,
  revokePatientPortalConsent,
  listPatientPortalConsentHistory,
} from '../services/patientPortalConsentService';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.PATIENT_DOCUMENT_MAX_BYTES || 10_000_000),
  },
});

const documentsBucket = process.env.PATIENT_DOCUMENTS_BUCKET || 'patient-health-records';
const signedUrlTtlSeconds = Number(process.env.PATIENT_DOCUMENT_SIGNED_TTL || 3600);
const allowedMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);
const allowedExtensions = new Set(['pdf', 'jpg', 'jpeg', 'png']);

const isAllowedDocument = (file: Express.Multer.File) => {
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  if (!extension || !allowedExtensions.has(extension)) return false;
  if (!allowedMimeTypes.has(file.mimetype)) return false;
  return true;
};

const extractStoragePath = (value: string) => {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const publicMarker = `/storage/v1/object/public/${documentsBucket}/`;
  const signedMarker = `/storage/v1/object/sign/${documentsBucket}/`;

  if (trimmed.includes(publicMarker)) {
    return trimmed.split(publicMarker)[1]?.split('?')[0] || null;
  }
  if (trimmed.includes(signedMarker)) {
    return trimmed.split(signedMarker)[1]?.split('?')[0] || null;
  }

  return null;
};

const buildSignedUrl = async (path: string) => {
  const { data, error } = await supabaseAdmin.storage
    .from(documentsBucket)
    .createSignedUrl(path, signedUrlTtlSeconds);

  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
};

const documentSchema = z.object({
  document_type: z.string().min(1),
  provider_name: z.string().optional().nullable(),
  document_date: z.string().min(1),
  description: z.string().optional().nullable(),
  tags: z.string().optional().nullable(),
});

const appointmentSchema = z.object({
  facility_id: z.string().uuid(),
  requested_date: z.string().min(1),
  requested_time_slot: z.string().optional().nullable(),
  reason: z.string().min(1),
});

const symptomsSchema = z.object({
  symptom_data: z.record(z.any()),
  urgency_level: z.string().min(1),
  recommendations: z.string().min(1),
});

const sendConsentContractError = (res: express.Response, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

router.get('/documents', requirePatientSession, async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;
  try {
    const { data, error } = await supabaseAdmin
      .from('patient_documents')
      .select('*')
      .eq('patient_account_id', patientAccountId)
      .order('document_date', { ascending: false });

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'list_documents',
        eventType: 'read',
        entityType: 'patient_document',
        tenantId,
        actorRole: 'patient',
        actorUserId: null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    const documents = data || [];
    const signedDocuments = await Promise.all(
      documents.map(async (doc) => {
        const storagePath = extractStoragePath(doc.file_url);
        if (!storagePath) return doc;
        const signedUrl = await buildSignedUrl(storagePath);
        if (!signedUrl) return doc;
        return { ...doc, file_url: signedUrl };
      })
    );

    return res.json({ documents: signedDocuments });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load documents' });
  }
});

router.post('/documents', requirePatientSession, requirePatientCsrf, upload.single('file'), async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;
  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenant context' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    if (!isAllowedDocument(req.file)) {
      return res.status(415).json({ error: 'Unsupported file type. Upload PDF, JPG, or PNG.' });
    }

    const parsed = documentSchema.parse(req.body);
    const fileExt = (req.file.originalname.split('.').pop() || 'dat').toLowerCase();
    const fileName = `${patientAccountId}/${Date.now()}-${Math.random().toString(16).slice(2)}.${fileExt}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(documentsBucket)
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message || 'Upload failed' });
    }

    const tags = parsed.tags
      ? parsed.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
      : [];

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('patient_documents')
      .insert({
        patient_account_id: patientAccountId,
        document_type: parsed.document_type,
        provider_name: parsed.provider_name || null,
        document_date: parsed.document_date,
        description: parsed.description || null,
        tags,
        file_url: fileName,
        tenant_id: tenantId,
      })
      .select('*')
      .single();

    if (insertError || !inserted) {
      return res.status(500).json({ error: insertError?.message || 'Failed to save document' });
    }

    await recordAuditEvent({
      action: 'upload_document',
      eventType: 'create',
      entityType: 'patient_document',
      entityId: inserted.id,
      tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });

    const signedUrl = await buildSignedUrl(fileName);
    const responseDoc = signedUrl ? { ...inserted, file_url: signedUrl } : inserted;

    return res.status(201).json({ document: responseDoc });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ error: error.message || 'Failed to upload document' });
  }
});

router.delete('/documents/:id', requirePatientSession, requirePatientCsrf, async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;
  const documentId = req.params.id;

  try {
    const { data: doc, error: docError } = await supabaseAdmin
      .from('patient_documents')
      .select('id, file_url')
      .eq('id', documentId)
      .eq('patient_account_id', patientAccountId)
      .maybeSingle();

    if (docError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('patient_documents')
      .delete()
      .eq('id', documentId)
      .eq('patient_account_id', patientAccountId);

    if (deleteError) throw deleteError;

    const path = doc.file_url ? extractStoragePath(doc.file_url) : null;
    if (path) {
      await supabaseAdmin.storage.from(documentsBucket).remove([path]);
    }

    if (tenantId) {
      await recordAuditEvent({
        action: 'delete_document',
        eventType: 'delete',
        entityType: 'patient_document',
        entityId: documentId,
        tenantId,
        actorRole: 'patient',
        actorUserId: null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to delete document' });
  }
});

router.get('/appointments', requirePatientSession, async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;

  try {
    const { data, error } = await supabaseAdmin
      .from('patient_appointment_requests')
      .select('*, facilities(name, phone_number)')
      .eq('patient_account_id', patientAccountId)
      .order('requested_date', { ascending: false });

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'list_appointments',
        eventType: 'read',
        entityType: 'appointment_request',
        tenantId,
        actorRole: 'patient',
        actorUserId: null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ appointments: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load appointments' });
  }
});

router.post('/appointments', requirePatientSession, requirePatientCsrf, async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;

  try {
    const payload = appointmentSchema.parse(req.body);
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing tenant context' });
    }

    const { data, error } = await supabaseAdmin
      .from('patient_appointment_requests')
      .insert({
        patient_account_id: patientAccountId,
        tenant_id: tenantId,
        facility_id: payload.facility_id,
        requested_date: payload.requested_date,
        requested_time_slot: payload.requested_time_slot || null,
        reason: payload.reason,
      })
      .select('*')
      .single();

    if (error || !data) throw error || new Error('Unable to create appointment request');

    await recordAuditEvent({
      action: 'request_appointment',
      eventType: 'create',
      entityType: 'appointment_request',
      entityId: data.id,
      tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });

    return res.status(201).json({ appointment: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ error: error.message || 'Failed to submit request' });
  }
});

router.get('/facilities', requirePatientSession, async (req, res) => {
  const { tenantId } = req.patient!;
  try {
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing tenant context' });
    }

    const { data, error } = await supabaseAdmin
      .from('facilities')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('verified', true)
      .order('name');

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'list_facilities',
        eventType: 'read',
        entityType: 'facility',
        tenantId,
        actorRole: 'patient',
        actorUserId: null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ facilities: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load facilities' });
  }
});

router.post('/symptoms', requirePatientSession, requirePatientCsrf, async (req, res) => {
  const { patientAccountId, tenantId } = req.patient!;
  try {
    const payload = symptomsSchema.parse(req.body);
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing tenant context' });
    }

    const { data, error } = await supabaseAdmin
      .from('patient_symptom_logs')
      .insert({
        patient_account_id: patientAccountId,
        symptom_data: payload.symptom_data,
        urgency_level: payload.urgency_level,
        recommendations: payload.recommendations,
        tenant_id: tenantId,
      })
      .select('*')
      .single();

    if (error || !data) throw error || new Error('Unable to save symptom log');

    await recordAuditEvent({
      action: 'log_symptoms',
      eventType: 'create',
      entityType: 'patient_symptom_log',
      entityId: data.id,
      tenantId,
      actorRole: 'patient',
      actorUserId: null,
      actorIpAddress: req.ip,
      actorUserAgent: req.get('user-agent') || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: req.requestId || null,
    });

    return res.status(201).json({ symptom_log: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ error: error.message || 'Failed to log symptoms' });
  }
});

router.post('/consents/grant', requirePatientSession, requirePatientCsrf, async (req, res) => {
  const actor = {
    patientAccountId: req.patient?.patientAccountId,
    tenantId: req.patient?.tenantId,
    role: 'patient',
    requestId: req.requestId || null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  };

  const result = await grantPatientPortalConsent({
    actor,
    payload: req.body,
  });
  if (result.ok === false) {
    return sendConsentContractError(res, result.status, result.code, result.message);
  }

  return res.status(result.data.created ? 201 : 200).json(result.data);
});

router.post('/consents/revoke', requirePatientSession, requirePatientCsrf, async (req, res) => {
  const actor = {
    patientAccountId: req.patient?.patientAccountId,
    tenantId: req.patient?.tenantId,
    role: 'patient',
    requestId: req.requestId || null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  };

  const result = await revokePatientPortalConsent({
    actor,
    payload: req.body,
  });
  if (result.ok === false) {
    return sendConsentContractError(res, result.status, result.code, result.message);
  }

  return res.json(result.data);
});

router.get('/consents/history', requirePatientSession, async (req, res) => {
  const actor = {
    patientAccountId: req.patient?.patientAccountId,
    tenantId: req.patient?.tenantId,
    role: 'patient',
    requestId: req.requestId || null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  };

  const result = await listPatientPortalConsentHistory({
    actor,
    query: req.query,
  });
  if (result.ok === false) {
    return sendConsentContractError(res, result.status, result.code, result.message);
  }

  return res.json(result.data);
});

export default router;
