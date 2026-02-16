import 'dotenv/config';
import { supabaseAdmin } from '../server/config/supabase';

async function summarizeSuggestions() {
    console.log('Summarizing suggestions...');
    try {
        const { data, error } = await supabaseAdmin
            .from('feature_requests')
            .select('id, description, facility_id, request_type, created_at, status')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching suggestions:', error);
            return;
        }

        const total = data.length;
        console.log(`Total suggestions found: ${total}`);

        // Group by Facility
        const byFacility = data.reduce((acc, curr) => {
            const fid = curr.facility_id || 'Unknown/System';
            acc[fid] = (acc[fid] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        console.log('\nBy Facility:');
        Object.entries(byFacility).forEach(([fid, count]) => {
            console.log(`- ${fid}: ${count}`);
        });

        // Group by Type
        const byType = data.reduce((acc, curr) => {
            const type = curr.request_type || 'Unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        console.log('\nBy Type:');
        Object.entries(byType).forEach(([type, count]) => {
            console.log(`- ${type}: ${count}`);
        });

        console.log('\nRecent 10 Suggestions:');
        data.slice(0, 10).forEach(s => {
            console.log(`[${new Date(s.created_at).toLocaleDateString()}] ${s.request_type}: ${s.description.substring(0, 100).replace(/\n/g, ' ')}...`);
        });

    } catch (err) {
        console.error('Unexpected error:', err);
    }
}

summarizeSuggestions();
