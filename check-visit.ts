
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkLatestVisit() {
    console.log('Checking latest visit...');
    const { data, error } = await supabase
        .from('visits')
        .select(`
      id,
      patient_id,
      created_at,
      fee_paid,
      status,
      patients (full_name)
    `)
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        console.error('Error fetching visit:', error);
        return;
    }

    console.log('Latest Visit Data:', JSON.stringify(data, null, 2));
}

checkLatestVisit();
