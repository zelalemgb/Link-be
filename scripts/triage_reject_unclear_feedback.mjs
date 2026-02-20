import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const REJECTIONS = [
  {
    id: '4855a35e-e39a-418f-a089-7e7846e334f7',
    admin_notes: 'Rejected: test submission/no actionable requirement.',
  },
  {
    id: '373fa61a-64e3-446c-9edb-e2285bbf67fb',
    admin_notes: 'Rejected: test submission/no actionable requirement.',
  },
  {
    id: 'b1e12a16-3f42-44c2-82d1-f7dfbd06aba8',
    admin_notes: 'Rejected: unclear request. Please resubmit with page/flow and expected result.',
  },
  {
    id: 'decb7eca-acc9-4866-bc17-a4e9c50c99c3',
    admin_notes: 'Rejected: unclear/duplicate. Please reference exact page and time fields.',
  },
];

const redact = (value) => (value ? `${value.slice(0, 4)}...${value.slice(-4)}` : 'missing');

async function applyViaSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) return false;
  if (serviceRoleKey === 'test-service-role-key') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is test placeholder; provide a real service-role key.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const item of REJECTIONS) {
    const { data, error } = await client
      .from('feature_requests')
      .update({
        status: 'rejected',
        admin_notes: item.admin_notes,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', item.id)
      .select('id,status,admin_notes')
      .single();

    if (error) {
      throw new Error(`Supabase update failed for ${item.id}: ${error.message}`);
    }

    console.log(`updated ${data.id} -> ${data.status}`);
  }

  return true;
}

async function applyViaApi() {
  const apiBase = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.ADMIN_BEARER_TOKEN;
  if (!apiBase || !token) return false;

  for (const item of REJECTIONS) {
    const response = await fetch(`${apiBase}/feature-requests/${item.id}/status`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'rejected',
        admin_notes: item.admin_notes,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API update failed for ${item.id}: HTTP ${response.status} ${text}`);
    }

    const data = await response.json();
    console.log(`updated ${data.id || item.id} -> ${data.status || 'rejected'}`);
  }

  return true;
}

async function main() {
  try {
    const viaSupabase = await applyViaSupabase();
    if (viaSupabase) return;

    const viaApi = await applyViaApi();
    if (viaApi) return;

    throw new Error(
      [
        'No privileged credentials provided for status mutation.',
        `SUPABASE_URL=${redact(process.env.SUPABASE_URL)}`,
        `SUPABASE_SERVICE_ROLE_KEY=${redact(process.env.SUPABASE_SERVICE_ROLE_KEY)}`,
        `API_BASE_URL=${process.env.API_BASE_URL || 'missing'}`,
        `ADMIN_BEARER_TOKEN=${redact(process.env.ADMIN_BEARER_TOKEN)}`,
      ].join('\n')
    );
  } catch (error) {
    console.error(String(error?.message || error));
    process.exit(1);
  }
}

main();
