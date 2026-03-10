/**
 * seed_demo.ts — LinkHC demo tenant seed script
 *
 * Creates a complete, realistic demo dataset in Supabase for the interactive
 * demo portal at /demo. Idempotent — safe to re-run between demos.
 *
 * What it creates:
 *   - Demo facility: Kara Kore Health Center
 *   - Demo patient: Tigist Alemu (28F)
 *   - 1 pre_triage_requests record (AT SMS intake, urgency=urgent)
 *   - 1 community_notes record (HEW home visit, 7 days ago)
 *   - 1 triage visit + vitals (Temp 38.4°C, SpO2 93%, BP 138/88)
 *
 * Usage:
 *   npx tsx scripts/seed_demo.ts
 *   npx tsx scripts/seed_demo.ts --reset   # wipe clinical records then re-seed
 *
 * Environment — reads in this order (first wins):
 *   1. Shell environment variables
 *   2. link-be/.env
 *   3. ../.env.local  (root workspace — where VITE_SUPABASE_URL lives)
 *
 * Required variables:
 *   SUPABASE_URL or VITE_SUPABASE_URL   — your project URL
 *   SUPABASE_SERVICE_ROLE_KEY           — from Supabase dashboard → Settings → API
 *
 * Quick run with explicit values:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   npx tsx scripts/seed_demo.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

// Load env files — order matters (later files don't override earlier ones)
config({ path: resolve(__dirname, '../.env') });           // link-be/.env
config({ path: resolve(__dirname, '../../.env.local') }); // root .env.local (VITE_ vars)

const SUPABASE_URL         = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// ─── Preflight checks ─────────────────────────────────────────────────────────

if (!SUPABASE_URL || SUPABASE_URL.includes('127.0.0.1') || SUPABASE_URL.includes('localhost')) {
  console.error(`
❌  SUPABASE_URL is missing or points to localhost.
    Set it to your production project URL:

      SUPABASE_URL=https://qxihedrgltophafkuasa.supabase.co \\
      SUPABASE_SERVICE_ROLE_KEY=eyJ... \\
      npx tsx scripts/seed_demo.ts

    Or add SUPABASE_URL to link-be/.env
`);
  process.exit(1);
}

if (!SUPABASE_SERVICE_KEY || SUPABASE_SERVICE_KEY === 'test-service-role-key') {
  console.error(`
❌  SUPABASE_SERVICE_ROLE_KEY is missing or is still the placeholder value.

    Get the real key from:
      Supabase Dashboard → your project → Settings → API → service_role key

    Then run:
      SUPABASE_SERVICE_ROLE_KEY=eyJ... npx tsx scripts/seed_demo.ts
`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Deterministic IDs (idempotent re-runs) ───────────────────────────────────

const IDS = {
  facility:      'demo-facility-zelalem-001',
  patient:       'demo-patient-tigist-001',
  preTriage:     'demo-pretriage-001',
  communityNote: 'demo-community-note-001',
  triageVisit:   'demo-triage-visit-001',
  triageVitals:  'demo-triage-vitals-001',
};

// Africa's Talking short-code registered to Zelalem Hospital
// In AT sandbox this is the default shortcode; update for production
const AT_SHORT_CODE = process.env.AT_SHORT_CODE ?? '10727';

const NOW   = new Date().toISOString();
const AGO7D = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const AGO3H = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const reset = process.argv.includes('--reset');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsert(table: string, data: object, conflict = 'id') {
  const { error } = await supabase
    .from(table)
    .upsert(data, { onConflict: conflict });
  if (error) {
    console.warn(`  ⚠️  ${table}: ${error.message}`);
  } else {
    console.log(`  ✅  ${table}`);
  }
}

async function deleteDemo() {
  console.log('\n🗑️  Removing previous demo clinical records…');
  for (const [table, id] of [
    ['visit_vitals',        IDS.triageVitals],
    ['visits',              IDS.triageVisit],
    ['community_notes',     IDS.communityNote],
    ['pre_triage_requests', IDS.preTriage],
  ] as const) {
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) console.warn(`  ⚠️  ${table}: ${error.message}`);
    else       console.log(`  🗑️  ${table}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  LinkHC Demo Seed Script\n');
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Reset:    ${reset}\n`);

  if (reset) await deleteDemo();

  // 1. Facility — Zelalem Hospital (tagged to AT short-code for SMS intake)
  console.log('📍  Facility…');
  await upsert('facilities', {
    id:            IDS.facility,
    name:          'Zelalem Hospital',
    type:          'hospital',
    region:        'Addis Ababa',
    zone:          'Addis Ababa',
    woreda:        'Kirkos',
    phone:         '+251113456789',
    at_short_code: AT_SHORT_CODE,
    is_active:     true,
    created_at:    NOW,
    updated_at:    NOW,
  });

  // 2. Patient: Tigist Alemu
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
    created_at:    NOW,
    updated_at:    NOW,
  });

  // 3. AT SMS pre-triage (3 hours ago, urgency=urgent, routed via at_short_code)
  console.log('\n📱  Pre-triage: AT SMS intake…');
  await upsert('pre_triage_requests', {
    id:                  IDS.preTriage,
    created_at:          AGO3H,
    from_phone:          '+251911000001',
    to_short_code:       AT_SHORT_CODE,
    raw_text:            'qoqila dukkuba hafuura dhorkaa',
    parsed_symptoms:     ['fever', 'headache', 'breathing'],
    recommended_urgency: 'urgent',
    ai_summary:          'Patient reported fever, headache, and difficulty breathing. Urgency: URGENT — recommend same-day visit.',
    reply_text:          "Har'a hospitaalaa dhaqaa. Mallattooleen kee hatattamaa mirkaneessa. (Your symptoms are urgent. Please come to Zelalem Hospital today.)",
    reply_sent:          true,
    reply_sent_at:       new Date(Date.now() - 3 * 60 * 60 * 1000 + 15000).toISOString(),
    linked_patient_id:   IDS.patient,
    linked_visit_id:     null,
    status:              'pending',
    facility_id:         IDS.facility,
  });

  // 4. HEW community note (7 days ago)
  console.log('\n🌿  Community note: HEW home visit…');
  await upsert('community_notes', {
    id:            IDS.communityNote,
    created_at:    AGO7D,
    patient_id:    IDS.patient,
    visit_type:    'home_visit',
    text:          'Visited Tigist at her home. Persistent cough for 3 days. Observed rapid breathing at rest (~24/min). Advised to visit health center. Follow-up scheduled in one week.',
    danger_signs:  { breathing_problem: true, fever: true },
    follow_up_due: new Date().toISOString().slice(0, 10),
    visit_id:      null,
  });

  // 5. Triage visit
  console.log('\n🩺  Triage visit…');
  await upsert('visits', {
    id:              IDS.triageVisit,
    patient_id:      IDS.patient,
    facility_id:     IDS.facility,
    visit_date:      NOW,
    visit_type:      'triage',
    chief_complaint: 'Fever, difficulty breathing',
    status:          'triage_complete',
    notes:           'Triage urgency: urgent\nSpO2 93% — respiratory concern. BP borderline elevated.',
    created_at:      NOW,
    updated_at:      NOW,
  });

  // 6. Triage vitals
  console.log('\n💉  Triage vitals…');
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
  console.log(`
✅  Demo seed complete!

─────────────────────────────────────────────────────────
  Supabase:     ${SUPABASE_URL}
  Demo patient: Tigist Alemu  (+251911000001)
  Facility:     Zelalem Hospital (AT short-code: ${AT_SHORT_CODE})

  Pre-seeded:
  ├─ AT SMS pre-triage  (3h ago, urgency=urgent, short-code ${AT_SHORT_CODE})
  ├─ HEW community note (7 days ago, breathing + fever flags)
  └─ Triage vitals      (SpO2 93%, Temp 38.4°C, BP 138/88)

  Live demo URL: https://linkhc.org/demo  (after deploy)
─────────────────────────────────────────────────────────
`);
}

main().catch((err) => {
  console.error('\n❌  Seed failed:', err.message);
  process.exit(1);
});
