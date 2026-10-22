/**
 * Founder-held workspace export (feature-plan-terms-compliance-fixes.md §5.3 "Founder export", F2).
 *
 * NOT taken by default — only when the customer asks for it to be sent, or for a legal request. The output is
 * AES-256 encrypted, written outside the repo and outside any synced folder, and excluded from Time Machine.
 * It must be destroyed once delivered, and always by its destroy-by date (recorded here; the ops digest alerts
 * when it passes). Never email it unencrypted: send an expiring link, and the password separately.
 *
 * Usage:  npm run tenant:export -- <slug> <out-dir>
 * Decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <file> -out <file>.zip
 *
 * Required env (.env.local then .env): CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { tenants } from '../src/db/control-plane/schema';
import { withLockedPool } from '../src/db/control-plane/locked';
import { decrypt } from '../src/lib/encryption';
import { createWorkspaceZipStream, openExportSnapshot } from '../src/lib/export/workspace-export';
import { addDays } from '../src/lib/tenant/lifecycle';
import { BACKUP_RETENTION_DAYS } from '../src/lib/tenant/lifecycle-config';
import { recordAudit } from '../src/lib/tenant/lifecycle-store';
import { refusedOutputReason } from '../src/lib/export/founder-export-path';

const PBKDF2_ITERATIONS = 600_000;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function excludeFromTimeMachine(dir: string) {
  try {
    execFileSync('tmutil', ['addexclusion', dir], { stdio: 'pipe' });
    const out = execFileSync('tmutil', ['isexcluded', dir], { encoding: 'utf8' });
    if (!out.includes('[Excluded]')) throw new Error(out.trim());
  } catch (err) {
    fail(`Could not exclude ${dir} from Time Machine (tmutil): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const [slug, outArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!slug || !outArg) fail('Usage: npm run tenant:export -- <slug> <out-dir>');

  const [t] = await withLockedPool((db) => db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
  if (!t) fail(`No tenant with slug "${slug}".`);
  if (t.status === 'deleted' || !t.dbUrlEncrypted) fail('The workspace is deleted; there is nothing to export.');

  const home = realpathSync.native(homedir());
  const repoRoot = realpathSync.native(process.cwd());
  const requested = path.resolve(outArg);
  // Check the nearest existing ancestor's real path BEFORE creating anything.
  let probe = requested;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const realProbe = realpathSync.native(probe);
  const outDir = path.join(realProbe, path.relative(probe, requested));
  const reason = refusedOutputReason(outDir, repoRoot, home);
  if (reason) fail(`Refusing to write the export ${reason}: ${outDir}`);

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  excludeFromTimeMachine(outDir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${slug}-export-${stamp}.zip.enc`);
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(8);
  const keyIv = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', keyIv.subarray(0, 32), keyIv.subarray(32, 48));

  let header = true;
  const prefixSalt = new Transform({
    transform(chunk, _enc, cb) {
      if (header) {
        header = false;
        this.push(Buffer.concat([Buffer.from('Salted__'), salt]));
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (header) this.push(Buffer.concat([Buffer.from('Salted__'), salt]));
      cb();
    },
  });

  console.log(`Exporting ${slug} → ${outFile}`);
  let streamError: unknown = null;
  try {
    const snapshot = await openExportSnapshot(decrypt(t.dbUrlEncrypted));
    const zipStream = createWorkspaceZipStream(snapshot, {
      tenantSlug: slug,
      onError: (err) => { streamError = err; },
    });
    await pipeline(Readable.fromWeb(zipStream as import('node:stream/web').ReadableStream), cipher, prefixSalt, createWriteStream(outFile, { mode: 0o600 }));
    if (streamError) throw streamError;
  } catch (err) {
    rmSync(outFile, { force: true });
    fail(`Export failed; partial output deleted: ${err instanceof Error ? err.message : String(err)}`);
  }

  const destroyBy = addDays(new Date(), BACKUP_RETENTION_DAYS);
  try {
    await withLockedPool((db) => recordAudit(db, {
      tenantId: t.id,
      kind: 'founder-export-taken',
      actor: `founder:${process.env.USER ?? 'unknown'}`,
      detail: JSON.stringify({ path: outFile, destroyBy: destroyBy.toISOString() }),
    }));
  } catch (err) {
    // An untracked copy must not exist: no audit record → no file.
    rmSync(outFile, { force: true });
    fail(`Could not record the export (file deleted): ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('\n✓ Encrypted export written.');
  console.log(`  File:       ${outFile}`);
  console.log(`  Password:   ${password}   (shown ONCE — never stored; send it separately from the file)`);
  console.log(`  Destroy by: ${destroyBy.toISOString()} (or 30 days after the workspace is deleted, if sooner)`);
  console.log(`  Decrypt:    openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITERATIONS} -md sha256 -in "${outFile}" -out "${outFile.replace(/\.enc$/, '')}"`);
  console.log(`  After destroying every copy: npm run tenant:admin -- export-destroyed ${slug} --yes`);
  process.exit(0);
}

main().catch((err) => {
  console.error('tenant:export failed:', err?.message ?? err);
  process.exit(1);
});
