
import 'dotenv/config';
import { supabaseAdmin } from '../server/config/supabase';

const GENERATE_COUNT = 20;

const SAMPLE_ITEMS = [
    { name: 'Amoxicillin 500mg Capsule', generic: 'Amoxicillin', form: 'Capsule', strength: '500mg', unit: 'capsule', category: 'Antibiotic' },
    { name: 'Paracetamol 500mg Tablet', generic: 'Paracetamol', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Analgesic' },
    { name: 'Ibuprofen 400mg Tablet', generic: 'Ibuprofen', form: 'Tablet', strength: '400mg', unit: 'tablet', category: 'Analgesic' },
    { name: 'Ceftriaxone 1g Injection', generic: 'Ceftriaxone', form: 'Injection', strength: '1g', unit: 'vial', category: 'Antibiotic' },
    { name: 'Metronidazole 400mg Tablet', generic: 'Metronidazole', form: 'Tablet', strength: '400mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Omeprazole 20mg Capsule', generic: 'Omeprazole', form: 'Capsule', strength: '20mg', unit: 'capsule', category: 'Gastrointestinal' },
    { name: 'Metformin 500mg Tablet', generic: 'Metformin', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Antidiabetic' },
    { name: 'Amlodipine 5mg Tablet', generic: 'Amlodipine', form: 'Tablet', strength: '5mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Simvastatin 20mg Tablet', generic: 'Simvastatin', form: 'Tablet', strength: '20mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Losartan 50mg Tablet', generic: 'Losartan', form: 'Tablet', strength: '50mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Azithromycin 500mg Tablet', generic: 'Azithromycin', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Ciprofloxacin 500mg Tablet', generic: 'Ciprofloxacin', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Doxycycline 100mg Capsule', generic: 'Doxycycline', form: 'Capsule', strength: '100mg', unit: 'capsule', category: 'Antibiotic' },
    { name: 'Prednisolone 5mg Tablet', generic: 'Prednisolone', form: 'Tablet', strength: '5mg', unit: 'tablet', category: 'Steroid' },
    { name: 'Cetirizine 10mg Tablet', generic: 'Cetirizine', form: 'Tablet', strength: '10mg', unit: 'tablet', category: 'Antihistamine' },
    { name: 'Disposable Gloves (Box)', generic: 'Latex Gloves', form: 'Box', strength: 'Medium', unit: 'box', category: 'Consumable' },
    { name: 'Surgical Mask (Box)', generic: 'Face Mask', form: 'Box', strength: 'Standard', unit: 'box', category: 'Consumable' },
    { name: 'Syringe 5ml', generic: 'Syringe', form: 'Unit', strength: '5ml', unit: 'piece', category: 'Consumable' },
    { name: 'IV Cannula 20G', generic: 'IV Cannula', form: 'Unit', strength: '20G', unit: 'piece', category: 'Consumable' },
    { name: 'Normal Saline 500ml', generic: 'Sodium Chloride', form: 'IV Fluid', strength: '0.9%', unit: 'bottle', category: 'Fluids' }
];

async function generateInventory() {
    console.log('Starting inventory generation...');

    // 1. Get Facility
    const { data: facilities, error: facError } = await supabaseAdmin
        .from('facilities')
        .select('id, tenant_id')
        .limit(1);

    if (facError || !facilities?.length) {
        throw new Error('No facilities found. Please create a facility first.');
    }

    const facility = facilities[0];
    console.log(`Using facility: ${facility.id}`);

    // 2. Get User (for created_by) - Get ANY user if facility specific one fails
    let userId: string | null = null;

    const { data: users, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('facility_id', facility.id)
        .limit(1);

    if (users?.length) {
        userId = users[0].id;
    } else {
        // Fallback to any user
        const { data: anyUsers } = await supabaseAdmin.from('users').select('id').limit(1);
        if (anyUsers?.length) userId = anyUsers[0].id;
    }

    if (!userId) {
        throw new Error("No users found in database to attribute 'created_by'. Cannot proceed.");
    }
    console.log(`Using User ID: ${userId}`);

    // 3. Process Items
    for (const item of SAMPLE_ITEMS) {
        try {
            // A. Check if Item Exists
            const { data: existingItems } = await supabaseAdmin
                .from('inventory_items')
                .select('id')
                .eq('facility_id', facility.id)
                .eq('name', item.name)
                .limit(1);

            let itemId = existingItems?.[0]?.id;

            if (!itemId) {
                // Insert new item
                const { data: newItem, error: insertError } = await supabaseAdmin
                    .from('inventory_items')
                    .insert({
                        facility_id: facility.id,
                        tenant_id: facility.tenant_id,
                        name: item.name,
                        generic_name: item.generic,
                        dosage_form: item.form,
                        strength: item.strength,
                        unit_of_measure: item.unit,
                        category: item.category,
                        reorder_level: 50,
                        max_stock_level: 1000,
                        created_by: userId
                    })
                    .select('id')
                    .single();

                if (insertError) {
                    console.error(`Failed to insert item ${item.name}:`, insertError.message);
                    continue;
                }
                itemId = newItem.id;
            }

            // B. Get Current Balance (Latest movement)
            const { data: lastMove } = await supabaseAdmin
                .from('stock_movements')
                .select('balance_after')
                .eq('inventory_item_id', itemId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            const currentBalance = lastMove?.balance_after || 0;

            // C. Generate Stock Movement (Receipt)
            const qty = Math.floor(Math.random() * 500) + 50; // 50 to 550
            const newBalance = currentBalance + qty;
            const batchNo = `BATCH-${Math.floor(Math.random() * 100000)}`;
            const expiry = new Date();
            expiry.setFullYear(expiry.getFullYear() + 1 + Math.floor(Math.random() * 2)); // 1-3 years out

            const { error: stockError } = await supabaseAdmin
                .from('stock_movements')
                .insert({
                    facility_id: facility.id,
                    tenant_id: facility.tenant_id,
                    inventory_item_id: itemId,
                    movement_type: 'receipt', // or 'adjustment'
                    quantity: qty,
                    balance_after: newBalance,
                    batch_number: batchNo,
                    expiry_date: expiry.toISOString(),
                    created_by: userId,
                    unit_cost: parseFloat((Math.random() * 10).toFixed(2)),
                    notes: 'Auto-generated seed data'
                });

            if (stockError) {
                console.error(`Failed to add stock for ${item.name}:`, stockError.message);
            } else {
                console.log(`Generated stock for ${item.name}: +${qty} (verify balance: ${newBalance})`);
            }

        } catch (err: any) {
            console.error(`Error processing ${item.name}:`, err.message);
        }
    }

    console.log('Inventory generation complete.');
}

generateInventory().catch(console.error);
