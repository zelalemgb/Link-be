import { supabaseAdmin } from '../config/supabase';
import { PAYMENT_STATUS } from '../../shared/contracts/payment';

export type PaymentType = 'cash' | 'insurance' | 'credit' | 'free';

export type Dept = 'Pharmacy' | 'Lab' | 'Imaging' | 'Consultation' | 'Procedures' | 'OPD';

export type BillItem = {
  id: string;
  label: string;
  dept: Dept;
  qty: number;
  price: number;
  payment: PaymentType;
  itemType: 'medication' | 'lab_test' | 'imaging' | 'service';
  createdAt?: string;
  referenceId?: string;
  insuranceProviderId?: string | null;
  insuranceProviderName?: string | null;
  insurancePolicyNumber?: string | null;
  creditorId?: string | null;
  creditorName?: string | null;
  programId?: string | null;
  programName?: string | null;
  priceSource?: 'order' | 'service_fallback' | 'missing';
  linkedServiceName?: string | null;
  missingPrice?: boolean;
};

export type BillPatient = {
  id: string;
  name: string;
  age: number;
  sex: 'Male' | 'Female';
  waitMinutes: number;
  status: 'All' | 'Today';
  defaultPayment?: PaymentType;
  visitId: string;
  visitCode?: string | null;
  doctor?: string;
  items: BillItem[];
  patientId: string;
  facilityId: string;
  createdAt: string;
  isCritical?: boolean;
  routing_status?: 'completed' | 'awaiting_routing' | 'routing_in_progress';
  suggested_next_stage?: string;
};

export type DailyCollections = {
  cash: number;
  insurance: number;
  credit: number;
  total: number;
};

const deriveJourneyStage = (visitData?: {
  journey_timeline?: any;
  journey_stage?: string | null;
  current_journey_stage?: string | null;
  status?: string | null;
}) => {
  if (!visitData) return undefined;
  if (visitData.current_journey_stage) return visitData.current_journey_stage;
  if (visitData.journey_stage) return visitData.journey_stage;

  const timeline = visitData.journey_timeline;
  if (timeline && typeof timeline === 'object' && Array.isArray(timeline.stages) && timeline.stages.length > 0) {
    const lastStage = timeline.stages[timeline.stages.length - 1];
    if (lastStage?.stage) return lastStage.stage;
  }

  const status = (visitData.status || '').toLowerCase();
  const statusMap: Record<string, string> = {
    registered: 'registered',
    paying_consultation: 'paying_consultation',
    at_triage: 'at_triage',
    vitals_taken: 'vitals_taken',
    with_nurse: 'at_triage',
    with_doctor: 'with_doctor',
    paying_diagnosis: 'paying_diagnosis',
    at_lab: 'at_lab',
    at_imaging: 'at_imaging',
    paying_pharmacy: 'paying_pharmacy',
    at_pharmacy: 'at_pharmacy',
    admitted: 'admitted',
    discharged: 'discharged',
  };

  return statusMap[status] || 'registered';
};

