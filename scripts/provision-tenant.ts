/**
 * Operator fallback: provision a tenant without the public signup flow.
 *
 *   npm run provision:tenant -- <slug> <name> <admin-email> <admin-name>
 *
 * Runs under Node's `react-server` export condition (see package.json) so the `server-only`
 * guard in src/lib/tenant/* resolves to its no-op build. Requires the `server-only` package to be
 * installed as a real dependency. Needs CONTROL_PLANE_DATABASE_URL, ENCRYPTION_KEY (same as the
 * app), and NEON_API_KEY (+ NEON_REGION_ID) in production.
 */
import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });
import { provisionTenant } from '../src/lib/tenant/provision';
import { localDevAdminUrl } from '../src/lib/tenant/neon';
import { printTargetBanner } from './lib/target';
import { provisionWithoutNeonRefusal } from './lib/provision-guard';

const [slug, name, adminEmail, adminName] = process.argv.slice(2);
if (!slug || !name || !adminEmail || !adminName) {
  console.error('Usage: npm run provision:tenant -- <slug> <name> <admin-email> <admin-name>');
  process.exit(1);
}

printTargetBanner();
// feature-plan-launch-blockers.md P6 §5: without a Neon key provisioning creates a database on the admin server —
// only acceptable when that server is local.
const refusal = provisionWithoutNeonRefusal(process.env, localDevAdminUrl());
if (refusal) {
  console.error(`✗ ${refusal}`);
  process.exit(1);
}

provisionTenant({ slug, name, adminEmail, adminName })
  .then((r) => {
    console.log(`✓ Provisioned tenant "${r.slug}" (admin user ${r.adminUserId}).`);
    console.log('  The admin must set their password via the invite link (signup/onboarding flow).');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Provisioning failed:', err);
    process.exit(1);
  });
