import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const admitSchema = z.object({
  patientId: z.string().uuid(),
  wardId: z.string().uuid(),
  bedNumber: z.string().min(1),
  reason: z.string().min(1),
  notes: z.string().optional().nullable(),
});

const dischargeSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  dischargeSummary: z.string().min(1),
});

router.get('/wards', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const { data, error } = await supabaseAdmin
      .from('wards')
      .select('id, name, available_beds, occupied_beds, total_beds')
      .eq('facility_id', facilityId)
      .eq('is_active', true)
      .eq('accepts_admissions', true)
      .order('name');

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_wards',
        eventType: 'read',
        entityType: 'ward',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ wards: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load wards' });
  }
});

router.get('/wards/beds', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const { data: wards, error } = await supabaseAdmin
      .from('wards')
      .select('id, name, code, ward_type, total_beds, available_beds, occupied_beds, cleaning_beds, is_active')
      .eq('facility_id', facilityId)
      .eq('is_active', true)
      .order('name');

    if (error) throw error;

    const { data: admittedVisits, error: visitsError } = await supabaseAdmin
      .from('visits_with_current_stage')
      .select(`
        id,
        patient_id,
        admission_ward,
        admission_bed,
        admitted_at,
        clinical_notes,
        assigned_doctor,
        triage_urgency,
        consultation_payment_type,
        current_journey_stage,
        patients (
          full_name,
          age,
          gender
        )
      `)
      .eq('facility_id', facilityId)
      .not('admission_ward', 'is', null)
      .not('admission_bed', 'is', null)
      .eq('current_journey_stage', 'admitted');

    if (visitsError) throw visitsError;

    const visitIds = (admittedVisits || []).map((visit) => visit.id);
    const paymentTypeByVisit = new Map<string, string>();
    (admittedVisits || []).forEach((visit) => {
      paymentTypeByVisit.set(visit.id, (visit as any).consultation_payment_type || 'paying');
    });
    const dueByVisit = new Map<string, number>();

    const addDue = (visitId?: string | null, amount?: number | null) => {
      if (!visitId) return;
      const numericAmount = Number(amount || 0);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) return;
      dueByVisit.set(visitId, (dueByVisit.get(visitId) || 0) + numericAmount);
    };

    if (visitIds.length > 0) {
      const [labDue, imagingDue, medicationDue, billingDue] = await Promise.all([
        supabaseAdmin
          .from('lab_orders')
          .select('visit_id, amount')
          .in('visit_id', visitIds)
          .eq('payment_status', 'unpaid'),
        supabaseAdmin
          .from('imaging_orders')
          .select('visit_id, amount')
          .in('visit_id', visitIds)
          .eq('payment_status', 'unpaid'),
        supabaseAdmin
          .from('medication_orders')
          .select('visit_id, amount')
          .in('visit_id', visitIds)
          .eq('payment_status', 'unpaid'),
        supabaseAdmin
          .from('billing_items')
          .select('visit_id, total_amount')
          .in('visit_id', visitIds)
          .eq('payment_status', 'unpaid'),
      ]);

      if (labDue.error) throw labDue.error;
      if (imagingDue.error) throw imagingDue.error;
      if (medicationDue.error) throw medicationDue.error;
      if (billingDue.error) throw billingDue.error;

      (labDue.data || []).forEach((row: any) => addDue(row.visit_id, row.amount));
      (imagingDue.data || []).forEach((row: any) => addDue(row.visit_id, row.amount));
      (medicationDue.data || []).forEach((row: any) => addDue(row.visit_id, row.amount));
      (billingDue.data || []).forEach((row: any) => {
        const paymentType = (paymentTypeByVisit.get(row.visit_id) || 'paying').toLowerCase();
        if (['free', 'credit', 'insured'].includes(paymentType)) return;
        addDue(row.visit_id, row.total_amount);
      });
    }

    const mappedWards = (wards || []).map((ward) => {
      const totalBeds = ward.total_beds || 0;
      const availableBeds = ward.available_beds || 0;
      const cleaningBeds = ward.cleaning_beds || 0;
      const cleaningThreshold = Math.max(0, totalBeds - availableBeds - cleaningBeds);

      const wardPatients = (admittedVisits || []).filter(
        (visit) => visit.admission_ward === ward.name
      );

      const beds = Array.from({ length: totalBeds }, (_, index) => {
        const bedNumber = `${index + 1}`;
        const patient = wardPatients.find((visit) => visit.admission_bed === bedNumber);

        if (patient) {
          const patientProfile = Array.isArray(patient.patients) ? patient.patients[0] : patient.patients;
          return {
            bed_number: bedNumber,
            patient_id: patient.patient_id,
            patient_name: patientProfile?.full_name,
            visit_id: patient.id,
            admission_date: patient.admitted_at,
            admitted_at: patient.admitted_at,
            ward_name: ward.name,
            diagnosis: patient.clinical_notes,
            age: patientProfile?.age,
            gender: patientProfile?.gender,
            triage_urgency: patient.triage_urgency || null,
            outstanding_balance: dueByVisit.get(patient.id) || 0,
            status: 'occupied',
            assignedDoctor: patient.assigned_doctor,
          };
        }

        if (index + 1 <= cleaningThreshold) {
          return { bed_number: bedNumber, status: 'cleaning' };
        }

        return { bed_number: bedNumber, status: 'available' };
      });

      return {
        ...ward,
        beds,
      };
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_inpatient_wards',
        eventType: 'read',
        entityType: 'ward',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: mappedWards.length },
      });
    }

    return res.json({ wards: mappedWards });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load wards' });
  }
});