export async function fetchPendingBills(facilityId: string): Promise<BillPatient[]> {
  const { data: awaitingRoutingVisits } = await supabaseAdmin
    .from('visits')
    .select('id')
    .eq('facility_id', facilityId)
    .eq('routing_status', 'awaiting_routing');

  const awaitingRoutingVisitIds = (awaitingRoutingVisits || []).map((v: any) => v.id);

  const [
    { data: labServices, error: labServicesError },
    { data: unpaidMeds, error: medsError },
    { data: unpaidLabs, error: labsError },
    { data: unpaidImaging, error: imagingError },
    { data: unpaidServices, error: servicesError },
    { data: visitsWithoutPayment, error: visitsError },
    { data: awaitingRoutingMeds },
    { data: awaitingRoutingLabs },
    { data: awaitingRoutingImaging },
    { data: awaitingRoutingServices },
    { data: awaitingRoutingVisitsData },
  ] = await Promise.all([
    supabaseAdmin
      .from('medical_services')
      .select(`
        id,
        name,
        price,
        lab_test_master:lab_test_master_id (
          id,
          test_code
        )
      `)
      .eq('facility_id', facilityId)
      .eq('category', 'Laboratory')
      .eq('is_active', true),
    supabaseAdmin
      .from('medication_orders')
      .select(
        `
        id,
        visit_id,
        medication_name,
        dosage,
        quantity,
        amount,
        payment_mode,
        payment_status,
        ordered_at,
        created_at,
        visits!inner(
          id,
          visit_code,
          facility_id,
          patient_id,
          created_at,
          journey_timeline,
          routing_status,
          status,
          insurance_policy_number,
          patients!left(
            id,
            full_name,
            age,
            gender
          ),
          users!visits_assigned_doctor_fkey(
            id,
            name
          )
        )
        `
      )
      .in('payment_status', [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PARTIAL])
      .or('sent_outside.is.null,sent_outside.eq.false')
      .eq('visits.facility_id', facilityId),
    supabaseAdmin
      .from('lab_orders')
      .select(
        `
        id,
        visit_id,
        test_name,
        amount,
        payment_mode,
        payment_status,
        sent_outside,
        ordered_at,
        created_at,
        visits!inner(
          id,
          visit_code,
          facility_id,
          patient_id,
          created_at,
          journey_timeline,
          routing_status,
          status,
          insurance_policy_number,
          patients!left(
            id,
            full_name,
            age,
            gender
          ),
          users!visits_assigned_doctor_fkey(
            id,
            name
          )
        )
        `
      )
      .in('payment_status', [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PARTIAL])
      .or('sent_outside.is.null,sent_outside.eq.false')
      .eq('visits.facility_id', facilityId),
    supabaseAdmin
      .from('imaging_orders')
      .select(
        `
        id,
        visit_id,
        study_name,
        amount,
        payment_mode,
        payment_status,
        sent_outside,
        ordered_at,
        created_at,
        visits!inner(
          id,
          visit_code,
          facility_id,
          patient_id,
          created_at,
          journey_timeline,
          routing_status,
          status,
          insurance_policy_number,
          patients!left(
            id,
            full_name,
            age,
            gender
          ),
          users!visits_assigned_doctor_fkey(
            id,
            name
          )
        )
        `
      )
      .in('payment_status', [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PARTIAL])
      .or('sent_outside.is.null,sent_outside.eq.false')
      .eq('visits.facility_id', facilityId),
    supabaseAdmin
      .from('billing_items')
      .select(
        `
        id,
        visit_id,
        service_id,
        quantity,
        unit_price,
        total_amount,
        payment_mode,
        payment_status,
        created_at,
        medical_services(
          id,
          name,
          category
        ),
        visits!inner(
          id,
          visit_code,
          facility_id,
          patient_id,
          created_at,
          consultation_payment_type,
          journey_timeline,
          routing_status,
          status,
          insurance_policy_number,
          patients!left(
            id,
            full_name,
            age,
            gender
          ),
          users!visits_assigned_doctor_fkey(
            id,
            name
          )
        )
        `
      )
      .in('payment_status', [PAYMENT_STATUS.UNPAID, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PARTIAL])
      .eq('visits.facility_id', facilityId),
    supabaseAdmin
      .from('visits')
      .select(
        `
        id,
        patient_id,
        fee_paid,
        consultation_payment_type,
        assigned_doctor,
        created_at,
        visit_code,
        facility_id,
        journey_timeline,
        status,
        insurance_policy_number,
        routing_status,
        patients!left(
          id,
          full_name,
          age,
          gender
        ),
        users!visits_assigned_doctor_fkey(
          id,
          name
        )
        `
      )
      .eq('facility_id', facilityId)
      .neq('status', 'discharged')
      .neq('status', 'cancelled'),
    awaitingRoutingVisitIds.length > 0
      ? supabaseAdmin
          .from('medication_orders')
          .select(`
            id, visit_id, medication_name, dosage, quantity, amount,
            payment_mode, payment_status, ordered_at, created_at,
            visits!inner(
              id, visit_code, facility_id, patient_id, created_at, journey_timeline,
              routing_status, status, insurance_policy_number,
              patients!left(id, full_name, age, gender),
              users!visits_assigned_doctor_fkey(id, name)
            )
          `)
          .in('visit_id', awaitingRoutingVisitIds)
          .or('sent_outside.is.null,sent_outside.eq.false')
      : Promise.resolve({ data: null }),
    awaitingRoutingVisitIds.length > 0
      ? supabaseAdmin
          .from('lab_orders')
          .select(`
            id, visit_id, test_name, amount, payment_mode, payment_status,
            sent_outside, ordered_at, created_at,
            visits!inner(
              id, visit_code, facility_id, patient_id, created_at, journey_timeline,
              routing_status, status, insurance_policy_number,
              patients!left(id, full_name, age, gender),
              users!visits_assigned_doctor_fkey(id, name)
            )
          `)
          .in('visit_id', awaitingRoutingVisitIds)
          .or('sent_outside.is.null,sent_outside.eq.false')
      : Promise.resolve({ data: null }),
    awaitingRoutingVisitIds.length > 0
      ? supabaseAdmin
          .from('imaging_orders')
          .select(`
            id, visit_id, study_name, amount, payment_mode, payment_status,
            sent_outside, ordered_at, created_at,
            visits!inner(
              id, visit_code, facility_id, patient_id, created_at, journey_timeline,
              routing_status, status, insurance_policy_number,
              patients!left(id, full_name, age, gender),
              users!visits_assigned_doctor_fkey(id, name)
            )
          `)
          .in('visit_id', awaitingRoutingVisitIds)
          .or('sent_outside.is.null,sent_outside.eq.false')
      : Promise.resolve({ data: null }),
    awaitingRoutingVisitIds.length > 0
      ? supabaseAdmin
          .from('billing_items')
          .select(`
            id, visit_id, service_id, quantity, unit_price, total_amount,
            payment_mode, payment_status, created_at,
            medical_services(id, name, category),
            visits!inner(
              id, visit_code, facility_id, patient_id, created_at, consultation_payment_type,
              journey_timeline, routing_status, status, insurance_policy_number,
              patients!left(id, full_name, age, gender),
              users!visits_assigned_doctor_fkey(id, name)
            )
          `)
          .in('visit_id', awaitingRoutingVisitIds)
      : Promise.resolve({ data: null }),
    awaitingRoutingVisitIds.length > 0
      ? supabaseAdmin
          .from('visits_with_current_stage')
          .select(`
            id, visit_code, patient_id, fee_paid, consultation_payment_type,
            assigned_doctor, created_at, facility_id, journey_timeline,
            current_journey_stage, insurance_policy_number, routing_status,
            patients!left(id, full_name, age, gender),
            users!visits_assigned_doctor_fkey(id, name)
          `)
          .in('id', awaitingRoutingVisitIds)
      : Promise.resolve({ data: null }),
  ]);

  const labServiceByCode = new Map<string, { price: number; serviceId: string; serviceName: string }>();

  (labServices || []).forEach((svc: any) => {
    const code = svc.lab_test_master?.test_code?.toUpperCase();
    if (code) {
      labServiceByCode.set(code, {
        price: svc.price,
        serviceId: svc.id,
        serviceName: svc.name,
      });
    }
  });

  if (medsError) console.error('Error fetching medication orders:', medsError);
  if (labsError) console.error('Error fetching lab orders:', labsError);
  if (imagingError) console.error('Error fetching imaging orders:', imagingError);
  if (servicesError) console.error('Error fetching services:', servicesError);
  if (visitsError) console.error('Error fetching visits:', visitsError);

  const allMeds = [...(unpaidMeds || []), ...(awaitingRoutingMeds || [])];
  const allLabs = [...(unpaidLabs || []), ...(awaitingRoutingLabs || [])];
  const allImaging = [...(unpaidImaging || []), ...(awaitingRoutingImaging || [])];
  const allServices = [...(unpaidServices || []), ...(awaitingRoutingServices || [])];
  const allVisits = [...(visitsWithoutPayment || []), ...(awaitingRoutingVisitsData || [])];

  const filteredMeds = Array.from(new Map(allMeds.map((m: any) => [m.id, m])).values());
  const filteredLabs = Array.from(new Map(allLabs.map((l: any) => [l.id, l])).values());
  const filteredImaging = Array.from(new Map(allImaging.map((i: any) => [i.id, i])).values());
  const filteredServices = Array.from(new Map(allServices.map((s: any) => [s.id, s])).values());
  const filteredVisits = Array.from(new Map(allVisits.map((v: any) => [v.id, v])).values());

  const visitIds = (visitsWithoutPayment || []).map((v: any) => v.id);
  let paymentsData: any[] = [];
  if (visitIds.length > 0) {
    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('visit_id, payment_status')
      .in('visit_id', visitIds);
    paymentsData = payments || [];
  }

  const paymentStatusMap = new Map(paymentsData.map((p: any) => [p.visit_id, p.payment_status]));

  const allVisitIds = new Set<string>();
  filteredMeds.forEach((med: any) => allVisitIds.add(med.visit_id));
  filteredLabs.forEach((lab: any) => allVisitIds.add(lab.visit_id));
  filteredImaging.forEach((img: any) => allVisitIds.add(img.visit_id));
  filteredServices.forEach((svc: any) => allVisitIds.add(svc.visit_id));
  filteredVisits.forEach((visit: any) => allVisitIds.add(visit.id));

  const { data: visitCreationTimes } = await supabaseAdmin
    .from('visits')
    .select('id, created_at')
    .in('id', Array.from(allVisitIds));

  const visitCreationMap = new Map((visitCreationTimes || []).map((v: any) => [v.id, v.created_at]));

  const visitOrdersMap = new Map<
    string,
    {
      lines: BillItem[];
      patient: any;
      doctor: any;
      patientId: string;
      createdAt: string;
      visitCreatedAt: string;
      routing_status?: 'completed' | 'awaiting_routing' | 'routing_in_progress';
      journey_stage?: string;
      visitCode?: string | null;
    }
  >();

  filteredMeds.forEach((med: any) => {
    if (med.payment_status === PAYMENT_STATUS.PAID) return;

    const visitData = med.visits;
    if (!visitOrdersMap.has(med.visit_id)) {
      visitOrdersMap.set(med.visit_id, {
        lines: [],
        patient: visitData?.patients,
        doctor: visitData?.users,
        patientId: visitData?.patient_id,
        createdAt: med.ordered_at || med.created_at,
        visitCreatedAt: visitCreationMap.get(med.visit_id) || visitData?.created_at || med.created_at,
        routing_status: visitData?.routing_status,
        journey_stage: deriveJourneyStage(visitData),
        visitCode: visitData?.visit_code || null,
      });
    }
    visitOrdersMap.get(med.visit_id)!.lines.push({
      id: med.id,
      label: `${med.medication_name} - ${med.dosage}`,
      dept: 'Pharmacy',
      qty: med.quantity || 1,
      price: med.amount && med.amount > 0 ? med.amount : 50,
      payment: (med.payment_mode as PaymentType) || 'cash',
      itemType: 'medication',
      createdAt: med.ordered_at || med.created_at,
      referenceId: med.id,
      insuranceProviderId:
        'insurance_provider_id' in med ? ((med as any).insurance_provider_id as string | null | undefined) ?? null : null,
      insuranceProviderName:
        'insurance_provider' in med ? ((med as any).insurance_provider as string | null | undefined) ?? null : null,
      insurancePolicyNumber: visitData?.insurance_policy_number ?? null,
      creditorId: 'creditor_id' in med ? ((med as any).creditor_id as string | null | undefined) ?? null : null,
      creditorName: null,
      programId: 'program_id' in med ? ((med as any).program_id as string | null | undefined) ?? null : null,
      programName: null,
      priceSource: 'order',
      missingPrice: false,
    });
  });

  filteredLabs.forEach((lab: any) => {
    if (lab.payment_status === PAYMENT_STATUS.PAID) return;

    const visitData = lab.visits;
    if (!visitOrdersMap.has(lab.visit_id)) {
      visitOrdersMap.set(lab.visit_id, {
        lines: [],
        patient: visitData?.patients,
        doctor: visitData?.users,
        patientId: visitData?.patient_id,
        createdAt: lab.ordered_at || lab.created_at,
        visitCreatedAt: visitCreationMap.get(lab.visit_id) || visitData?.created_at || lab.created_at,
        routing_status: visitData?.routing_status,
        journey_stage: deriveJourneyStage(visitData),
        visitCode: visitData?.visit_code || null,
      });
    }

    const normalizedCode = (lab.test_code || '').toUpperCase();
    const linkedService = normalizedCode ? labServiceByCode.get(normalizedCode) : undefined;
    const hasOrderPrice = typeof lab.amount === 'number' && lab.amount > 0;
    const fallbackPrice = linkedService?.price ?? null;
    const finalPrice = hasOrderPrice ? lab.amount : fallbackPrice ?? 0;
    const priceSource: BillItem['priceSource'] = hasOrderPrice
      ? 'order'
      : linkedService
      ? 'service_fallback'
      : 'missing';

    visitOrdersMap.get(lab.visit_id)!.lines.push({
      id: lab.id,
      label: lab.test_name,
      dept: 'Lab',
      qty: 1,
      price: finalPrice,
      payment: (lab.payment_mode as PaymentType) || 'cash',
      itemType: 'lab_test',
      createdAt: lab.ordered_at || lab.created_at,
      referenceId: lab.id,
      insuranceProviderId:
        'insurance_provider_id' in lab ? ((lab as any).insurance_provider_id as string | null | undefined) ?? null : null,
      insuranceProviderName:
        'insurance_provider' in lab ? ((lab as any).insurance_provider as string | null | undefined) ?? null : null,
      insurancePolicyNumber: visitData?.insurance_policy_number ?? null,
      creditorId: 'creditor_id' in lab ? ((lab as any).creditor_id as string | null | undefined) ?? null : null,
      creditorName: null,
      programId: 'program_id' in lab ? ((lab as any).program_id as string | null | undefined) ?? null : null,
      programName: null,
      priceSource,
      linkedServiceName: linkedService?.serviceName ?? null,
      missingPrice: priceSource === 'missing',
    });
  });

  filteredImaging.forEach((img: any) => {
    if (img.payment_status === PAYMENT_STATUS.PAID) return;

    const visitData = img.visits;
    if (!visitOrdersMap.has(img.visit_id)) {
      visitOrdersMap.set(img.visit_id, {
        lines: [],
        patient: visitData?.patients,
        doctor: visitData?.users,
        patientId: visitData?.patient_id,
        createdAt: img.ordered_at || img.created_at,
        visitCreatedAt: visitCreationMap.get(img.visit_id) || visitData?.created_at || img.created_at,
        routing_status: visitData?.routing_status,
        journey_stage: deriveJourneyStage(visitData),
        visitCode: visitData?.visit_code || null,
      });
    }

    visitOrdersMap.get(img.visit_id)!.lines.push({
      id: img.id,
      label: img.study_name,
      dept: 'Imaging',
      qty: 1,
      price: img.amount && img.amount > 0 ? img.amount : 150,
      payment: (img.payment_mode as PaymentType) || 'cash',
      itemType: 'imaging',
      createdAt: img.ordered_at || img.created_at,
      referenceId: img.id,
      insuranceProviderId:
        'insurance_provider_id' in img ? ((img as any).insurance_provider_id as string | null | undefined) ?? null : null,
      insuranceProviderName:
        'insurance_provider' in img ? ((img as any).insurance_provider as string | null | undefined) ?? null : null,
      insurancePolicyNumber: visitData?.insurance_policy_number ?? null,
      creditorId: 'creditor_id' in img ? ((img as any).creditor_id as string | null | undefined) ?? null : null,
      creditorName: null,
      programId: 'program_id' in img ? ((img as any).program_id as string | null | undefined) ?? null : null,
      programName: null,
      priceSource: 'order',
      missingPrice: false,
    });
  });

  filteredServices.forEach((bi: any) => {
    if (bi.payment_status === PAYMENT_STATUS.PAID) return;

    const visitData = bi.visits;
    const service = bi.medical_services;

    const type = (visitData?.consultation_payment_type || 'paying').toLowerCase();
    const isNonPaying = ['free', 'credit', 'insured', 'insurance'].includes(type);
    const category = (service?.category || '').toLowerCase();
    const name = (service?.name || '').toLowerCase();
    const isConsultationService = category.includes('consult') || category.includes('opd') || name.includes('consult');

    if (isNonPaying && isConsultationService) {
      return;
    }

    if (!visitOrdersMap.has(bi.visit_id)) {
      visitOrdersMap.set(bi.visit_id, {
        lines: [],
        patient: visitData?.patients,
        doctor: visitData?.users,
        patientId: visitData?.patient_id,
        createdAt: bi.created_at,
        visitCreatedAt: visitCreationMap.get(bi.visit_id) || visitData?.created_at || bi.created_at,
        routing_status: visitData?.routing_status,
        journey_stage: deriveJourneyStage(visitData),
        visitCode: visitData?.visit_code || null,
      });
    }

    let dept: Dept = 'Consultation';
    if (category.includes('lab')) dept = 'Lab';
    else if (category.includes('imag')) dept = 'Imaging';
    else if (category.includes('pharm')) dept = 'Pharmacy';
    else if (category.includes('procedure')) dept = 'Procedures';
    else if (category.includes('opd')) dept = 'OPD';

    visitOrdersMap.get(bi.visit_id)!.lines.push({
      id: bi.id,
      label: service?.name || 'Service',
      dept,
      qty: bi.quantity || 1,
      price: bi.unit_price ?? bi.total_amount ?? 0,
      payment: (bi.payment_mode as PaymentType) || 'cash',
      itemType: 'service',
      createdAt: bi.created_at,
      referenceId: bi.id,
      insuranceProviderId: null,
      insuranceProviderName: null,
      insurancePolicyNumber: visitData?.insurance_policy_number ?? null,
      creditorId: null,
      creditorName: null,
      programId: null,
      programName: null,
      priceSource: 'order',
      missingPrice: false,
    });
  });

  filteredVisits.forEach((visit: any) => {
    const type = (visit.consultation_payment_type || 'cash').toLowerCase();
    const isFreeVisit = type === 'free';
    const isAwaitingRouting = visit.routing_status === 'awaiting_routing';

    if (!isAwaitingRouting && isFreeVisit) {
      return;
    }

    const paymentStatus = paymentStatusMap.get(visit.id);
    const hasNoPayment = !paymentStatus;
    const isPending = paymentStatus === 'pending';

    if (isAwaitingRouting || hasNoPayment || isPending) {
      if (!visitOrdersMap.has(visit.id)) {
        visitOrdersMap.set(visit.id, {
          lines: [],
          patient: visit.patients,
          doctor: visit.users,
          patientId: visit.patient_id,
          createdAt: visit.created_at,
          visitCreatedAt: visitCreationMap.get(visit.id) || visit.created_at,
          routing_status: visit.routing_status,
          journey_stage: deriveJourneyStage(visit),
          visitCode: visit.visit_code || null,
        });
      }
    }
  });

  const missingVisitIds = Array.from(visitOrdersMap.entries())
    .filter(([_, v]) => !v.patient?.full_name)
    .map(([visitId]) => visitId);

  if (missingVisitIds.length > 0) {
    const { data: patientInfos, error: patientInfoError } = await supabaseAdmin.rpc(
      'get_visit_patient_info',
      { visit_ids: missingVisitIds as any }
    );
    if (!patientInfoError && patientInfos) {
      const rows = patientInfos as Array<{
        visit_id: string;
        patient_id: string;
        full_name: string;
        age: number;
        gender: string;
      }>;
      const byVisit = new Map(rows.map((r) => [r.visit_id, r]));
      missingVisitIds.forEach((visitId) => {
        const r = byVisit.get(visitId);
        if (r) {
          const current = visitOrdersMap.get(visitId);
          if (current) {
            current.patient = {
              id: r.patient_id,
              full_name: r.full_name,
              age: r.age,
              gender: r.gender,
            };
            current.patientId = r.patient_id;
          }
        }
      });
    }
  }

  const pendingBills: BillPatient[] = Array.from(visitOrdersMap.entries())
    .filter(([_, data]) => {
      const isAwaitingRouting = data.routing_status === 'awaiting_routing';
      const hasBillableItems = data.lines.length > 0;
      const isConsultationPaymentStage = data.journey_stage === 'paying_consultation';
      return isAwaitingRouting || hasBillableItems || isConsultationPaymentStage;
    })
    .map(([visitId, data]) => {
      const visitCreationTime = new Date(data.visitCreatedAt).getTime();
      const waitMinutes = Math.floor((Date.now() - visitCreationTime) / (1000 * 60));

      const lineDates = data.lines
        .map((line) => (line.createdAt ? new Date(line.createdAt).getTime() : null))
        .filter((t): t is number => t !== null && !isNaN(t));
      const newestLineDate = lineDates.length > 0 ? Math.max(...lineDates) : null;
      const effectiveCreatedAt = newestLineDate ? new Date(newestLineDate).toISOString() : data.visitCreatedAt;

      return {
        id: visitId,
        visitId,
        visitCode: data.visitCode || null,
        name: data.patient?.full_name || 'Unknown',
        age: data.patient?.age || 0,
        sex: data.patient?.gender === 'male' ? 'Male' : 'Female',
        waitMinutes,
        status: 'All',
        doctor: data.doctor?.name || 'N/A',
        items: data.lines,
        patientId: data.patientId,
        facilityId,
        createdAt: effectiveCreatedAt,
        routing_status: data.routing_status,
        suggested_next_stage: data.journey_stage,
      };
    });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  pendingBills.sort((a, b) => {
    const aCreatedDate = new Date(a.createdAt);
    const bCreatedDate = new Date(b.createdAt);
    aCreatedDate.setHours(0, 0, 0, 0);
    bCreatedDate.setHours(0, 0, 0, 0);

    const aIsToday = aCreatedDate.getTime() === today.getTime();
    const bIsToday = bCreatedDate.getTime() === today.getTime();

    if (aIsToday && !bIsToday) return -1;
    if (!aIsToday && bIsToday) return 1;

    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return pendingBills;
}

export async function fetchDailyCollections(facilityId: string): Promise<DailyCollections> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const { data: paymentLineItems } = await supabaseAdmin
    .from('payment_line_items')
    .select(`
      subtotal,
      payment_method,
      created_at,
      payments!inner(
        facility_id,
        payment_status,
        payment_transactions!inner(
          transaction_date
        )
      )
    `)
    .eq('payments.payment_status', PAYMENT_STATUS.PAID)
    .eq('payments.facility_id', facilityId)
    .gte('payments.payment_transactions.transaction_date', todayISO);

  const allPaidItems = (paymentLineItems || []).map((item: any) => ({
    amount: item.subtotal || 0,
    payment_mode: item.payment_method,
  }));

  const cash = allPaidItems
    .filter((item: any) => item.payment_mode === 'cash')
    .reduce((sum: number, item: any) => sum + item.amount, 0);

  const insurance = allPaidItems
    .filter((item: any) => item.payment_mode === 'insurance')
    .reduce((sum: number, item: any) => sum + item.amount, 0);

  const credit = allPaidItems
    .filter((item: any) => item.payment_mode === 'credit')
    .reduce((sum: number, item: any) => sum + item.amount, 0);

  const total = cash + insurance + credit;

  return { cash, insurance, credit, total };
}

export async function fetchPaidPatients(facilityId: string): Promise<BillPatient[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: payments, error } = await supabaseAdmin
    .from('payments')
    .select(`
      id,
      visit_id,
      patient_id,
      facility_id,
      created_at,
      payment_status,
      visits!inner(
        id,
        visit_code,
        created_at,
        insurance_policy_number,
        routing_status,
        status,
        patients!left(
          id,
          full_name,
          age,
          gender
        ),
        users!visits_assigned_doctor_fkey(
          id,
          name
        )
      ),
      payment_line_items (
        id,
        item_type,
        item_reference_id,
        description,
        unit_price,
        quantity,
        subtotal,
        payment_method,
        created_at
      )
    `)
    .eq('facility_id', facilityId)
    .eq('payment_status', PAYMENT_STATUS.PAID)
    .gte('created_at', startOfDay.toISOString())
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  if (!payments || payments.length === 0) return [];

  return payments.map((payment: any) => {
    const visit = payment.visits;
    const patient = visit?.patients;
    const doctor = visit?.users;
    const visitId = payment.visit_id;

    const billItems: BillItem[] = (payment.payment_line_items || []).map((lineItem: any) => {
      let dept: Dept = 'Consultation';
      const itemTypeLower = (lineItem.item_type || '').toLowerCase();
      if (itemTypeLower.includes('lab')) dept = 'Lab';
      else if (itemTypeLower.includes('imag')) dept = 'Imaging';
      else if (itemTypeLower.includes('med')) dept = 'Pharmacy';
      else if (itemTypeLower.includes('proc')) dept = 'Procedures';

      return {
        id: lineItem.id,
        label: lineItem.description,
        dept,
        qty: lineItem.quantity,
        price: lineItem.unit_price,
        payment: lineItem.payment_method as PaymentType,
        itemType: itemTypeLower === 'consultation' ? 'service' : (lineItem.item_type as any),
        createdAt: lineItem.created_at,
        referenceId: lineItem.item_reference_id || undefined,
        insurancePolicyNumber: visit?.insurance_policy_number ?? null,
        priceSource: 'order',
        missingPrice: false,
      };
    });

    const createdAt = visit?.created_at || payment.created_at || new Date().toISOString();
    const visitCreationTime = new Date(createdAt).getTime();
    const waitMinutes = Math.floor((Date.now() - visitCreationTime) / (1000 * 60));

    return {
      id: visitId,
      visitId,
      visitCode: visit?.visit_code || null,
      name: patient?.full_name || 'Unknown',
      age: patient?.age || 0,
      sex: patient?.gender === 'male' ? 'Male' : 'Female',
      waitMinutes,
      status: 'Today',
      doctor: doctor?.name || 'N/A',
      items: billItems,
      patientId: payment.patient_id,
      facilityId,
      createdAt,
      routing_status: visit?.routing_status,
      suggested_next_stage: deriveJourneyStage(visit),
    };
  });
}

