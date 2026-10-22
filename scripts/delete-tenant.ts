/**
 * Permanently delete a tenant workspace (feature-plan-terms-compliance-fixes.md §5.3; logic in
 * src/lib/tenant/delete-tenant.ts). THIS IS IRREVERSIBLE once the database step runs.
 *
 * Only run this against a throwaway LOCAL tenant you created for a test. NEVER against a demo tenant
 * (acme, globex, initech — they are lifecycle-exempt and refused without --include-exempt) or any remote
 * database unless you are the founder doing a real, authorized deletion.
 *
 * Usage (npm run tenant:delete -- <slug> [flags]):
 *   <slug>                                   dry run: preconditions, database classification, Stripe summary
 *   <slug> --yes                             apply (or resume an interrupted run)
 *   --force-with-reason "<text>"             bypass the deletion-date / notice checks (audited)
 *   --include-exempt                         allow deleting a lifecycle-exempt workspace
 *   --drop-shared-database                   allow dropping a database inside the control plane's Neon project
 *
 * Required env (.env.local then .env): CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY, STRIPE_SECRET_KEY (if the
 * tenant has a Stripe customer), NEON_API_KEY (dedicated Neon project).
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });

import { deleteTenant, type DeletionReceipt } from '../src/lib/tenant/delete-tenant';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} requires a value.`);
  return v;
}

function printReceipt(r: DeletionReceipt) {
  const iso = (d: Date | null) => d?.toISOString() ?? '(none)';
  console.log('--- Deletion receipt ---');
  console.log(`  slug:                    ${r.slug}`);
  console.log(`  name:                    ${r.name}`);
  console.log(`  status:                  ${r.status}`);
  console.log(`  deletion_scheduled_for:  ${iso(r.deletionScheduledFor)}`);
  console.log(`  deleted_at:              ${iso(r.deletedAt)}`);
  console.log(`  database:                ${r.database}`);
  if (r.forcedReason) console.log(`  FORCED:                  ${r.forcedReason}`);
  if (r.founderExportDestroyBy) console.log(`  founder export: DESTROY BY ${iso(r.founderExportDestroyBy)} (then: npm run tenant:admin -- export-destroyed ${r.slug} --yes)`);
  console.log(`  notices (${r.notices.length}):`);
  for (const n of r.notices) {
    const state = n.sentAt ? `sent ${iso(n.sentAt)}` : n.forcedAt ? `FORCED ${iso(n.forcedAt)}` : n.supersededAt ? 'superseded' : 'NOT SENT';
    console.log(`    ${n.kind.padEnd(24)} anchor ${iso(n.anchor)}  ${state}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--force-with-reason']);
  const slug = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  if (!slug) fail('Usage: tenant:delete -- <slug> [--yes] [--force-with-reason "<text>"] [--include-exempt] [--drop-shared-database]');

  const result = await deleteTenant({
    slug,
    apply: args.includes('--yes'),
    forceWithReason: flagValue(args, '--force-with-reason'),
    includeExempt: args.includes('--include-exempt'),
    dropSharedDatabase: args.includes('--drop-shared-database'),
    actor: `founder:${process.env.USER ?? 'unknown'}`,
  });

  switch (result.outcome) {
    case 'dry-run':
      if (result.problems.length > 0) {
        console.log('\nNot eligible:');
        for (const p of result.problems) console.log(`  - ${p}`);
      } else {
        console.log('\nEligible. Steps on --yes: reconcile + set deleting → cancel DUNNING/paused subscriptions and close open invoices → preflight → delete the database → tombstone.');
      }
      console.log('\nDry run — pass --yes to apply.');
      break;
    case 'deleted':
      console.log('\n✓ Deletion complete.\n');
      printReceipt(result.receipt);
      break;
    case 'already-deleted':
      console.log('Already deleted. Tombstone:');
      printReceipt(result.receipt);
      break;
    case 'aborted':
      fail(`Aborted (the workspace was restored if it was being deleted): ${result.reason}`);
    case 'stopped':
      fail(`Stopped: ${result.reason}`);
    case 'refused':
      fail(result.reason);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('tenant:delete failed:', err?.message ?? err);
  process.exit(1);
});
