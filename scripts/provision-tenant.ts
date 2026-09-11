import 'dotenv/config';
import { provisionTenant } from '../src/lib/tenant/provision';

const [slug, name, adminEmail, adminName] = process.argv.slice(2);
if (!slug || !name || !adminEmail || !adminName) {
  console.error('Usage: tsx scripts/provision-tenant.ts <slug> <name> <admin-email> <admin-name>');
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
