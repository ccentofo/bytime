import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Connection pool configuration for Next.js
// - max: 10 connections (sufficient for single-instance dev/production)
// - idle_timeout: 20 seconds (release idle connections)
// - connect_timeout: 5 seconds (fail fast on connection issues)
const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 5,
  prepare: false, // Required for some serverless environments
});

export const db = drizzle(client, { schema });
