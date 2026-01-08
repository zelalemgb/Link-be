# Patient Registration Flow Audit Report

## ✅ FRONTEND VERIFICATION (ReceptionIntakeForm.tsx)

### Form State Definition
- ✅ `consultationPaymentType` field exists (line 251)
- ✅ Default value: `'paying'` (line 311)
- ✅ Type: `'paying' | 'free' | 'credit' | 'insured' | ''`

### Validation
- ✅ Payment type required validation (line 531-532)
- ✅ Conditional validation for:
  - Free → requires `programId` (line 535-537)
  - Credit → requires `creditorId` (line 539-541)
  - Insured → requires `insuranceProviderId` (line 543-545)

### API Call
- ✅ Sends to: `POST /patients/register-intake` (line 609)
- ✅ Includes all payment fields (lines 628-632):
  - `consultationPaymentType`
  - `programId`
  - `creditorId`
  - `insuranceProviderId`
  - `insurancePolicyNumber`

## ✅ BACKEND VERIFICATION (server/routes/patients.ts)

### Schema Validation
- ✅ `consultationPaymentType: z.string()` (line 221)
- ✅ `programId: z.string().optional()` (line 222)
- ✅ `creditorId: z.string().optional()` (line 223)
- ✅ `insuranceProviderId: z.string().optional()` (line 224)
- ✅ `insurancePolicyNumber: z.string().optional()` (line 225)

### RPC Call
- ✅ Calls: `register_patient_with_visit` (line 260)
- ✅ Passes all payment parameters (lines 281-285):
  - `p_consultation_payment_type`
  - `p_program_id`
  - `p_creditor_id`
  - `p_insurer_id`
  - `p_insurance_policy_number`

## ⚠️ DATABASE FUNCTION (register_patient_with_visit)

### Current Status: UNKNOWN
**The migration may not have been applied yet.**

### Expected Function Signature (from migration):
```sql
CREATE OR REPLACE FUNCTION public.register_patient_with_visit(
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_gender text,
  p_age integer,
  p_date_of_birth date,
  p_phone text,
  p_fayida_id text,
  p_user_id uuid,
  p_facility_id uuid,
  p_region text DEFAULT NULL,
  p_woreda_subcity text DEFAULT NULL,
  p_ketena_gott text DEFAULT NULL,
  p_kebele text DEFAULT NULL,
  p_house_number text DEFAULT NULL,
  p_visit_type text DEFAULT 'New',
  p_residence text DEFAULT NULL,
  p_occupation text DEFAULT NULL,
  p_intake_timestamp text DEFAULT NULL,
  p_intake_patient_id text DEFAULT NULL,
  p_consultation_payment_type text DEFAULT 'paying',  -- ⚠️ MUST EXIST
  p_program_id uuid DEFAULT NULL,                      -- ⚠️ MUST EXIST
  p_creditor_id uuid DEFAULT NULL,                     -- ⚠️ MUST EXIST
  p_insurer_id uuid DEFAULT NULL,                      -- ⚠️ MUST EXIST
  p_insurance_policy_number text DEFAULT NULL          -- ⚠️ MUST EXIST
)
```

## 🔍 DIAGNOSIS

### Frontend → Backend: ✅ WORKING
- All fields are properly defined
- Validation is correct
- API call includes all required data

### Backend → Database: ❓ NEEDS VERIFICATION
- Backend is trying to call the function with payment parameters
- **If migration was NOT applied:** Function will reject the call (signature mismatch)
- **If migration WAS applied:** Function should work

## 🎯 ROOT CAUSE ANALYSIS

### Most Likely Issue:
**The database migration was NOT applied to Supabase.**

### Why This Happens:
1. Migration file was created locally
2. User needs to manually copy/paste SQL into Supabase dashboard
3. If not done, the old function signature remains (without payment params)
4. Backend tries to call with new params → **Function signature mismatch error**

### Expected Error Message:
```
function register_patient_with_visit(text, text, text, text, integer, date, 
text, text, uuid, uuid, text, text, text, text, text, text, text, text, 
text, text, text, uuid, uuid, uuid, text) does not exist
```

## ✅ SOLUTION

### Step 1: Apply Migration
1. Open: `link-be/supabase/migrations/APPLY_THIS_consolidated_migrations.sql`
2. Copy ALL contents
3. Go to: https://supabase.com/dashboard/project/qxihedrgltophafkuasa/sql/new
4. Paste and click "Run"

### Step 2: Verify Migration
Run this query in Supabase SQL Editor:
```sql
SELECT COUNT(*) as param_count
FROM information_schema.parameters
WHERE specific_schema = 'public'
  AND routine_name = 'register_patient_with_visit';
```
- **Expected result:** 25 parameters
- **If less than 25:** Migration was not applied

### Step 3: Test Patient Registration
1. Go to http://localhost:5173
2. Navigate to patient registration
3. Fill in form and submit
4. Should work without errors!

## 📋 CHECKLIST

- [ ] Migration SQL copied from file
- [ ] Migration applied in Supabase dashboard
- [ ] Verification query run (shows 25 parameters)
- [ ] Patient registration tested
- [ ] Success message received

## 🔧 ADDITIONAL CHECKS

### If Still Failing After Migration:

1. **Check Consultation Service Configuration:**
   ```sql
   SELECT id, name, category, price, is_active
   FROM medical_services
   WHERE category = 'Consultation'
     AND is_active = true;
   ```
   - Must have at least one active consultation service

2. **Check User Tenant ID:**
   ```sql
   SELECT id, name, tenant_id, facility_id
   FROM users
   WHERE auth_user_id = '[your-auth-id]';
   ```
   - User must have valid `tenant_id`

3. **Check Browser Console:**
   - Open DevTools (F12)
   - Look for red error messages
   - Copy exact error text
