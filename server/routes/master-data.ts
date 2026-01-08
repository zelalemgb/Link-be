import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();
router.use(requireUser);

// --- Validations ---

const serviceSchema = z.object({
    name: z.string().min(1),
    code: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    price: z.number().nullable().optional(),
    category: z.string().optional(),
    is_active: z.boolean().default(true),
});

const medicationSchema = z.object({
    medication_name: z.string().min(1),
    generic_name: z.string().optional().nullable(),
    dosage_form: z.string(),
    strength: z.string().optional().nullable(),
    route: z.string(),
    category: z.string(),
    icd11_code: z.string().optional().nullable(),
    is_active: z.boolean().default(true),
});


// --- Medical Services (Lab Tests, etc.) ---

/**
 * GET /api/master-data/services
 * Query params: category, facility_id (optional)
 * Logic: If facility_id provided, tries to fetch facility-specific services. 
 * If none found (and fallback=true?), fetches tenant-wide services?
 * Frontend currently does: try facility, if empty, try tenant.
 * We will support filtration by tenant_id (from user session) and optional facility_id.
 */
router.get('/services', async (req, res) => {
    const { tenantId, facilityId } = req.user!;
    const { category } = req.query;

    try {
        let query = supabaseAdmin
            .from('medical_services')
            .select('*')
            .eq('tenant_id', tenantId);

        if (category) {
            query = query.eq('category', category);
        }

        // Default: return all services for this tenant. 
        // If the frontend wants specific facility items, they can filter or we can filter here.
        // The frontend logic was: "get my facility items, if none, get tenant items".
        // We can just return all items for the tenant and let frontend decide?
        // OR we can implement the fallback logic here.
        // Let's return all items for the tenant, but if facility_id is passed, we prioritise?
        // Actually, `medical_services` has a `facility_id` column.

        // Simplest approach: Return all services for the tenant. The frontend can filter or we just send everything.
        // But wait, if facility A defines a price, and facility B uses default, we need to know.

        // Let's stick to returning everything for the tenant for now (filtered by category).
        // The frontend can interpret "facility_id matches me" vs "facility_id is null (master)".

        const { data, error } = await query.order('name');

        if (error) throw error;

        // Emulate the frontend fallback logic? 
        // The frontend logic was explicit: "If I have my own list, I use it. If not, I use the master list".
        // It implies if I have even ONE item, I ignore the master list? 
        // "If facility has lab tests, return them. Fallback: fetch tenant-wide lab tests."
        // Yes, that sounds like an override mode.

        // We can do this:
        if (facilityId) {
            const facilitySpecific = data.filter((d: any) => d.facility_id === facilityId);
            if (facilitySpecific.length > 0) {
                return res.json(facilitySpecific);
            }
        }

        // Fallback to items where facility_id matches OR is null (if the schema supports null for master list).
        // The previous code queried: .eq('facility_id', facilityId!) then .eq('facility_id', tenantId!)??
        // Wait, the previous code queried:
        // 1. .eq('tenant_id', tenantId).eq('facility_id', facilityId)
        // 2. .eq('tenant_id', tenantId)  <-- without facility_id filter? Or implied facility_id is null?
        // Looking at the view_file output:
        // line 85: .eq('tenant_id', tenantId!)
        // line 86: .eq('category', 'Laboratory')
        // It didn't filter by facility_id in the fallback. So it returned ALL tenant items?
        // But `facility_id` is likely a column.

        // Let's just return what matched the tenant query (including facility-specific ones).
        return res.json(data);

    } catch (error: any) {
        console.error('Fetch services error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/services', async (req, res) => {
    const { tenantId, facilityId } = req.user!;
    try {
        const payload = serviceSchema.parse(req.body);
        const { data, error } = await supabaseAdmin
            .from('medical_services')
            .insert({
                ...payload,
                tenant_id: tenantId,
                facility_id: facilityId, // Created by this facility
                created_by: req.user!.authUserId
            })
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

router.put('/services/:id', async (req, res) => {
    try {
        const payload = serviceSchema.parse(req.body); // Using partial? No, schema is strict but we can make partial.
        // For now assume full payload or use .partial()
        const { data, error } = await supabaseAdmin
            .from('medical_services')
            .update(payload)
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/services/:id', async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('medical_services')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});


// --- Medications ---

router.get('/medications', async (req, res) => {
    const { tenantId } = req.user!;
    try {
        const { data, error } = await supabaseAdmin
            .from('medication_master')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('medication_name');

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/medications', async (req, res) => {
    const { tenantId } = req.user!;
    try {
        const payload = medicationSchema.parse(req.body);
        const { data, error } = await supabaseAdmin
            .from('medication_master')
            .insert({
                ...payload,
                tenant_id: tenantId,
            })
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

router.put('/medications/:id', async (req, res) => {
    try {
        const payload = medicationSchema.parse(req.body);
        const { data, error } = await supabaseAdmin
            .from('medication_master')
            .update(payload)
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/medications/:id', async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('medication_master')
            .delete()
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});


// --- Lab Test Catalog (Read-only Master) ---

router.get('/lab-catalog', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('lab_test_master')
            .select('*');
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- Imaging Studies ---

const imagingSchema = z.object({
    study_name: z.string().min(1),
    study_code: z.string().optional().nullable(),
    modality: z.string(),
    body_part: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    preparation_instructions: z.string().optional().nullable(),
    estimated_duration_minutes: z.number().nullable().optional(),
    price: z.number().nullable().optional(),
    is_active: z.boolean().default(true),
});

router.get('/imaging', async (req, res) => {
    const { tenantId, facilityId } = req.user!;
    try {
        const { data, error } = await supabaseAdmin
            .from('imaging_study_catalog')
            .select('*')
            .eq('tenant_id', tenantId)
            // fetch both master (facility_id is null) and facility specific
            .or(`facility_id.is.null,facility_id.eq.${facilityId}`)
            .order('modality')
            .order('study_name');

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/imaging', async (req, res) => {
    const { tenantId, facilityId } = req.user!;
    try {
        const payload = imagingSchema.parse(req.body);
        const { data, error } = await supabaseAdmin
            .from('imaging_study_catalog')
            .insert({
                ...payload,
                tenant_id: tenantId,
                facility_id: facilityId,
            })
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

router.put('/imaging/:id', async (req, res) => {
    try {
        const payload = imagingSchema.parse(req.body);
        const { data, error } = await supabaseAdmin
            .from('imaging_study_catalog')
            .update(payload)
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/imaging/:id', async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('imaging_study_catalog')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
