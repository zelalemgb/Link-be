import 'dotenv/config';
import { supabaseAdmin } from './config/supabase';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migration = '20260108170000_create_finance_reconciliations.sql';

async function run() {
    console.log(`Applying ${migration}...`);
    const filePath = join(__dirname, '..', '..', 'link-be', 'supabase', 'migrations', migration);

    try {
        const sql = readFileSync(filePath, 'utf-8');
        console.log(`Read ${sql.length} characters`);

        let { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });

        if (error) {
            console.log("exec_sql failed or not found, trying split execution...", error.message);
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
                    throw stmtError;
                }
            }
        }
        console.log("Success! Migration applied.");
    } catch (e: any) {
        console.error("Migration failed:", e.message);
        process.exit(1);
    }
}

run();
