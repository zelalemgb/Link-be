# LinkHC Database — Comprehensive Healthcare Standards Review
**Date:** 2026-03-05
**Schema state:** Post FIX_01 through FIX_19 (all applied)
**Standards evaluated:** HL7 FHIR R4, ICD-10/11, SNOMED CT, LOINC, HIPAA, JCI, NHIA (Ethiopia), WHO/DHIS2

---

## Executive Summary

After 19 targeted fix migrations, the LinkHC database has achieved a strong healthcare-grade baseline. All critical patient-safety controls (drug-allergy hard stops, DDI checks, PHI audit triggers, referential integrity) are now in place. The schema is well-aligned with FHIR R4 core resources, supports multi-tenancy correctly, and includes Wave 2 offline-sync primitives.

**The remaining gaps are not blockers for safe clinical operation** — they are enhancements toward full interoperability, regulatory reporting, and advanced clinical decision support.

### Overall Scorecard

| Domain | Pre-Fix Score | Post-Fix Score | Status |
|---|---|---|---|
| Patient safety / clinical alerts | 2/10 | 9/10 | ✅ Strong |
| FHIR R4 core resource alignment | 4/10 | 7/10 | 🟡 Good, gaps remain |
| ICD / SNOMED / LOINC coding | 5/10 | 7/10 | 🟡 Partial |
| HIPAA / PHI audit compliance | 2/10 | 8/10 | ✅ Strong |
| Referential integrity | 5/10 | 9/10 | ✅ Strong |
| RLS / access control | 6/10 | 9/10 | ✅ Strong |
| Patient insurance / NHIA | 1/10 | 6/10 | 🟡 Functional, incomplete |
| Financial / accounting | 6/10 | 8/10 | ✅ Strong |
| Offline sync (Wave 2) | 7/10 | 8/10 | ✅ Strong |
| DHIS2 / aggregate reporting | 1/10 | 1/10 | 🔴 Not started |
| Provider credentialing enforcement | 3/10 | 5/10 | 🟡 Stored, not enforced |
| Appointment / scheduling | 0/10 | 7/10 | ✅ New in FIX_17 |

---

## Domain 1 — HL7 FHIR R4 Resource Alignment

### What Is Now In Place

**Patient** (`patients`): id, full_name, sex, gender, date_of_birth, phone, national_id. Age auto-computed from DOB via trigger (FIX_10). View `v_patients` exposes `current_age` and `age_display`.

**Encounter** (`visits`): patient_id, facility_id, visit_date, status, reason, vitals_json (synced from observations via FIX_13 trigger). Clinical notes via `visit_clinical_notes`.

**Condition** (`diagnoses`): icd10_code, icd11_code, snomed_code, diagnosis_type (admitting/provisional/confirmed/discharge/secondary), certainty, clinical_status, onset_date, resolved_date. Format-validated with `chk_diagnoses_icd10_format` (FIX_19). Longitudinal problem list in `patient_conditions` (FIX_15).

**AllergyIntolerance** (`patient_allergies`): allergen_name, allergen_code (SNOMED/RxNorm), allergen_category (medication/food/environment/biologic), allergy_type, criticality, verification_status, clinical_status, onset_date, reaction_description, reaction_severity. Drug-allergy hard stop trigger (FIX_12).

**Observation** (`observations`): loinc_code, display_name, value_numeric, value_text, unit, reference_range_low/high, abnormal_flag, observed_at, status. Trigger syncs to `visits.vitals_json` (FIX_13). Critical lab → outbox_events (FIX_17).

**MedicationRequest** (`medication_orders`): medication_name, generic_name, dosage, frequency, route, status, prescribing_provider_id. Drug-allergy hard stop (FIX_12). DDI check trigger (FIX_18) with 25 seeded Ethiopia-context interaction pairs.

**Coverage** (`patient_insurance`): insurer_id, program_id, membership_number, policy_number, coverage_start/end, copay_percentage, copay_fixed_amount, annual_limit, coverage_priority (1/2/3), full audit history (FIX_16).

