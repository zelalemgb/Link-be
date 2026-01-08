#!/usr/bin/env tsx
/**
 * Migration runner script
 * Applies pending SQL migrations to the Supabase database
 */

import 'dotenv/config';
import { supabaseAdmin } from './config/supabase';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrations = [
    '20260105153000_fix_billing_and_payment_rls.sql'
];

async function runMigrations() {
    console.log('🔄 Starting migration process...\n');

    for (const migration of migrations) {
        const filePath = join(__dirname, '..', 'supabase', 'migrations', migration);
        console.log(`📄 Applying: ${migration}`);

        try {
            const sql = readFileSync(filePath, 'utf-8');

            // Execute the SQL using Supabase admin client
            // Execute the SQL using Supabase admin client
            let { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });

            if (error && (error.code === '42883' || error.code === 'PGRST202' || error.message?.includes('Could not find the function') || error.message?.includes('function not found'))) {
                // If exec_sql doesn't exist, try direct SQL execution
                // Split by semicolons and execute each statement
                const statements = sql
                    .split(';')
                    .map(s => s.trim())
                    .filter(s => s.length > 0 && !s.startsWith('--'));

                for (const statement of statements) {
                    const { error: stmtError } = await (supabaseAdmin as any).rpc('exec', {
                        query: statement
                    });
                    if (stmtError) {
                        error = stmtError;
                        break;
                    }
                    // Clear error if successful
                    error = null;
                }
            }

            if (error) {
                console.error(`❌ Error applying ${migration}:`, error);
                process.exit(1);
            }

            console.log(`✅ Successfully applied: ${migration}\n`);
        } catch (err: any) {
            console.error(`❌ Failed to apply ${migration}:`, err.message);
            console.log('\n⚠️  You may need to apply this migration manually using psql or Supabase dashboard.\n');
            process.exit(1);
        }
    }

    console.log('✨ All migrations applied successfully!');
    process.exit(0);
}

runMigrations();
