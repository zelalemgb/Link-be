import { supabaseAdmin } from '../server/config/supabase';

async function queryData() {
    // Find Zelalem Hospital
    const { data: facilities, error: facilityError } = await supabaseAdmin
        .from('facilities')
        .select('id, name')
        .ilike('name', '%Zelalem%')
        .limit(5);

    if (facilityError) {
        console.error('Facility error:', facilityError);
    } else {
        console.log('Facilities:', JSON.stringify(facilities, null, 2));
    }

    // Get patients from Zelalem Hospital
    if (facilities && facilities.length > 0) {
        const facilityId = facilities[0].id;
        const { data: patients, error: patientError } = await supabaseAdmin
            .from('patients')
            .select('id, full_name, first_name, last_name, phone_number, facility_id')
            .eq('facility_id', facilityId)
            .limit(10);

        if (patientError) {
            console.error('Patient error:', patientError);
        } else {
            console.log('\nPatients:', JSON.stringify(patients, null, 2));
        }

        // Get active visits for these patients
        if (patients && patients.length > 0) {
            const patientId = patients[0].id;
            const { data: visits, error: visitError } = await supabaseAdmin
                .from('visits')
                .select('*')
                .eq('patient_id', patientId)
                .order('visit_date', { ascending: false })
                .limit(5);

            if (visitError) {
                console.error('Visit error:', visitError);
            } else {
                console.log('\nRecent visits for', patients[0].full_name, ':', JSON.stringify(visits, null, 2));
            }
        }
    }
}

queryData().catch(console.error);