**Appointment** (`appointment_slots`): provider, start/end time, duration_mins (computed SMALLINT), slot_type, double-booking prevention via partial unique index (FIX_17).

**DiagnosticReport** (`lab_orders`): test_name, loinc_code, result, result_value_numeric, result_unit, abnormal_flag (critical_low/critical_high/high/low/normal), critical alert wired to outbox_events (FIX_17).

**Practitioner** (`users` + `provider_credentials`): provider_type, license_number, specialization, license_expiry, verifying_authority (FIX_08).

### Remaining FHIR Gaps

| # | Gap | Table | Priority |
|---|---|---|---|
| F-1 | No `encounter_class` on `visits` (ambulatory/inpatient/emergency/community) — required for FHIR Encounter | `visits` | High |
| F-2 | No FHIR `identifier` system on `patients` — `national_id` is plain text, no system URL (MRN, NHIA ID, passport) | `patients` | High |
| F-3 | No `performing_provider_id` FK on `visits` — cannot link encounter to attending clinician | `visits` | Moderate |
| F-4 | No `immunizations` table — vaccines stored ad-hoc in `medication_orders` with no lot_number, VIS, site | New table | High |
| F-5 | No `Procedure` table — surgical history only in `patient_conditions.condition_type = 'surgical_history'` free text | New table | Moderate |
| F-6 | `medication_dispense` missing `days_supply`, `when_handed_over`, `substitution` fields | `medication_dispense` | Moderate |
| F-7 | No `ServiceRequest` (referral) table — referrals stored as free-text notes | New table | Moderate |
| F-8 | `observations` missing `method` (how measured) and `body_site` SNOMED columns | `observations` | Low |

---

## Domain 2 — ICD / SNOMED CT / LOINC Coding

### What Is Now In Place

- `diagnoses.icd10_code` with format-check constraint `^[A-Z][0-9]{2}(\.[0-9A-Z]{0,4})?$` (FIX_19).
- `diagnoses.icd11_code` column present (FIX_02).
- `diagnoses.snomed_code` and `patient_allergies.allergen_code` accept SNOMED CT codes.
- `observations.loinc_code` primary LOINC anchor; FIX_13 trigger maps 8 vital LOINC codes to `vitals_json`.
- `lab_orders.loinc_code` for test identification.
- `drug_interactions` seeded with 25 Ethiopia-context critical drug pairs (FIX_18).

### Remaining Coding Gaps

| # | Gap | Table / Column | Priority |
|---|---|---|---|
| C-1 | No LOINC format validation — any string accepted | `observations.loinc_code`, `lab_orders.loinc_code` | High |
| C-2 | No ICD-11 format validation on `diagnoses.icd11_code` | `diagnoses.icd11_code` | Moderate |
| C-3 | No RxNorm / ATC code on `medication_orders` — only free-text name; DDI matching uses fragile LIKE patterns | `medication_orders` | High |
| C-4 | No SNOMED validation on allergen_code, snomed_code | Multiple | Moderate |
| C-5 | `drug_interactions` pairs use plain text, not RxNorm codes — alternate drug names can be missed | `drug_interactions` | Moderate |
| C-6 | No LOINC panel definition table for CBC, LFT, RFT, etc. | New table | Moderate |
| C-7 | FIX_13 vitals LOINC map missing: respiratory_rate (9279-1), pain_score (72514-3), head_circumference (8287-5), BMI (39156-5) | `observations` / FIX_13 trigger | Low |

---

## Domain 3 — HIPAA & PHI Compliance

### What Is Now In Place

