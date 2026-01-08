
import 'dotenv/config';
import { supabaseAdmin } from '../server/config/supabase';

const ESSENTIAL_MEDICINES = [
    // Analgesics
    { name: 'Acetylsalicylic acid 500mg Tablet', generic: 'Acetylsalicylic acid', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Analgesic' },
    { name: 'Ibuprofen 200mg Tablet', generic: 'Ibuprofen', form: 'Tablet', strength: '200mg', unit: 'tablet', category: 'Analgesic' },
    { name: 'Ibuprofen 400mg Tablet', generic: 'Ibuprofen', form: 'Tablet', strength: '400mg', unit: 'tablet', category: 'Analgesic' },
    { name: 'Paracetamol 125mg/5ml Syrup', generic: 'Paracetamol', form: 'Syrup', strength: '125mg/5ml', unit: 'bottle', category: 'Analgesic' },
    { name: 'Morphine 10mg Injection', generic: 'Morphine', form: 'Injection', strength: '10mg', unit: 'ampoule', category: 'Analgesic' },
    { name: 'Tramadol 50mg Capsule', generic: 'Tramadol', form: 'Capsule', strength: '50mg', unit: 'capsule', category: 'Analgesic' },

    // Antibiotics
    { name: 'Amoxicillin 250mg Capsule', generic: 'Amoxicillin', form: 'Capsule', strength: '250mg', unit: 'capsule', category: 'Antibiotic' },
    { name: 'Amoxicillin 125mg/5ml Suspension', generic: 'Amoxicillin', form: 'Suspension', strength: '125mg/5ml', unit: 'bottle', category: 'Antibiotic' },
    { name: 'Ampicillin 1g Injection', generic: 'Ampicillin', form: 'Injection', strength: '1g', unit: 'vial', category: 'Antibiotic' },
    { name: 'Benzathine benzylpenicillin 2.4 MIU', generic: 'Benzathine benzylpenicillin', form: 'Injection', strength: '2.4 MIU', unit: 'vial', category: 'Antibiotic' },
    { name: 'Ceftriaxone 250mg Injection', generic: 'Ceftriaxone', form: 'Injection', strength: '250mg', unit: 'vial', category: 'Antibiotic' },
    { name: 'Ciprofloxacin 250mg Tablet', generic: 'Ciprofloxacin', form: 'Tablet', strength: '250mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Clarithromycin 500mg Tablet', generic: 'Clarithromycin', form: 'Tablet', strength: '500mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Doxycycline 100mg Tablet', generic: 'Doxycycline', form: 'Tablet', strength: '100mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Erythromycin 250mg Tablet', generic: 'Erythromycin', form: 'Tablet', strength: '250mg', unit: 'tablet', category: 'Antibiotic' },
    { name: 'Metronidazole 250mg Tablet', generic: 'Metronidazole', form: 'Tablet', strength: '250mg', unit: 'tablet', category: 'Antibiotic' },

    // Cardiovascular
    { name: 'Amlodipine 10mg Tablet', generic: 'Amlodipine', form: 'Tablet', strength: '10mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Atenolol 50mg Tablet', generic: 'Atenolol', form: 'Tablet', strength: '50mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Enalapril 5mg Tablet', generic: 'Enalapril', form: 'Tablet', strength: '5mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Furosemide 40mg Tablet', generic: 'Furosemide', form: 'Tablet', strength: '40mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Hydrochlorothiazide 25mg Tablet', generic: 'Hydrochlorothiazide', form: 'Tablet', strength: '25mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Simvastatin 10mg Tablet', generic: 'Simvastatin', form: 'Tablet', strength: '10mg', unit: 'tablet', category: 'Cardiovascular' },
    { name: 'Spironolactone 25mg Tablet', generic: 'Spironolactone', form: 'Tablet', strength: '25mg', unit: 'tablet', category: 'Cardiovascular' },

    // Gastrointestinal
    { name: 'Omeprazole 40mg Capsule', generic: 'Omeprazole', form: 'Capsule', strength: '40mg', unit: 'capsule', category: 'Gastrointestinal' },
    { name: 'Ranitidine 150mg Tablet', generic: 'Ranitidine', form: 'Tablet', strength: '150mg', unit: 'tablet', category: 'Gastrointestinal' },
    { name: 'Magnesium hydroxide Suspension', generic: 'Magnesium hydroxide', form: 'Suspension', strength: '400mg/5ml', unit: 'bottle', category: 'Gastrointestinal' },
    { name: 'Oral Rehydration Salts', generic: 'ORS', form: 'Powder', strength: 'Standard', unit: 'sachet', category: 'Gastrointestinal' },

    // Respiratory
    { name: 'Salbutamol Inhaler', generic: 'Salbutamol', form: 'Inhaler', strength: '100mcg/dose', unit: 'inhaler', category: 'Respiratory' },
    { name: 'Beclometasone Inhaler', generic: 'Beclometasone', form: 'Inhaler', strength: '50mcg/dose', unit: 'inhaler', category: 'Respiratory' },
    { name: 'Prednisolone 20mg Tablet', generic: 'Prednisolone', form: 'Tablet', strength: '20mg', unit: 'tablet', category: 'Respiratory' },

    // Supplies
    { name: 'Examination Gloves (Latex) Medium', generic: 'Gloves', form: 'Box', strength: 'Medium', unit: 'box', category: 'Supply' },
    { name: 'Examination Gloves (Latex) Large', generic: 'Gloves', form: 'Box', strength: 'Large', unit: 'box', category: 'Supply' },
    { name: 'Surgical Mask 3-ply', generic: 'Mask', form: 'Box', strength: 'Standard', unit: 'box', category: 'Supply' },
    { name: 'Cotton Wool 500g', generic: 'Cotton', form: 'Roll', strength: '500g', unit: 'roll', category: 'Supply' },
    { name: 'Gauze Bandage 10cm', generic: 'Bandage', form: 'Roll', strength: '10cm x 5m', unit: 'roll', category: 'Supply' },
    { name: 'Syringe 2ml with Needle', generic: 'Syringe', form: 'Unit', strength: '2ml', unit: 'piece', category: 'Supply' },
    { name: 'Syringe 10ml with Needle', generic: 'Syringe', form: 'Unit', strength: '10ml', unit: 'piece', category: 'Supply' },
    { name: 'IV Set (Adult)', generic: 'IV Set', form: 'Unit', strength: 'Standard', unit: 'piece', category: 'Supply' },
    { name: 'Ringer Lactate 500ml', generic: 'Ringer Lactate', form: 'IV Fluid', strength: '1000ml', unit: 'bottle', category: 'Fluids' },
    { name: 'Dextrose 5% 500ml', generic: 'Dextrose', form: 'IV Fluid', strength: '5%', unit: 'bottle', category: 'Fluids' }
];

async function seedMasterProducts() {
    console.log(`Starting master product seeding... (${ESSENTIAL_MEDICINES.length} items)`);

    // 1. Get All Facilities
    const { data: facilities, error: facError } = await supabaseAdmin
        .from('facilities')
        .select('id, tenant_id, name');

    if (facError || !facilities?.length) {
        throw new Error('No facilities found.');
    }
    console.log(`Found ${facilities.length} facilities. Seeding for all...`);

    let totalInserted = 0;

    for (const facility of facilities) {
        console.log(`Processing facility: ${facility.name} (${facility.id})`);

        // 2. Get User for Created By (per facility or failover)
        let userId: string | null = null;
        const { data: users } = await supabaseAdmin.from('users').select('id').eq('facility_id', facility.id).limit(1);
        userId = users?.[0]?.id || null;

        if (!userId) {
            const { data: anyUser } = await supabaseAdmin.from('users').select('id').limit(1);
            userId = anyUser?.[0]?.id || null;
        }

        if (!userId) {
            console.warn(`No user found for facility ${facility.name}, skipping attribution.`);
        }

        let insertedCount = 0;
        let skippedCount = 0;

        for (const item of ESSENTIAL_MEDICINES) {
            // Check existence
            const { data: existing } = await supabaseAdmin
                .from('inventory_items')
                .select('id')
                .eq('facility_id', facility.id)
                .eq('name', item.name)
                .maybeSingle();

            if (existing) {
                skippedCount++;
                continue;
            }

            const { error } = await supabaseAdmin
                .from('inventory_items')
                .insert({
                    facility_id: facility.id,
                    tenant_id: facility.tenant_id,
                    name: item.name,
                    generic_name: item.generic,
                    dosage_form: item.form,
                    strength: item.strength,
                    unit_of_measure: item.unit,
                    category: item.category === 'Supply' || item.category === 'Fluids' ? 'Supply' : 'Drug',
                    reorder_level: 20,
                    max_stock_level: 500,
                    created_by: userId,
                    is_active: true
                });

            if (error) {
                console.error(`Error inserting ${item.name}:`, error.message);
            } else {
                insertedCount++;
            }
        }
        console.log(`  -> Inserted: ${insertedCount}, Skipped: ${skippedCount}`);
        totalInserted += insertedCount;
    }

    console.log(`Seeding complete. Total Inserted across all facilities: ${totalInserted}`);
}

seedMasterProducts().catch(console.error);
