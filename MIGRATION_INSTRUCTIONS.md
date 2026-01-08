# Database Migration Instructions

## Quick Start - Apply Migrations Now

### Option 1: Supabase Dashboard (Recommended - 2 minutes)

1. **Open Supabase SQL Editor:**
   - Click here: https://supabase.com/dashboard/project/qxihedrgltophafkuasa/sql/new
   
2. **Copy the SQL:**
   - Open file: `supabase/migrations/APPLY_THIS_consolidated_migrations.sql`
   - Copy ALL contents (Cmd+A, Cmd+C)

3. **Paste and Run:**
   - Paste into the SQL editor
   - Click "Run" button
   - Wait for "Success" message

4. **Verify:**
   - You should see: "Success. No rows returned"
   - This means migrations applied successfully!

### Option 2: Using psql (If you have DATABASE_URL)

```bash
# Add to your .env file:
DATABASE_URL=postgresql://postgres:[password]@db.qxihedrgltophafkuasa.supabase.co:5432/postgres

# Then run:
./apply-migrations.sh
```

## What These Migrations Do

### Migration 1: First-Time User Onboarding
- Adds `last_login_at` column to track when users log in
- Enables showing onboarding modal only on first login
- Creates performance index

### Migration 2: Fix Patient Registration
- Updates `register_patient_with_visit()` function
- Adds missing payment parameters:
  - `p_consultation_payment_type`
  - `p_program_id`
  - `p_creditor_id`
  - `p_insurer_id`
  - `p_insurance_policy_number`
- Fixes the "function signature mismatch" error

## After Applying Migrations

### Test Patient Registration:
1. Navigate to receptionist dashboard
2. Click "Register New Patient"
3. Fill in patient details
4. Submit the form
5. Should succeed without errors!

### Test First-Time Onboarding:
1. Create a new clinic admin account
2. Log in for the first time
3. Should see onboarding modal
4. Log out and log back in
5. Should NOT see onboarding modal again

## Troubleshooting

### If migrations fail:
- Check you're logged into the correct Supabase project
- Ensure you have admin/owner permissions
- Try running each migration separately

### If patient registration still fails:
- Check browser console for errors
- Verify consultation services are configured in Master Data
- Check backend logs for detailed error messages

## Need Help?

If you encounter any issues:
1. Check the error message in browser console
2. Check backend terminal for detailed logs
3. Verify migrations were applied: Run verification queries at bottom of consolidated migration file