- **Automatic PHI audit triggers** on `patients`, `visits`, `diagnoses`, `patient_allergies`, `medication_orders`, `lab_orders`, `admissions` — fire on INSERT/UPDATE/DELETE, log only changed fields to `audit_log` (FIX_11).
- **Audit log immutability** — `trg_audit_log_immutable` raises EXCEPTION on any UPDATE or DELETE of `audit_log` rows (FIX_19).
- **PHI sensitivity tagging** — `audit_log.sensitivity_level = 'phi'`, `compliance_tags = ARRAY['PHI_ACCESS','HIPAA']`.
- **RLS** on all patient-facing tables scoped to `facility_id = get_user_facility_id()`.
- **Consent management** — full `patient_consents` table with override documentation.
- **Soft-delete** — `deleted_at` columns on core tables prevent hard PHI deletion.
- **Row-level security** using `STABLE SECURITY DEFINER` helper functions.

### Remaining HIPAA Gaps

| # | Gap | Priority |
|---|---|---|
| H-1 | `audit_log` does not capture IP address or user agent — required for HIPAA access logging in SaaS context | High |
| H-2 | No column-level encryption or encryption-at-rest hints for highly sensitive fields (HIV status, mental health notes) | High |
| H-3 | No audit of `auth.users` table — login events, password changes not in `audit_log` | Moderate |
| H-4 | No data retention policy table — PHI retention periods (10 years for Ethiopia) not enforced at DB level | Moderate |
| H-5 | No emergency access (break-glass) override log for cross-facility access | Moderate |
| H-6 | `visit_clinical_notes` with `is_confidential = TRUE` still visible to all facility staff — confidential notes (mental health, HIV) need restricted RLS | High |

---

## Domain 4 — JCI (Joint Commission International) Standards

### What Is Now In Place

- **Patient identification** — patients have UUID, national_id, full_name, date_of_birth, phone (two-factor supported).
- **Medication safety** — drug-allergy hard stop (FIX_12), DDI check (FIX_18), allergy_override_reason required for override.
- **Structured clinical documentation** — `visit_clinical_notes` with SOAP note types, signed_at/signed_by.
- **Admission diagnosis tracking** — `admissions.admitting_diagnosis_id` and `discharge_diagnosis_id` FKs (FIX_14).
- **Provider credentials** — license tracking with expiry (FIX_08).

### Remaining JCI Gaps

| # | Gap | Priority |
|---|---|---|
| J-1 | No `surgical_safety_checklist` table — WHO Surgical Safety Checklist (sign-in/timeout/sign-out) not tracked per procedure | High |
| J-2 | No two-patient-identifier enforcement at medication dispensing — `medication_dispense` does not verify patient_id match | High |
| J-3 | No isolation/precaution flag on `admissions` — airborne/contact/droplet precaution tracking absent (JCI IPSG) | Moderate |
| J-4 | No fall risk assessment table — JCI IPSG.6 requires structured fall risk scoring (Morse scale or equivalent) | Moderate |
| J-5 | Provider `license_expiry` not enforced at order time — expired credentials do not block prescribing or ordering | High |
| J-6 | No critical result acknowledgment record — `outbox_events` fires on critical lab but no acknowledgment workflow | Moderate |
| J-7 | No transfusion safety record — blood type, cross-match, pre-transfusion checklist not modelled | Low |

---

## Domain 5 — NHIA (Ethiopia National Health Insurance Agency)

### What Is Now In Place

- `patient_insurance` with insurer_id, program_id, membership_number, coverage dates, copay_percentage, copay_fixed_amount, annual_limit, coverage_priority (FIX_16).
- `patient_insurance_history` full audit trail with change triggers.
- `get_active_patient_insurance(patient_id, date)` STABLE function for billing RPCs.
- `insurers`, `creditors`, `programs` tables with unique constraints (FIX_19).
- `payment_journals` double-entry accounting (FIX_07).
- Finance staff RLS on reconciliation tables.

### Remaining NHIA Gaps

| # | Gap | Priority |
|---|---|---|
| N-1 | No benefit exhaustion tracking — `annual_limit` exists but no counter of benefits used YTD per patient-program | High |
| N-2 | No pre-authorization table — NHIA-covered procedures often require prior approval; no PA request/approval workflow | High |
| N-3 | No capitation model support — schema assumes fee-for-service; no capitation rate or enrolled-population counting | Moderate |
| N-4 | No NHIA claim submission table — claims (claim_number, adjudication_status, paid_amount) not tracked per visit | High |
| N-5 | No exemption tracking — under-5, pregnant, elderly fee exemption groups not modelled | Moderate |
| N-6 | `programs` has no `program_type` column (CBHI / staff_scheme / private / fee_waiver / exemption) | Moderate |

