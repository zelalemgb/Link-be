-- ============================================================
-- FIX 18 — MODERATE: Drug Interaction Reference Table + Check
-- ============================================================
-- Problem:
--   No drug_interactions reference table exists. For facilities
--   managing complex multi-drug regimens (HIV/TB co-treatment, common
--   in Ethiopia), the DB has no mechanism to warn prescribers about
--   clinically significant drug-drug interactions (DDIs).
--
-- Fix:
--   1. drug_interactions reference table — seeded with the most
--      clinically critical pairs for an Ethiopia primary care context.
--   2. BEFORE INSERT trigger on medication_orders that checks active
--      orders for the same patient for known DDIs.
--   3. medication_orders gains ddi_alert_flag and ddi_override_reason
--      columns (analogous to allergy columns from FIX 12).
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. drug_interactions reference table
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.drug_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The two drugs that interact (order-independent — check both ways)
  drug_a        TEXT NOT NULL,   -- generic name or drug class keyword
  drug_b        TEXT NOT NULL,   -- generic name or drug class keyword

  -- Severity classification (follows standard DDI severity scales)
  severity      TEXT NOT NULL DEFAULT 'moderate'
    CHECK (severity IN ('contraindicated', 'major', 'moderate', 'minor')),

  -- Effect description
  effect        TEXT NOT NULL,
  mechanism     TEXT,
  recommendation TEXT,          -- what to do: avoid, monitor, dose adjust, etc.

  -- Source / evidence
  evidence_level TEXT DEFAULT 'established'
    CHECK (evidence_level IN ('established', 'probable', 'suspected', 'possible', 'unlikely')),

  -- Is this interaction relevant for Ethiopia clinical context?
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent exact duplicate pairs
  UNIQUE (drug_a, drug_b)
);

CREATE INDEX IF NOT EXISTS idx_di_drug_a ON public.drug_interactions(LOWER(drug_a)) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_di_drug_b ON public.drug_interactions(LOWER(drug_b)) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_di_severity ON public.drug_interactions(severity) WHERE is_active;

CREATE TRIGGER update_drug_interactions_updated_at
  BEFORE UPDATE ON public.drug_interactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: read-only for clinical staff; write for super_admin/admin
ALTER TABLE public.drug_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical staff can view drug interactions"
  ON public.drug_interactions FOR SELECT USING (is_active = TRUE);

CREATE POLICY "Super admin can manage drug interactions"
  ON public.drug_interactions FOR ALL USING (public.is_super_admin());

-- ══════════════════════════════════════════════
-- 2. Seed critical DDIs for Ethiopia primary care context
--    (HIV/TB co-treatment, malaria, obstetric, common chronic disease)
-- ══════════════════════════════════════════════
INSERT INTO public.drug_interactions
  (drug_a, drug_b, severity, effect, mechanism, recommendation, evidence_level)
VALUES

-- ── HIV/TB co-treatment (most critical in Ethiopia context)
('rifampicin',   'efavirenz',         'major',          'Rifampicin reduces efavirenz plasma levels by ~25% via CYP3A4 induction',                             'CYP3A4 induction',             'Increase efavirenz dose to 800mg/day in patients >60kg; monitor viral load',      'established'),
('rifampicin',   'lopinavir',         'contraindicated', 'Rifampicin reduces lopinavir AUC by >75%; treatment failure likely',                                   'CYP3A4 induction',             'Avoid combination; use alternative TB regimen or different ART',                  'established'),
('rifampicin',   'atazanavir',        'contraindicated', 'Rifampicin drastically reduces atazanavir levels',                                                     'CYP3A4 induction',             'Avoid; use efavirenz-based ART with rifampicin',                                  'established'),
('rifampicin',   'dolutegravir',      'major',          'Rifampicin reduces dolutegravir AUC by ~54%',                                                           'UGT1A1/CYP3A4 induction',      'Double dolutegravir dose to 50mg BD; monitor',                                    'established'),
('rifampicin',   'nevirapine',        'major',          'Rifampicin reduces nevirapine levels by ~37–58%',                                                       'CYP3A4 induction',             'Avoid if possible; use efavirenz instead',                                        'established'),
('isoniazid',    'phenytoin',         'major',          'Isoniazid inhibits phenytoin metabolism → phenytoin toxicity',                                           'CYP2C9 inhibition',            'Monitor phenytoin levels; reduce dose if toxicity signs appear',                   'established'),
('isoniazid',    'carbamazepine',     'moderate',       'Isoniazid may increase carbamazepine levels',                                                           'CYP3A4 inhibition',            'Monitor carbamazepine levels and for toxicity',                                   'probable'),

