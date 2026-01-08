#!/usr/bin/env tsx
/**
 * Quick diagnostic script to check migration status
 */

import { supabaseAdmin } from './config/supabase';

async function checkMigrations() {
    console.log('🔍 Checking migration status...\n');

    try {
        // Check if last_login_at column exists
        const { data: columnCheck, error: colError } = await supabaseAdmin
            .from('users')
            .select('last_login_at')
            .limit(1);

        if (colError) {
            console.log('❌ last_login_at column: NOT FOUND');
            console.log('   Error:', colError.message);
        } else {
            console.log('✅ last_login_at column: EXISTS');
        }

        // Try to call the function with all parameters
        console.log('\n🔍 Testing register_patient_with_visit function...');

        const { data, error } = await supabaseAdmin.rpc('register_patient_with_visit', {
            p_first_name: 'Test',
            p_middle_name: 'Migration',
            p_last_name: 'Check',
            p_gender: 'Male',
            p_age: 30,
            p_date_of_birth: '1994-01-01',
            p_phone: '+251900000001',
            p_fayida_id: null,
            p_user_id: '00000000-0000-0000-0000-000000000000', // Will fail but shows signature
            p_facility_id: '00000000-0000-0000-0000-000000000000',
            p_consultation_payment_type: 'paying',
            p_program_id: null,
            p_creditor_id: null,
            p_insurer_id: null,
            p_insurance_policy_number: null
        });

        if (error) {
            if (error.message.includes('function') && error.message.includes('does not exist')) {
                console.log('❌ Function signature: MISMATCH or NOT UPDATED');
                console.log('   Error:', error.message);
                console.log('\n⚠️  Migration was NOT applied! Please apply the SQL in Supabase dashboard.');
            } else {
                console.log('✅ Function signature: CORRECT (error is expected - test data)');
                console.log('   Error:', error.message);
            }
        } else {
            console.log('✅ Function signature: CORRECT');
        }

    } catch (err: any) {
        console.error('Error during check:', err.message);
    }

    process.exit(0);
}

checkMigrations();