router.get('/tasks', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const tasks: any[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: medications, error: medicationError } = await supabaseAdmin
      .from('medication_orders')
      .select(`
        id,
        visit_id,
        patient_id,
        medication_name,
        ordered_at,
        status,
        visits!inner (
          admission_ward,
          admission_bed,
          assigned_doctor,
          facility_id,
          patients (
            full_name
          )
        )
      `)
      .eq('facility_id', facilityId)
      .eq('visits.facility_id', facilityId)
      .not('visits.admission_ward', 'is', null)
      .in('status', ['pending', 'approved'])
      .gte('ordered_at', today.toISOString());

    if (medicationError) throw medicationError;

    medications?.forEach((med) => {
      const visit = Array.isArray(med.visits) ? med.visits[0] : med.visits;
      const visitPatient = Array.isArray(visit?.patients) ? visit?.patients[0] : visit?.patients;
      if (visit?.admission_ward) {
        tasks.push({
          id: med.id,
          visit_id: med.visit_id,
          patient_id: med.patient_id,
          patient_name: visitPatient?.full_name || 'Unknown',
          task_type: 'medication',
          task_name: med.medication_name,
          scheduled_time: med.ordered_at,
          status: 'pending',
          ward_name: visit.admission_ward,
          bed_number: visit.admission_bed || '',
          urgency: med.status === 'pending' ? 'routine' : 'urgent',
          assignedDoctor: visit.assigned_doctor,
        });
      }
    });

    const { data: labOrders, error: labError } = await supabaseAdmin
      .from('lab_orders')
      .select(`
        id,
        visit_id,
        patient_id,
        test_name,
        ordered_at,
        status,
        urgency,
        visits!inner (
          admission_ward,
          admission_bed,
          assigned_doctor,
          facility_id,
          patients (
            full_name
          )
        )
      `)
      .eq('visits.facility_id', facilityId)
      .not('visits.admission_ward', 'is', null)
      .in('status', ['pending', 'approved', 'collected'])
      .gte('ordered_at', today.toISOString());

    if (labError) throw labError;

    labOrders?.forEach((lab) => {
      const visit = Array.isArray(lab.visits) ? lab.visits[0] : lab.visits;
      const visitPatient = Array.isArray(visit?.patients) ? visit?.patients[0] : visit?.patients;
      if (visit?.admission_ward) {
        tasks.push({
          id: lab.id,
          visit_id: lab.visit_id,
          patient_id: lab.patient_id,
          patient_name: visitPatient?.full_name || 'Unknown',
          task_type: 'lab',
          task_name: lab.test_name,
          scheduled_time: lab.ordered_at,
          status: lab.status === 'collected' ? 'completed' : 'pending',
          ward_name: visit.admission_ward,
          bed_number: visit.admission_bed || '',
          urgency: lab.urgency || 'routine',
          assignedDoctor: visit.assigned_doctor,
        });
      }
    });

    const { data: imagingOrders, error: imagingError } = await supabaseAdmin
      .from('imaging_orders')
      .select(`
        id,
        visit_id,
        patient_id,
        study_name,
        ordered_at,
        status,
        urgency,
        visits!inner (
          admission_ward,
          admission_bed,
          assigned_doctor,
          facility_id,
          patients (
            full_name
          )
        )
      `)
      .eq('visits.facility_id', facilityId)
      .not('visits.admission_ward', 'is', null)
      .in('status', ['pending', 'approved'])
      .gte('ordered_at', today.toISOString());

    if (imagingError) throw imagingError;

    imagingOrders?.forEach((img) => {
      const visit = Array.isArray(img.visits) ? img.visits[0] : img.visits;
      const visitPatient = Array.isArray(visit?.patients) ? visit?.patients[0] : visit?.patients;
      if (visit?.admission_ward) {
        tasks.push({
          id: img.id,
          visit_id: img.visit_id,
          patient_id: img.patient_id,
          patient_name: visitPatient?.full_name || 'Unknown',
          task_type: 'imaging',
          task_name: img.study_name,
          scheduled_time: img.ordered_at,
          status: 'pending',
          ward_name: visit.admission_ward,
          bed_number: visit.admission_bed || '',
          urgency: img.urgency || 'routine',
          assignedDoctor: visit.assigned_doctor,
        });
      }
    });

    tasks.sort((a, b) => {
      if (a.urgency === 'stat' && b.urgency !== 'stat') return -1;
      if (b.urgency === 'stat' && a.urgency !== 'stat') return 1;
      return new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime();
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_inpatient_tasks',
        eventType: 'read',
        entityType: 'order',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: tasks.length },
      });
    }

    return res.json({ tasks });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load tasks' });
  }
});

