import { existsSync } from 'fs';
import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';

const backendRoot = resolve(__dirname, '..', '..');

const envCandidates = [
  resolve(backendRoot, '.env'),
  resolve(process.cwd(), 'link-be/.env'),
  resolve(process.cwd(), '.env'),
];

const seen = new Set<string>();
for (const envPath of envCandidates) {
  if (seen.has(envPath)) continue;
  seen.add(envPath);
  if (!existsSync(envPath)) continue;
  loadDotenv({ path: envPath });
  break;
}
