/**
 * Re-seed dev database users with default passwords.
 * Run with: npx tsx scripts/seed-users.ts
 *
 * This script is needed when the users table has been cleared
 * (e.g., by integration tests accidentally running against the dev DB).
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

async function seedUsers() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  const defaultPassword = 'Password123!';
  const hash = await bcrypt.hash(defaultPassword, 12);

  const seedData = [
    { email: 'admin@bytime.dev', fullName: 'Admin User', role: 'admin' as const, passwordHash: hash },
    { email: 'jane.smith@bytime.dev', fullName: 'Jane Smith', role: 'employee' as const, passwordHash: hash },
    { email: 'john.doe@bytime.dev', fullName: 'John Doe', role: 'employee' as const, passwordHash: hash },
    { email: 'sarah.wilson@bytime.dev', fullName: 'Sarah Wilson', role: 'supervisor' as const, passwordHash: hash },
  ];

  console.log('Seeding users...');

  for (const user of seedData) {
    const existing = await db.select().from(users).where(eq(users.email, user.email));
    if (existing.length > 0) {
      await db.update(users)
        .set({ passwordHash: user.passwordHash, isActive: true })
        .where(eq(users.email, user.email));
      console.log(`  Updated: ${user.email} (${user.role})`);
    } else {
      await db.insert(users).values(user);
      console.log(`  Created: ${user.email} (${user.role})`);
    }
  }

  console.log('\nAll users seeded. Password: Password123!');
  await client.end();
  process.exit(0);
}

seedUsers();