export async function fetchAwaitingRoutingPatients(facilityId: string): Promise<BillPatient[]> {
  const { data, error } = await supabaseAdmin.rpc('get_patients_awaiting_routing', {
    p_facility_id: facilityId,
  });

  if (error) throw error;

  return (data || []).map((row: any) => {
    const items: BillItem[] = (row.items || []).map((item: any) => {
      let dept: Dept = 'Consultation';
      if (item.dept === 'Lab') dept = 'Lab';
      else if (item.dept === 'Imaging') dept = 'Imaging';
      else if (item.dept === 'Pharmacy') dept = 'Pharmacy';
      else if (item.dept === 'Procedures') dept = 'Procedures';
      else if (item.dept === 'OPD') dept = 'OPD';
      else if (item.dept === 'Service' || item.type === 'service') dept = 'Consultation';

      return {
        id: item.id,
        label: item.name,
        dept,
        qty: 1,
        price: item.amount || 0,
        payment: 'cash',
        itemType: item.type as 'medication' | 'lab_test' | 'imaging' | 'service',
        referenceId: item.id,
        priceSource: item.amount && item.amount > 0 ? 'order' : 'missing',
        missingPrice: !(item.amount && item.amount > 0),
      };
    });

    return {
      id: row.visit_id,
      visitId: row.visit_id,
      visitCode: row.visit_code || null,
      patientId: row.patient_id,
      name: row.patient_name,
      age: row.patient_age,
      sex: row.patient_sex as 'Male' | 'Female',
      items,
      waitMinutes: row.wait_minutes || 0,
      status: 'Today',
      facilityId,
      createdAt: row.created_at,
      routing_status: 'awaiting_routing',
      suggested_next_stage: row.suggested_next_stage,
    };
  }) as BillPatient[];
}
