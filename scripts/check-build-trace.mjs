/**
 * After `next build`: the signup-verify route provisions tenants by running drizzle's migrator, which reads
 * ./drizzle/*.sql at RUNTIME. Fail if any migration file is missing from that route's file trace — otherwise
 * every signup on Vercel creates a database and then fails to migrate it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const traceFile = '.next/server/app/signup/verify/route.js.nft.json';
const traced = new Set(
  JSON.parse(readFileSync(traceFile, 'utf8')).files.map((f) => path.normalize(path.join(path.dirname(traceFile), f))),
);
const required = readdirSync('drizzle')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => path.normalize(path.join('drizzle', f)))
  .concat([path.normalize('drizzle/meta/_journal.json')]);
const missing = required.filter((f) => !traced.has(f));
if (missing.length > 0) {
  console.error(`✗ ${missing.length} migration file(s) missing from ${traceFile}:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ All ${required.length} tenant migration files are in the signup route's build trace.`);
