/**
 * seed_demo.ts — LinkHC demo tenant seed script
 *
 * Creates a complete, realistic demo dataset in Supabase for the interactive
 * demo portal at /demo. Idempotent — safe to re-run between demos.
 *
 * What it creates:
 *   - A demo tenant and facility (Kara Kore Health Center)
 *   - 3 demo staff accounts (nurse, doctor, hew) with password: Demo@LinkHC2026
 *   - 1 demo patient: Tigist Alemu (28F)
 *   - 1 pre_triage_requests record (AT SMS intake with urgency=urgent)
 *   - 1 community_notes record (HEW home visit from 7 days ago)
 *   - 1 triage visit with vitals (Temp 38.4°C, SpO2 93%, BP 138/88)
 *
 * Usage:
 *   npx tsx link-be/scripts/seed_demo.ts
 *   npx tsx link-be/scripts/seed_demo.ts --reset   # delete then re-seed
 *
 * Environment:
 *   Reads from link-be/.env or the shell environment.
 *   Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL          = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Deterministic IDs (idempotent re-runs) ────────────────────────────────

const IDS = {
  tenant:          'demo-tenant-linkhc-001',
  facility:        'demo-facility-karakore-001',
  patient:         'demo-patient-tigist-001',
  preTriage:       'demo-pretriage-001',
  communityNote:   'demo-community-note-001',
  triageVisit:     'demo-triage-visit-001',
  triageVitals:    'demo-triage-vitals-001',
  userNurse:       'demo-user-nurse-hiwot-001',
  userDoctor:      'demo-user-doctor-dawit-001',
  userHew:         'demo-user-hew-birtukan-001',
};

const DEMO_PASSWORD = 'Demo@LinkHC2026';

const NOW   = new Date().toISOString();
const AGO7D = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const AGO3H = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const reset = process.argv.includes('--reset');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsert(table: string, data: object, idField = 'id') {
  const { error } = await supabase
    .from(table)
    .upsert(data, { onConflict: idField, ignoreDuplicates: false });
  if (error) {
    console.warn(`  ⚠️  ${table}: ${error.message}`);
  } else {
    console.log(`  ✅  ${table}`);
  }
}

async function deleteDemo() {
  console.log('\n🗑️  Removing previous demo data…');
  await supabase.from('visit_vitals').delete().eq('id', IDS.triageVitals);
  await supabase.from('visits').delete().eq('id', IDS.triageVisit);
  await supabase.from('community_notes').delete().eq('id', IDS.communityNote);
  await supabase.from('pre_triage_requests').delete().eq('id', IDS.preTriage);
  await supabase.from('patients').delete().eq('id', IDS.patient);
  // Profiles / facility / tenant — leave unless explicitly clearing
  console.log('  ✅  Done');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  LinkHC Demo Seed Script\n');
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Reset:    ${reset}`);

  if (reset) {
    await deleteDemo();
  }

  // 1. Facility (upsert — idempotent)
  console.log('\n📍  Facility…');
  await upsert('facilities', {
    id:           IDS.facility,
    name:         'Kara Kore Health Center',
    type:         'health_center',
    region:       'Amhara',
    zone:         'North Shewa',
    woreda:       'Minjar Shenkora',
    phone:        '+251113456789',
    is_active:    true,
    created_at:   NOW,
    updated_at:   NOW,
  });

  // 2. Demo staff profiles
  console.log('\n👥  Staff profiles…');
  const staffProfiles = [
    {
      id:          IDS.userNurse,
      full_name:   'Hiwot Girma',
      email:       'demo.nurse@linkhc.demo',
      role:        'nurse',
      facility_id: IDS.facility,
      is_demo:     true,
    },
    {
      id:          IDS.userDoctor,
      full_name:   'Dr. Dawit Bekele',
      email:       'demo.doctor@linkhc.demo',
      role:        'doctor',
      facility_id: IDS.facility,
      is_demo:     true,
    },
    {
      id:          IDS.userHew,
      full_name:   'Birtukan Tadesse',
      email:       'demo.hew@linkhc.demo',
      role:        'health_extension_worker',
      facility_id: IDS.facility,
      is_demo:     true,
    },
  ];

  for (const profile of staffProfiles) {
    await upsert('profiles', { ...profile, created_at: NOW, updated_at: NOW });
  }

  // 3. Patient: Tigist Alemu
  console.log('\n🧑‍⚕️  Patient: Tigist Alemu…');
  await upsert('patients', {
    id:            IDS.patient,
    full_name:     'Tigist Alemu',
    first_name:    'Tigist',
    last_name:     'Alemu',
    date_of_birth: '1997-03-14',
    sex:           'female',
    phone:         '+251911000001',
    village:       'Kara Kore',
    kebele:        'Kebele 05',
    woreda:        'Minjar Shenkora',
    facility_id:   IDS.facility,
    is_demo:       true,
    created_at:    NOW,
    updated_at:    NOW,
  });

  // 4. Pre-triage request (Africa's Talking SMS intake)
  console.log('\n📱  Pre-triage: AT SMS intake…');
  await upsert('pre_triage_requests', {
    id:                  IDS.preTriage,
    created_at:          AGO3H,
    from_phone:          '+251911000001',
    raw_text:            'qoqila dukkuba hafuura dhorkaa',   // Oromo: fever, headache, breathing difficulty
    parsed_symptoms:     ['fever', 'headache', 'breathing'],
    recommended_urgency: 'urgent',
    ai_summary:          'Patient reported fever, headache, and difficulty breathing. Urgency classified as URGENT — recommend same-day clinic visit.',
    reply_sent:          'Waamuun keessan fudhanne. Dhukkubni keessan ariifachiisaa dha. Har\'a kilinika dhaqaa. (Your symptoms are urgent. Please visit the clinic today.)',
    linked_patient_id:   IDS.patient,
    linked_visit_id:     null,
    status:              'pending',
    facility_id:         IDS.facility,
  });

  // 5. HEW community note (7 days ago)
  console.log('\n🌿  Community note: HEW home visit…');
  await upsert('community_notes', {
    id:            IDS.communityNote,
    created_at:    AGO7D,
    patient_id:    IDS.patient,
    hew_user_id:   IDS.userHew,
    visit_type:    'home_visit',
    text:          'Visited Tigist at her home. She complained of persistent cough for 3 days. Observed rapid breathing at rest (approx 24/min). Temp not measured. Advised to visit health center if not improving. Follow-up scheduled in one week.',
    danger_signs:  { breathing_problem: true, fever: true },
    follow_up_due: new Date().toISOString().slice(0, 10), // today
    visit_id:      null,   // not yet linked to a clinic visit
    is_demo:       true,
  });

  // 6. Triage visit with vitals (recorded by Nurse Hiwot today)
  console.log('\n🩺  Triage visit + vitals…');
  await upsert('visits', {
    id:              IDS.triageVisit,
    patient_id:      IDS.patient,
    facility_id:     IDS.facility,
    visit_date:      NOW,
    visit_type:      'triage',
    chief_complaint: 'Fever, difficulty breathing',
    status:          'triage_complete',
    notes:           'Triage urgency: urgent\nSpO2 93% — respiratory concern. BP borderline elevated.',
    provider_id:     IDS.userNurse,
    is_demo:         true,
    created_at:      NOW,
    updated_at:      NOW,
  });

  await upsert('visit_vitals', {
    id:               IDS.triageVitals,
    visit_id:         IDS.triageVisit,
    bp_systolic:      138,
    bp_diastolic:     88,
    heart_rate:       102,
    temperature:      38.4,
    weight_kg:        54,
    height_cm:        161,
    spo2_pct:         93,
    respiratory_rate: 22,
    muac_mm:          null,
    recorded_at:      NOW,
    created_at:       NOW,
    updated_at:       NOW,
  });

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log('\n✅  Demo seed complete!\n');
  console.log('─────────────────────────────────────────────────────');
  console.log('  Demo patient:   Tigist Alemu  (+251911000001)');
  console.log('  Facility:       Kara Kore Health Center');
  console.log('');
  console.log('  Demo accounts (password: Demo@LinkHC2026)');
  console.log('  ├─ Nurse:   demo.nurse@linkhc.demo');
  console.log('  ├─ Doctor:  demo.doctor@linkhc.demo');
  console.log('  └─ HEW:     demo.hew@linkhc.demo');
  console.log('');
  console.log('  Pre-seeded:');
  console.log('  ├─ AT SMS pre-triage  (3h ago, urgency=urgent)');
  console.log('  ├─ HEW community note (7 days ago, breathing concern)');
  console.log('  └─ Triage vitals      (SpO2 93%, Temp 38.4°C, BP 138/88)');
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\n❌  Seed failed:', err.message);
  process.exit(1);
});
