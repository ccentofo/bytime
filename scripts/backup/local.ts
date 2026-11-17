/**
 * Local runner (feature-plan-database-backups.md §6.10): `npm run backup:local -- backup --dry-run` lists the targets and
 * each server's version against a LOCAL control plane, with no AWS. Loads .env.local then .env like the sibling scripts;
 * the bundled entry (main.ts) never loads dotenv. Outside ECS, main() refuses everything else.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

import { main } from './main';
import { installCrashHandler } from './lib/summarize-error';

installCrashHandler((l) => console.error(l));
void main(process.argv.slice(2), process.env).then((code) => process.exit(code));