---

## Domain 6 — WHO / DHIS2 Aggregate Reporting Readiness

### What Is Now In Place

- ICD-10 codes on `diagnoses` — compatible with WHO disease burden reporting.
- LOINC codes on `observations` — compatible with FHIR-based DHIS2 integration.
- `facility_id` on most tables — enables facility-level aggregation.
- `visit_date` indexed — supports date-range aggregate queries.

### Remaining DHIS2 Gaps

| # | Gap | Priority |
|---|---|---|
| D-1 | No aggregate report tables or materialized views — DHIS2 requires pre-aggregated period-facility-indicator summaries | High |
| D-2 | No DHIS2 organisation unit UID on `facilities` — required to map DB facilities to DHIS2 org hierarchy | High |
| D-3 | No indicator definition table — disease burden, ANC coverage, immunization rates not defined as computable SQL | Moderate |
| D-4 | No reporting period table — monthly/quarterly period boundaries not tracked for HMIS reconciliation | Moderate |
| D-5 | No DHIS2 data value export function or view — ETL must be built externally with no DB scaffold | High |

---

## Domain 7 — Data Integrity & Referential Integrity

### What Is Now In Place

- Complete FK chains: patients → visits → diagnoses → patient_conditions; visits → observations; admissions → beds → wards → departments → facilities → tenants.
- `ON DELETE RESTRICT` on critical parent tables — prevents silent cascade deletion (FIX_04).
- `ON DELETE SET NULL` on soft references (FIX_14).
- Composite UNIQUE constraints on `insurers`, `creditors`, `programs` (FIX_19).
- ICD-10 format check on `diagnoses.icd10_code` (FIX_19).
- `chk_slot_end_after_start` on `appointment_slots` (FIX_17).
- Drug-allergy and DDI hard stops at DB trigger level (FIX_12, FIX_18).

### Remaining Integrity Gaps

| # | Gap | Table | Priority |
|---|---|---|---|
| I-1 | No CHECK preventing `visit_date` more than 1 day in future | `visits` | Moderate |
| I-2 | No CHECK ensuring `discharge_date >= admission_date` | `admissions` | High |
| I-3 | No UNIQUE `(patient_id, LOWER(allergen_name))` — duplicate allergy records possible | `patient_allergies` | High |
| I-4 | No CHECK preventing zero or negative `quantity` on medication orders | `medication_orders` | Moderate |
| I-5 | `inventory_items.quantity_on_hand` can go negative — no non-negative constraint | `inventory_items` | High |
| I-6 | No EXCLUDE constraint preventing a patient double-booked across different providers simultaneously | `appointment_slots` | Moderate |

---

## Domain 8 — Security & Access Control

### What Is Now In Place

- RLS enabled on all patient-facing tables.
- `STABLE SECURITY DEFINER` helper functions used consistently (FIX_06).
- `user_role` enum complete with all 10 roles including accountant, lab_scientist, pharmacy_technician, hew (FIX_10).
- Finance policies correctly scoped to `accountant` role (FIX_10).
- `audit_log` INSERT-only and immutable (FIX_11, FIX_19).
- Patient consent management with override documentation.
- Provider credential tracking with license expiry (FIX_08).

### Remaining Security Gaps

| # | Gap | Priority |
|---|---|---|
| S-1 | `visit_clinical_notes` with `is_confidential = TRUE` not restricted to treating provider | High |
| S-2 | No column masking for sensitive fields (national_id) for non-admin roles | Moderate |
| S-3 | `provider_credentials.license_expiry` not enforced at order/prescribe time — expired license does not block orders | High |

---

## Domain 9 — Performance & Index Coverage

### What Is Now In Place

