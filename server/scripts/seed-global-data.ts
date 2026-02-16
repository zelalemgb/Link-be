
import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function seedGlobalData() {
    console.log('Starting global master data seed...');

    // 1. Get Default Tenant
    const { data: tenants, error: tenantError } = await supabaseAdmin
        .from('tenants')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1);

    if (tenantError || !tenants?.length) {
        console.error('Error fetching tenant:', tenantError);
        process.exit(1);
    }
    const tenantId = tenants[0].id;
    console.log(`Using Tenant ID: ${tenantId}`);

    // 2. Get Admin User
    const { data: users, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1);

    if (userError || !users?.length) {
        console.error('Error fetching admin user:', userError);
        process.exit(1);
    }
    const adminId = users[0].id;
    console.log(`Using Created By User ID: ${adminId}`);

    // 3. Seed Insurers
    const insurers = [
        { name: 'Ethiopian Health Insurance Agency', code: 'EHIA' },
        { name: 'Community Based Health Insurance', code: 'CBHI' },
        { name: 'Nyala Insurance', code: 'NYALA' },
        { name: 'Awash Insurance', code: 'AWASH' },
        { name: 'Ethiopian Insurance Corporation', code: 'EIC' },
        { name: 'United Insurance', code: 'UNITED' },
        { name: 'Africa Insurance', code: 'AFRICA' },
        { name: 'Oromia Insurance', code: 'OIC' },
    ];

    console.log('Seeding insurers...');
    for (const item of insurers) {
        // Check if exists
        const { data: existing } = await supabaseAdmin
            .from('insurers')
            .select('id')
            .eq('tenant_id', tenantId)
            .is('facility_id', null)
            .eq('name', item.name)
            .maybeSingle();

        if (existing) {
            console.log(`Insurer ${item.name} already exists.`);
            continue;
        }

        const { error } = await supabaseAdmin
            .from('insurers')
            .insert({
                tenant_id: tenantId,
                facility_id: null, // Global
                name: item.name,
                code: item.code,
                // using minimal fields
                is_active: true,
                created_by: adminId
            });

        if (error) console.error(`Failed to insert insurer ${item.name}:`, error.message);
        else console.log(`Inserted insurer ${item.name}`);
    }

    // 4. Seed Programs
    const programs = [
        { name: 'HIV/AIDS Prevention and Treatment', code: 'HIV' },
        { name: 'Tuberculosis Control Program', code: 'TB' },
        { name: 'Malaria Prevention Program', code: 'MALARIA' },
        { name: 'Expanded Program on Immunization', code: 'EPI' },
        { name: 'Family Planning Services', code: 'FP' },
        { name: 'Antenatal Care Program', code: 'ANC' },
        { name: 'Nutrition Program', code: 'NUTRITION' },
        { name: 'Non-Communicable Diseases', code: 'NCD' },
        { name: 'Mental Health Services', code: 'MENTAL' },
    ];

    console.log('Seeding programs...');
    for (const item of programs) {
        // Check if exists
        const { data: existing } = await supabaseAdmin
            .from('programs')
            .select('id')
            .eq('tenant_id', tenantId)
            .is('facility_id', null)
            .eq('name', item.name)
            .maybeSingle();

        if (existing) {
            console.log(`Program ${item.name} already exists.`);
            continue;
        }

        const { error } = await supabaseAdmin
            .from('programs')
            .insert({
                tenant_id: tenantId,
                facility_id: null, // Global
                name: item.name,
                code: item.code,
                // minimal fields
                is_active: true,
                created_by: adminId
            });

        if (error) console.error(`Failed to insert program ${item.name}:`, error.message);
        else console.log(`Inserted program ${item.name}`);
    }

    console.log('Seeding completed successfully!');
}

seedGlobalData().catch(console.error);
