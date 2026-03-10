import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import invariant from 'tiny-invariant';

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

type SupabaseAdminClient = SupabaseClient<any, any, any>;

declare global {
    // Test bootstrap can inject a lightweight in-memory Supabase mock.
    // eslint-disable-next-line no-var
    var __SUPABASE_ADMIN_MOCK__: unknown;
}

const isTestEnv = process.env.NODE_ENV === 'test';
const resolvedSupabaseUrl = SUPABASE_URL || (isTestEnv ? 'http://127.0.0.1:54321' : undefined);
const resolvedServiceRoleKey = SUPABASE_SERVICE_ROLE_KEY || (isTestEnv ? 'test-service-role-key' : undefined);

invariant(resolvedSupabaseUrl, 'SUPABASE_URL is required');
invariant(resolvedServiceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required');

const defaultSupabaseAdmin = createClient(resolvedSupabaseUrl, resolvedServiceRoleKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    },
});

const injectedSupabaseMock = globalThis.__SUPABASE_ADMIN_MOCK__ as SupabaseAdminClient | undefined;
export const supabaseAdmin: SupabaseAdminClient = injectedSupabaseMock || defaultSupabaseAdmin;