- Compound indexes on all major patterns: `(patient_id, visit_date)`, `(facility_id, status)`, `(tenant_id, facility_id)` on most tables (FIX_05).
- Partial indexes for filtered queries: active admissions, pending lab orders, active medication orders, open slots (FIX_05, FIX_19).
- LOINC code index on `observations` (FIX_09).
- ICD-10 index on `diagnoses` (FIX_19).
- `v_ward_bed_counts` view avoids full scans (FIX_14).

### Remaining Performance Gaps

| # | Gap | Priority |
|---|---|---|
| P-1 | No index on `audit_log(patient_id, created_at)` — patient audit history queries degrade at scale | High |
| P-2 | `patient_insurance` missing index on `(patient_id, status, coverage_end_date)` | Moderate |
| P-3 | No index on `drug_interactions(LOWER(drug_a), LOWER(drug_b))` for reverse-pair lookup | Moderate |
| P-4 | `outbox_events` missing partial index on `(event_type, status) WHERE status = 'pending'` | High |
| P-5 | No index on `appointment_slots(patient_id, start_time)` | Low |

---

## Domain 10 — Offline Sync (Wave 2)

### What Is Now In Place

- `op_ledger` with `(tenant_id, entity_type, entity_id, op_type, row_version, client_id, client_seq)` for operation ordering.
- `sync_cursors` for per-client checkpoint tracking.
- `sync_tombstones` for soft-delete propagation.
- `row_version` counter with `trg_row_version_bump` trigger on key tables.
- `conflict_resolution_log` for last-write-wins audit.
- Wave 2 fields on `patients` and `visits`.

### Remaining Sync Gaps

| # | Gap | Priority |
|---|---|---|
| W-1 | New tables from FIX_15–FIX_17 (`patient_conditions`, `patient_insurance`, `appointment_slots`) have no `row_version` or sync trigger | High |
| W-2 | `drug_interactions` reference table has no sync — clients cannot cache for offline DDI checks | Moderate |
| W-3 | `sync_tombstones` does not cover `patient_insurance_history` | Low |
| W-4 | Trigger-generated rows (e.g., `stock_movements` from FIX_19 dispense trigger) produce no `op_ledger` entries | Moderate |

---

## Summary — Remaining Issues by Priority

### Critical
None. All critical issues resolved by FIX_01 through FIX_12.

### High Priority (16 issues)
F-1 (encounter_class), F-2 (patient identifiers), F-4 (immunizations), C-1 (LOINC validation), C-3 (RxNorm codes), H-1 (audit IP/UA), H-2 (column encryption), H-6 (confidential notes RLS), J-2 (two-ID dispensing), J-5 (license expiry enforcement), N-1 (benefit exhaustion), N-2 (pre-authorization), N-4 (NHIA claims), I-2 (discharge_date check), I-3 (duplicate allergy UNIQUE), I-5 (negative inventory constraint).

### Moderate Priority (18 issues)
F-3, F-5, F-6, F-7, C-2, C-4, C-5, C-6, H-3, H-4, H-5, J-3, J-4, J-6, N-3, N-5, N-6, D-3, D-4, I-1, I-4, I-6, S-2, P-2, P-3, W-2, W-4.

### Low Priority
F-8, C-7, J-7, I-6, S-1, P-5, W-3.

---

## Recommended Next Wave: FIX_20–FIX_22

### FIX_20 — High: FHIR Encounter Class + Integrity Constraints + Confidential Notes RLS
- Add `encounter_class TEXT CHECK (encounter_class IN ('ambulatory','inpatient','emergency','community','other'))` to `visits`
- Add `patient_identifiers` table (system, value, assigner — MRN, national_id, nhia_id, passport)
- Add `ip_address INET` and `user_agent TEXT` to `audit_log`
- Add `CHECK (discharge_date IS NULL OR discharge_date >= admission_date)` on `admissions`
- Add UNIQUE `(patient_id, LOWER(allergen_name))` on `patient_allergies` (with dedup of existing rows)
- Add `CHECK (quantity_on_hand >= 0)` on `inventory_items`
- Add restricted RLS policy for `visit_clinical_notes` where `is_confidential = TRUE`
- Add trigger blocking prescribing by expired provider licenses
- Add indexes: `audit_log(patient_id, created_at)`, `outbox_events(event_type, status) WHERE status='pending'`

