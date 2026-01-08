import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://opappifbhawrhciyrnyp.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkPaymentData() {
    const facilityId = 'db490946-2f39-4281-af47-0e3448e63c88';
    const today = new Date().toISOString().split('T')[0];

    console.log('=== DIAGNOSTIC: Checking Payment Data ===');
    console.log('Facility ID:', facilityId);
    console.log('Today:', today);
    console.log('');

    // Check payments table
    const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('id, payment_status, created_at, facility_id')
        .eq('facility_id', facilityId)
        .limit(10);

    console.log('--- Payments Table (last 10) ---');
    console.log('Count:', payments?.length || 0);
    console.log('Data:', JSON.stringify(payments, null, 2));
    console.log('Error:', paymentsError);
    console.log('');

    // Check payment_line_items
    const { data: lineItems, error: lineItemsError } = await supabase
        .from('payment_line_items')
        .select('id, payment_method, final_amount, created_at')
        .limit(10);

    console.log('--- Payment Line Items (last 10) ---');
    console.log('Count:', lineItems?.length || 0);
    console.log('Data:', JSON.stringify(lineItems, null, 2));
    console.log('Error:', lineItemsError);
    console.log('');

    // Check billing_items (unpaid)
    const { data: billingItems, error: billingError } = await supabase
        .from('billing_items')
        .select(`
            id,
            total_amount,
            payment_status,
            created_at,
            visits!inner (
                consultation_payment_type,
                facility_id
            )
        `)
        .eq('visits.facility_id', facilityId)
        .eq('payment_status', 'unpaid')
        .limit(10);

    console.log('--- Billing Items (unpaid, facility) ---');
    console.log('Count:', billingItems?.length || 0);
    console.log('Data:', JSON.stringify(billingItems, null, 2));
    console.log('Error:', billingError);
    console.log('');

    // Check today's payments specifically
    const { data: todayPayments, error: todayError } = await supabase
        .from('payments')
        .select('id, payment_status, created_at')
        .eq('facility_id', facilityId)
        .gte('created_at', today);

    console.log('--- Today\'s Payments ---');
    console.log('Count:', todayPayments?.length || 0);
    console.log('Data:', JSON.stringify(todayPayments, null, 2));
    console.log('Error:', todayError);
}

checkPaymentData().catch(console.error);
