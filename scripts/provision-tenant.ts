/**
 * Operator fallback: provision a tenant without the public signup flow.
 *
 *   npm run provision:tenant -- <slug> <name> <admin-email> <admin-name> \
 *     --terms-version <version> --terms-accepted-at <ISO date-time>      # from the customer's signed agreement
 *   npm run provision:tenant -- <slug> <name> <admin-email> <admin-name> --no-terms-record
 *
 * Launch-blockers audit §5: the tenant row holds the Terms version + acceptance time (proof of contract, LB-D5), and
 * the workspace's audit trail records where it came from — or, with --no-terms-record, that there was none.
 *
 * Runs under Node's `react-server` export condition (see package.json) so the `server-only`
 * guard in src/lib/tenant/* resolves to its no-op build. Requires the `server-only` package to be
 * installed as a real dependency. Needs CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY (same as the
 * app), and NEON_API_KEY (+ NEON_REGION_ID) in production.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });
import { provisionTenant } from '../src/lib/tenant/provision';
import { getTenantBySlug } from '../src/lib/tenant/registry';
import { recordProvisionTerms } from '../src/lib/tenant/admin-commands';
import { parseProvisionArgs } from './lib/provision-args';
import { localDevAdminUrl } from '../src/lib/tenant/neon';
import { printTargetBanner } from './lib/target';
import { provisionWithoutNeonRefusal } from './lib/provision-guard';

const args = parseProvisionArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(`✗ ${args.error}`);
  process.exit(1);
}
const { slug, name, adminEmail, adminName, terms } = args;

printTargetBanner();
// feature-plan-launch-blockers.md P6 §5: without a Neon key provisioning creates a database on the admin server —
// only acceptable when that server is local.
const refusal = provisionWithoutNeonRefusal(process.env, localDevAdminUrl());
if (refusal) {
  console.error(`✗ ${refusal}`);
  process.exit(1);
}

provisionTenant({
  slug, name, adminEmail, adminName,
  ...(terms === 'none' ? {} : { termsVersion: terms.version, termsAcceptedAt: terms.acceptedAt }),
})
  .then(async (r) => {
    const tenant = await getTenantBySlug(r.slug);
    if (!tenant) throw new Error(`Provisioned "${r.slug}" but it is not in the registry — check tenant:admin show.`);
    await recordProvisionTerms(tenant.id, terms, 'founder (provision:tenant)');
    console.log(`✓ Provisioned tenant "${r.slug}" (admin user ${r.adminUserId}).`);
    console.log(terms === 'none'
      ? '  ⚠ No Terms record — noted on the workspace audit trail ("provisioned without a Terms record").'
      : `  Terms ${terms.version} accepted ${terms.acceptedAt.toISOString()} recorded on the workspace and audited.`);
    console.log('  The admin must set their password via the invite link (signup/onboarding flow).');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Provisioning failed:', err);
    process.exit(1);
  });
