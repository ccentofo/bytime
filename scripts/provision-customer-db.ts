/**
 * Provision a customer database with an admin user and default indirect codes.
 * Usage: npx tsx scripts/provision-customer-db.ts <email> <name> <password>
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import bcrypt from 'bcryptjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: provision-customer-db.ts <email> <name> <password>');
  process.exit(1);
}

const client = postgres(connectionString, { max: 1, prepare: false });
const db = drizzle(client);

async function provision() {
  // Create admin user
  const hash = await bcrypt.hash(password, 12);
  await db.insert(schema.users).values({
    email: email.toLowerCase().trim(),
    fullName: name.trim(),
    role: 'admin',
    passwordHash: hash,
    isActive: true,
  });
  console.log(`✓ Admin user created: ${email}`);

  // Seed default indirect codes
  const defaults = [
    { code: 'OH-001', name: 'Overhead', category: 'overhead' as const, description: 'General overhead' },
    { code: 'GA-001', name: 'General & Administrative', category: 'ga' as const, description: 'G&A expenses' },
    { code: 'IRAD-001', name: 'IR&D', category: 'irad' as const, description: 'Independent R&D' },
    { code: 'BP-001', name: 'Bid & Proposal', category: 'bp' as const, description: 'Proposal preparation' },
    { code: 'LV-AL', name: 'Annual Leave', category: 'leave' as const, description: 'Paid annual leave' },
    { code: 'LV-SL', name: 'Sick Leave', category: 'leave' as const, description: 'Paid sick leave' },
    { code: 'LV-HOL', name: 'Holiday', category: 'leave' as const, description: 'Company-observed holiday' },
    { code: 'LV-LWOP', name: 'Leave Without Pay', category: 'leave' as const, description: 'Unpaid leave' },
    { code: 'UA-001', name: 'Unallowable', category: 'unallowable' as const, description: 'Non-reimbursable' },
  ];

  await db.insert(schema.indirectChargeCodes).values(defaults);
  console.log('✓ 9 default indirect codes seeded');

  // Create default notification preferences for admin
  const [adminUser] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (adminUser) {
    await db.insert(schema.notificationPreferences).values({ userId: adminUser.id });
    console.log('✓ Notification preferences created');
  }

  await client.end();
  console.log('\n✓ Database provisioned successfully');
}

provision().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