-- ── Antiretroviral combinations
('zidovudine',   'stavudine',         'contraindicated', 'Pharmacological antagonism: both compete as NRTI; combination reduces efficacy',                        'Competition at reverse transcriptase', 'Never combine; choose one NRTI backbone',                                'established'),
('abacavir',     'tenofovir',         'moderate',       'Virological failure reported with ABC+TDF+3TC triple NRTI regimen',                                     'Pharmacodynamic antagonism',   'Avoid triple NRTI; use two NRTIs + NNRTI or PI',                                  'established'),

-- ── Malaria treatment
('artemether',   'efavirenz',         'moderate',       'Efavirenz reduces artemether/lumefantrine levels by ~30%',                                               'CYP3A4 induction',             'Use higher-end dosing; monitor treatment response',                               'established'),
('quinine',      'halofantrine',      'contraindicated', 'Additive QT prolongation risk; potentially fatal arrhythmia',                                           'QT prolongation',              'Avoid combination; sequential use requires ECG monitoring',                        'established'),
('chloroquine',  'amiodarone',        'contraindicated', 'Both prolong QT interval; high risk of torsades de pointes',                                            'QT prolongation (additive)',   'Avoid; if unavoidable, ECG monitoring required',                                  'established'),

-- ── Obstetric / maternal health
('metronidazole','warfarin',          'major',          'Metronidazole inhibits warfarin metabolism → elevated INR, bleeding risk',                               'CYP2C9 inhibition',            'Reduce warfarin dose by 30–50%; monitor INR closely',                             'established'),
('co-trimoxazole','warfarin',         'major',          'Trimethoprim/sulfamethoxazole increases warfarin effect',                                                'CYP2C9 inhibition',            'Monitor INR; reduce warfarin dose as needed',                                     'established'),
('oxytocin',     'ergometrine',       'major',          'Additive uterotonic effect → excessive uterine contraction, fetal distress',                             'Pharmacodynamic synergy',      'Do not administer simultaneously; sequential use requires close monitoring',       'established'),

-- ── Cardiovascular / chronic disease
('metformin',    'contrast_media',    'major',          'Risk of metformin-induced lactic acidosis with iodinated contrast',                                      'Renal impairment potentiation', 'Hold metformin 48h before and after contrast; check renal function',              'established'),
('atenolol',     'verapamil',         'contraindicated', 'Additive AV nodal blockade → complete heart block, asystole',                                           'Pharmacodynamic synergy',      'Avoid IV combination; oral combination requires monitoring',                       'established'),
('digoxin',      'amiodarone',        'major',          'Amiodarone doubles digoxin levels → toxicity',                                                           'P-gp inhibition, renal clearance reduction', 'Halve digoxin dose; monitor levels',                              'established'),
('simvastatin',  'amiodarone',        'major',          'Amiodarone inhibits simvastatin metabolism → myopathy risk',                                             'CYP3A4 inhibition',            'Use pravastatin or rosuvastatin instead',                                         'established'),

-- ── Analgesics / pain
('nsaid',        'warfarin',          'major',          'NSAIDs displace warfarin + increase GI bleeding risk',                                                   'Protein binding + GI effect',  'Avoid; use paracetamol if analgesia needed',                                       'established'),
('nsaid',        'methotrexate',      'major',          'NSAIDs reduce methotrexate clearance → toxicity',                                                        'Renal tubular competition',    'Avoid combination; monitor methotrexate levels closely',                          'established'),

-- ── Antibiotics
('ciprofloxacin','theophylline',      'major',          'Ciprofloxacin inhibits theophylline metabolism → theophylline toxicity',                                 'CYP1A2 inhibition',            'Reduce theophylline dose by 30–50%; monitor levels',                              'established'),
('erythromycin', 'simvastatin',       'major',          'Erythromycin increases simvastatin levels → myopathy, rhabdomyolysis',                                   'CYP3A4 inhibition',            'Hold statin during erythromycin course or switch to pravastatin',                 'established'),
('linezolid',    'tramadol',          'contraindicated', 'Serotonin syndrome risk',                                                                               'MAO inhibition',               'Avoid; if essential, monitor for serotonin syndrome signs',                       'established')

ON CONFLICT (drug_a, drug_b) DO NOTHING;

-- ══════════════════════════════════════════════
-- 3. DDI check columns on medication_orders
-- ══════════════════════════════════════════════
ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS ddi_alert_flag       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ddi_override_reason  TEXT,
  ADD COLUMN IF NOT EXISTS ddi_severity         TEXT;

COMMENT ON COLUMN public.medication_orders.ddi_alert_flag IS
  'Set TRUE by trigger when a known drug-drug interaction is detected '
  'with another active order for the same patient.';

