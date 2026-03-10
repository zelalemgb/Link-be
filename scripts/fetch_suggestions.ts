import 'dotenv/config';
import { supabaseAdmin } from '../server/config/supabase';

async function fetchSuggestions() {
    console.log('Fetching suggestions...');
    try {
        const { data, error } = await supabaseAdmin
            .from('feature_requests')
            .select('*')
            .order('created_at', { ascending: false })
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching suggestions:', error);
        } else {
            console.log('Suggestions found:', data.length);
            console.log(JSON.stringify(data, null, 2));
        }
    } catch (err) {
        console.error('Unexpected error:', err);
    }
}

fetchSuggestions();
