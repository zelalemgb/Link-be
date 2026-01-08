
import 'dotenv/config';
import { supabaseAdmin } from '../server/config/supabase';

async function diagnose() {
    console.log("--- Diagnostic Start ---");

    // 1. List Users
    const { data: users, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, auth_user_id, facility_id, role');

    if (userError) console.error("User Error:", userError);
    console.log(`Found ${users?.length || 0} users.`);
    users?.forEach(u => console.log(`- User ${u.id} (Role: ${u.role}) -> Facility: ${u.facility_id}`));

    // 2. List Facilities
    const { data: facilities } = await supabaseAdmin.from('facilities').select('id, name');
    console.log(`Found ${facilities?.length || 0} facilities.`);

    // 3. Check Inventory Items per Facility
    if (facilities) {
        for (const f of facilities) {
            const { count } = await supabaseAdmin
                .from('inventory_items')
                .select('*', { count: 'exact', head: true })
                .eq('facility_id', f.id);

            console.log(`- Facility ${f.name} (${f.id}): ${count} inventory items`);
        }
    }

    console.log("--- Diagnostic End ---");
}

diagnose();