router.get('/patients/search', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.json({ patients: [] });

  try {
    const { data, error } = await supabaseAdmin
      .from('patients')
      .select('id, full_name, age, gender, phone')
      .eq('facility_id', facilityId)
      .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(10);

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'search_patients',
        eventType: 'read',
        entityType: 'patient',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ patients: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to search patients' });
  }
});

router.get('/patients/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const patientId = req.params.id;
  try {
    const { data, error } = await supabaseAdmin
      .from('patients')
      .select('id, full_name, age, gender, phone')
      .eq('id', patientId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Patient not found' });

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_patient',
        eventType: 'read',
        entityType: 'patient',
        entityId: patientId,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ patient: data });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load patient' });
  }
});

router.post('/admit', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const payload = admitSchema.parse(req.body);
    const { patientId, wardId, bedNumber, reason, notes } = payload;

    const { data: ward, error: wardError } = await supabaseAdmin
      .from('wards')
      .select('id, name')
      .eq('id', wardId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (wardError) throw wardError;
    if (!ward) return res.status(404).json({ error: 'Ward not found' });

    const { data: existingVisit } = await supabaseAdmin
      .from('visits')
      .select('id')
      .eq('patient_id', patientId)
      .eq('facility_id', facilityId)
      .eq('status', 'in_progress')
      .maybeSingle();

    let visitId: string;
    if (existingVisit?.id) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('visits')
        .update({
          status: 'admitted',
          admission_ward: ward.name,
          admission_bed: bedNumber,
          admitted_at: new Date().toISOString(),
          assigned_doctor: profileId,
          reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingVisit.id)
        .select('id')
        .single();

      if (updateError || !updated) throw updateError || new Error('Failed to update visit');
      visitId = updated.id;
    } else {
      const visitCode = `ADM-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const { data: created, error: insertError } = await supabaseAdmin
        .from('visits')
        .insert({
          tenant_id: tenantId,
          facility_id: facilityId,
          patient_id: patientId,
          created_by: profileId,
          provider: 'Admission',
          visit_date: new Date().toISOString().split('T')[0],
          visit_code: visitCode,
          reason,
          status: 'admitted',
        })
        .select('id')
        .single();

      if (insertError || !created) throw insertError || new Error('Failed to create visit');
      visitId = created.id;
    }

    if (notes) {
      await supabaseAdmin.from('visit_narratives').insert({
        tenant_id: tenantId,
        visit_id: visitId,
        patient_id: patientId,
        authored_by: profileId,
        narrative_type: 'admission_note',
        narrative_text: notes,
        locale: 'en',
      });
    }

    if (tenantId) {
      await recordAuditEvent({
        action: 'admit_patient',
        eventType: 'update',
        entityType: 'visit',
        entityId: visitId,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { ward_id: wardId, bed_number: bedNumber },
      });
    }

    return res.json({ visitId });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ error: error.message || 'Failed to admit patient' });
  }
});

router.post('/discharge', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const payload = dischargeSchema.parse(req.body);

    const { error: visitError } = await supabaseAdmin
      .from('visits')
      .update({
        status: 'completed',
        discharge_date: new Date().toISOString().split('T')[0],
        discharge_time: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', payload.visitId)
      .eq('facility_id', facilityId);

    if (visitError) throw visitError;

    await supabaseAdmin.from('visit_narratives').insert({
      tenant_id: tenantId,
      visit_id: payload.visitId,
      patient_id: payload.patientId,
      authored_by: profileId,
      narrative_type: 'discharge_summary',
      narrative_text: payload.dischargeSummary,
      locale: 'en',
      is_signed: true,
      signed_by: profileId,
      signed_at: new Date().toISOString(),
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'discharge_patient',
        eventType: 'update',
        entityType: 'visit',
        entityId: payload.visitId,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ error: error.message || 'Failed to discharge patient' });
  }
});

export default router;
