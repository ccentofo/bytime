import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. See .env.example for required environment variables.'
  );
}

// Connection pool configuration
// - max: 10 for dev, Neon free tier handles up to 20
// - idle_timeout: 20 seconds
// - connect_timeout: 10 seconds (Neon cold starts can be slow)
// - prepare: false (required for Neon serverless)
const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export const db = drizzle(client, { schema });