-- ══════════════════════════════════════════════
-- 4. DDI check function
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_drug_interactions(
  p_patient_id     UUID,
  p_medication_name TEXT,
  p_generic_name   TEXT DEFAULT NULL
)
RETURNS TABLE (
  interacting_drug TEXT,
  severity         TEXT,
  effect           TEXT,
  recommendation   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_drugs AS (
    SELECT LOWER(medication_name) AS drug, LOWER(COALESCE(generic_name,'')) AS generic
    FROM public.medication_orders
    WHERE patient_id = p_patient_id
      AND status NOT IN ('discontinued', 'cancelled')
  )
  SELECT
    di.drug_a || ' / ' || di.drug_b AS interacting_drug,
    di.severity,
    di.effect,
    di.recommendation
  FROM public.drug_interactions di
  JOIN active_drugs ad ON (
    (LOWER(di.drug_a) LIKE '%' || ad.drug    || '%' OR ad.drug    LIKE '%' || LOWER(di.drug_a) || '%'
      OR LOWER(di.drug_a) LIKE '%' || ad.generic || '%' OR ad.generic LIKE '%' || LOWER(di.drug_a) || '%')
    AND
    (LOWER(di.drug_b) LIKE '%' || LOWER(p_medication_name) || '%'
      OR LOWER(p_medication_name) LIKE '%' || LOWER(di.drug_b) || '%'
      OR (p_generic_name IS NOT NULL AND (
        LOWER(di.drug_b) LIKE '%' || LOWER(p_generic_name) || '%'
        OR LOWER(p_generic_name) LIKE '%' || LOWER(di.drug_b) || '%'
      ))
    )
  )
  WHERE di.is_active = TRUE
  UNION
  SELECT
    di.drug_a || ' / ' || di.drug_b AS interacting_drug,
    di.severity,
    di.effect,
    di.recommendation
  FROM public.drug_interactions di
  JOIN active_drugs ad ON (
    (LOWER(di.drug_b) LIKE '%' || ad.drug    || '%' OR ad.drug    LIKE '%' || LOWER(di.drug_b) || '%'
      OR LOWER(di.drug_b) LIKE '%' || ad.generic || '%' OR ad.generic LIKE '%' || LOWER(di.drug_b) || '%')
    AND
    (LOWER(di.drug_a) LIKE '%' || LOWER(p_medication_name) || '%'
      OR LOWER(p_medication_name) LIKE '%' || LOWER(di.drug_a) || '%'
      OR (p_generic_name IS NOT NULL AND (
        LOWER(di.drug_a) LIKE '%' || LOWER(p_generic_name) || '%'
        OR LOWER(p_generic_name) LIKE '%' || LOWER(di.drug_a) || '%'
      ))
    )
  )
  WHERE di.is_active = TRUE;
$$;

-- ══════════════════════════════════════════════
-- 5. DDI trigger on medication_orders
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.enforce_ddi_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ddi RECORD;
  v_contraindicated BOOLEAN := FALSE;
BEGIN
  FOR v_ddi IN
    SELECT * FROM public.check_drug_interactions(
      NEW.patient_id,
      NEW.medication_name,
      NEW.generic_name
    )
  LOOP
    NEW.ddi_alert_flag := TRUE;
    NEW.ddi_severity   := v_ddi.severity;

    IF v_ddi.severity = 'contraindicated' THEN
      v_contraindicated := TRUE;
    END IF;

    RAISE WARNING 'DDI ALERT [%]: % vs existing active medication. Effect: %. Recommendation: %',
      UPPER(v_ddi.severity), v_ddi.interacting_drug, v_ddi.effect, v_ddi.recommendation;
  END LOOP;

  IF v_contraindicated
    AND (NEW.ddi_override_reason IS NULL OR TRIM(NEW.ddi_override_reason) = '')
  THEN
    RAISE EXCEPTION
      'CONTRAINDICATED COMBINATION: "%" is contraindicated with an active medication for this patient. '
      'Set ddi_override_reason to proceed. SQLSTATE: P0002',
      NEW.medication_name
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN SQLSTATE 'P0002' THEN RAISE;
  WHEN OTHERS THEN
    RAISE WARNING 'enforce_ddi_check failed: % %', SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ddi_check ON public.medication_orders;

CREATE TRIGGER trg_ddi_check
  BEFORE INSERT OR UPDATE OF medication_name, generic_name, patient_id
  ON public.medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ddi_check();

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT severity, COUNT(*) AS pairs
FROM public.drug_interactions
GROUP BY severity
ORDER BY CASE severity
  WHEN 'contraindicated' THEN 1 WHEN 'major' THEN 2
  WHEN 'moderate' THEN 3 ELSE 4 END;
