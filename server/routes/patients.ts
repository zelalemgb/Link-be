import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();
router.use(requireUser);

// Schema for creating a visit
const createVisitSchema = z.object({
    visitDate: z.string(),
    reason: z.string(),
    provider: z.string(),
    feePaid: z.number(), // or string, but prefer number
    visitNotes: z.string().optional(),
    consultationServiceId: z.string().optional(),
});

/**
 * GET /api/patients/search
 * Query params: q (search term)
 */
router.get('/search', async (req, res) => {
    const { facilityId } = req.user!;
    const q = req.query.q as string;

    if (!q || q.length < 2) {
        return res.json([]);
    }

    try {
        const searchTerm = `%${q}%`;
        const { data, error } = await supabaseAdmin
            .from('patients')
            .select(`
          id,
          first_name,
          last_name,
          full_name,
          fayida_id,
          date_of_birth,
          gender,
          phone,
          visits (
            id,
            visit_date,
            status,
            reason,
            triage_urgency
          )
        `)
            .eq('facility_id', facilityId)
            .or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},full_name.ilike.${searchTerm},phone.ilike.${searchTerm},fayida_id.ilike.${searchTerm}`)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/patients/:id/visits/history
 */
router.get('/:id/visits/history', async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 5;
    try {
        const { data, error } = await supabaseAdmin
            .from('visits')
            .select('id, visit_date, reason, status, provider, visit_notes, clinical_notes, fee_paid, temperature, weight, blood_pressure, heart_rate, respiratory_rate, oxygen_saturation, pain_score')
            .eq('patient_id', req.params.id)
            .order('visit_date', { ascending: false })
            .limit(limit);

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/patients/:id/visits
 * Create a new visit
 */
router.post('/:id/visits', async (req, res) => {
    const { tenantId, facilityId, profileId: userId } = req.user!;
    const patientId = req.params.id;

    try {
        const payload = createVisitSchema.parse(req.body);

        // 0. CHECK FOR ACTIVE VISITS
        const { data: activeVisits } = await supabaseAdmin
            .from('visits')
            .select('id, status')
            .eq('patient_id', patientId)
            .in('status', ['registered', 'triage', 'doctor', 'lab', 'pharmacy', 'procedure'])
            .order('visit_date', { ascending: false })
            .limit(1);

        if (activeVisits && activeVisits.length > 0) {
            return res.status(409).json({
                error: 'Patient has an active visit in progress. Please complete or cancel the existing visit before creating a new one.'
            });
        }

        // 1. Insert Visit
        const { data: visit, error: visitError } = await supabaseAdmin
            .from('visits')
            .insert({
                patient_id: patientId,
                visit_date: payload.visitDate,
                reason: payload.reason,
                provider: payload.provider,
                fee_paid: payload.feePaid,
                visit_notes: payload.visitNotes || null,
                created_by: userId, // internal user id
                facility_id: facilityId,
                status: 'registered',
                tenant_id: tenantId
            })
            .select()
            .single();

        if (visitError) throw visitError;

        // 2. Initialize Journey Tracking
        await supabaseAdmin.rpc('append_journey_stage', {
            p_visit_id: visit.id,
            p_stage: 'registered',
            p_user_id: userId
        });

        // 3. Create Billing Item
        try {
            let consultationService;

            // Priority: Explicit Service ID
            if (payload.consultationServiceId && payload.consultationServiceId !== 'none') {
                const { data: selectedService } = await supabaseAdmin
                    .from('medical_services')
                    .select('id, price')
                    .eq('id', payload.consultationServiceId)
                    .single();

                if (selectedService) {
                    consultationService = selectedService;
                }
            }

            // Legacy Fallback (Only AND ONLY IF no explicit ID provided)
            // This is kept for backward compatibility with older clients if any, 
            // but we really want to move away from this.
            if (!consultationService && !payload.consultationServiceId) {
                const reasonLower = payload.reason.toLowerCase();
                const visitTypeKeyword = reasonLower.includes('new') ? 'new patient' :
                    reasonLower.includes('follow') ? 'follow-up' :
                        reasonLower.includes('emergency') ? 'emergency' :
                            'returning patient';

                // Try facility specific
                const { data: facService } = await supabaseAdmin
                    .from('medical_services')
                    .select('id, price')
                    .eq('facility_id', facilityId)
                    .eq('category', 'Consultation')
                    .eq('is_active', true)
                    .ilike('name', `%${visitTypeKeyword}%`)
                    .maybeSingle();

                consultationService = facService;

                // Fallback
                if (!consultationService) {
                    const { data: fallback } = await supabaseAdmin
                        .from('medical_services')
                        .select('id, price')
                        .eq('category', 'Consultation')
                        .eq('is_active', true)
                        .ilike('name', `%${visitTypeKeyword}%`)
                        .maybeSingle();
                    consultationService = fallback;
                }
            }

            if (consultationService) {
                await supabaseAdmin.from('billing_items').insert({
                    patient_id: patientId,
                    visit_id: visit.id,
                    service_id: consultationService.id,
                    quantity: 1,
                    unit_price: consultationService.price,
                    total_amount: consultationService.price,
                    created_by: userId,
                    payment_status: 'unpaid',
                    tenant_id: tenantId
                });
            }
        } catch (billingErr) {
            console.error('Billing creation failed', billingErr);
            // non-blocking
        }

        res.json(visit);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

// Schema for registration
const registerIntakeSchema = z.object({
    firstName: z.string(),
    middleName: z.string(),
    lastName: z.string(),
    sex: z.enum(['M', 'F']),
    age: z.number(),
    dateOfBirth: z.string().nullable().optional(),
    phone: z.string(),
    fayidaId: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    woredaSubcity: z.string().nullable().optional(),
    ketenaGott: z.string().nullable().optional(),
    kebele: z.string().nullable().optional(),
    houseNumber: z.string().nullable().optional(),
    visitType: z.string(),
    residence: z.string().nullable().optional(),
    occupation: z.string().nullable().optional(),
    intakeTimestamp: z.string(),
    intakePatientId: z.string(),
    consultationPaymentType: z.string(),
    programId: z.string().optional(),
    creditorId: z.string().optional(),
    insuranceProviderId: z.string().optional(),
    insurancePolicyNumber: z.string().optional(),

    // Intake flags
    isPregnant: z.boolean().optional(),
    emergencyFlag: z.boolean().optional(),
    emergencyDescription: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    guardianConsent: z.boolean().optional(),

    // Fee Selection
    consultationServiceId: z.string().optional(),

    // Requested Doctor
    requestedProfessionalId: z.string().optional()
});

/**
 * POST /api/patients/register-intake
 * Registers a new patient with visit and billing
 */
router.post('/register-intake', async (req, res) => {
    const { tenantId, facilityId, profileId: userId } = req.user!;

    try {
        const payload = registerIntakeSchema.parse(req.body);

        // 1. Duplicate Check (Fayida ID)
        if (payload.fayidaId) {
            const { data: existingPatient } = await supabaseAdmin
                .from('patients')
                .select('id')
                .eq('fayida_id', payload.fayidaId)
                .maybeSingle();

            if (existingPatient) {
                return res.status(409).json({ error: 'A patient with this National ID already exists.' });
            }
        }

        // 2. Call RPC
        const { data: result, error: rpcError } = await supabaseAdmin.rpc('register_patient_with_visit', {
            p_first_name: payload.firstName,
            p_middle_name: payload.middleName,
            p_last_name: payload.lastName,
            p_gender: payload.sex === 'M' ? 'Male' : 'Female',
            p_age: payload.age,
            p_date_of_birth: payload.dateOfBirth || null,
            p_phone: payload.phone,
            p_fayida_id: payload.fayidaId || null,
            p_user_id: userId,
            p_facility_id: facilityId,
            p_region: payload.region || null,
            p_woreda_subcity: payload.woredaSubcity || null,
            p_ketena_gott: payload.ketenaGott || null,
            p_kebele: payload.kebele || null,
            p_house_number: payload.houseNumber || null,
            p_visit_type: payload.visitType,
            p_residence: payload.residence || null,
            p_occupation: payload.occupation || null,
            p_intake_timestamp: payload.intakeTimestamp,
            p_intake_patient_id: payload.intakePatientId,
            p_consultation_payment_type: payload.consultationPaymentType,
            p_program_id: payload.programId || null,
            p_creditor_id: payload.creditorId || null,
            p_insurer_id: payload.insuranceProviderId || null,
            p_insurance_policy_number: payload.insurancePolicyNumber || null,
            p_consultation_service_id: payload.consultationServiceId || null,
            p_provider: payload.requestedProfessionalId || 'Reception Intake'
        });

        if (rpcError) throw rpcError;

        // 3. Update visit notes with warnings/flags
        const intakeFlags: string[] = [];
        if (payload.visitType === 'Follow-up') {
            intakeFlags.push('Follow-up visit');
        }
        if (payload.age < 18) {
            intakeFlags.push(`Pediatric (${payload.age}y) guardian: ${payload.guardianName || 'n/a'} ${payload.guardianPhone || ''} consent: ${payload.guardianConsent ? 'yes' : 'no'}`.trim());
        }
        if (payload.isPregnant) {
            intakeFlags.push('Pregnancy flag recorded at intake');
        }
        if (payload.emergencyFlag) {
            intakeFlags.push(`Emergency flag: ${payload.emergencyDescription || 'unspecified'}`);
        }

        if (intakeFlags.length > 0) {
            const note = `Intake flags — ${intakeFlags.join(' | ')}`;
            // We need to fetch the visit ID from result. Result is object { visit_id, ... }
            const visitId = (result as any).visit_id;
            if (visitId) {
                await supabaseAdmin
                    .from('visits')
                    .update({ visit_notes: note })
                    .eq('id', visitId);
            }
        }

        res.json(result);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

export default router;