### FIX_21 — High: Immunizations + RxNorm + Two-ID Dispensing
- Create `immunizations` table (FHIR Immunization: vaccine_code CVX/LOINC, lot_number, expiry_date, administered_site, VIS_document_id, patient_id, administered_by, facility_id, visit_id)
- Add `rxnorm_code TEXT`, `atc_code TEXT` to `medication_orders`
- Add dispensing patient identity verification check on `medication_dispense`
- Add LOINC format CHECK on `observations.loinc_code`: `^[0-9]{1,5}-[0-9]$`
- Add `row_version` and `op_ledger` sync support for `patient_conditions`, `patient_insurance`, `appointment_slots`

### FIX_22 — High: NHIA Claims + Benefit Exhaustion + DHIS2 Scaffolding
- Create `nhia_claims` (claim_number, visit_id, patient_insurance_id, claim_date, total_amount, nhia_covered_amount, patient_copay, submission_date, adjudication_status, paid_date, rejection_reason)
- Create `insurance_benefit_usage` (patient_insurance_id, benefit_period, amount_used, last_updated) with trigger to decrement on billing
- Create `preauthorizations` (insurer_id, patient_id, procedure_code, requested_by, status, approval_reference, expires_at)
- Add `program_type TEXT CHECK (... IN ('cbhi','staff_scheme','private','fee_waiver','exemption'))` to `programs`
- Add `dhis2_org_unit_uid TEXT` to `facilities`
- Create `reporting_periods` table (period_type, start_date, end_date, period_name)

---

## Migration History

| Migration | Title | Status |
|---|---|---|
| FIX_01 | Critical FK constraints | ✅ Applied |
| FIX_02 | Critical diagnoses table (FHIR Condition alignment) | ✅ Applied |
| FIX_03 | Critical patient_allergies (FHIR AllergyIntolerance) | ✅ Applied |
| FIX_04 | Major CASCADE → RESTRICT | ✅ Applied |
| FIX_05 | Major compound indexes | ✅ Applied |
| FIX_06 | Major RLS helper functions | ✅ Applied |
| FIX_07 | Major payment journals (double-entry accounting) | ✅ Applied |
| FIX_08 | Major provider credentials | ✅ Applied |
| FIX_09 | Minor clinical improvements + FHIR Observation table | ✅ Applied |
| FIX_10 | Critical user_role enum + age auto-computation | ✅ Applied |
| FIX_11 | Critical PHI audit triggers (auto, immutable) | ✅ Applied |
| FIX_12 | Critical drug-allergy hard stop trigger | ✅ Applied |
| FIX_13 | High — vitals single source of truth (observations → vitals_json) | ✅ Applied |
| FIX_14 | High — admission diagnosis FKs + ward bed counter trigger | ✅ Applied |
| FIX_15 | High — patient_conditions longitudinal problem list | ✅ Applied |
| FIX_16 | High — patient_insurance enrollment (NHIA/CBHI) | ✅ Applied |
| FIX_17 | Moderate — clinical consolidation + appointment_slots | ✅ Applied |
| FIX_18 | Moderate — drug_interactions table + DDI trigger (25 pairs) | ✅ Applied |
| FIX_19 | Moderate — integrity cleanup, indexes, audit immutability | ✅ Applied |
| FIX_20 | High — encounter class, identifiers, constraints | 🔲 Planned |
| FIX_21 | High — immunizations, RxNorm, two-ID dispensing | 🔲 Planned |
| FIX_22 | High — NHIA claims, benefit exhaustion, DHIS2 scaffold | 🔲 Planned |

---

*Review last updated: 2026-03-05. All FIX_01 through FIX_19 confirmed applied on remote database.*
