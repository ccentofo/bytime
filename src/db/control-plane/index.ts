import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

function getControlDb() {
  const url = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!url) {
    throw new Error('CONTROL_PLANE_DATABASE_URL is not set. See .env.example.');
  }
  // Small pool — the registry is read-light and cached in front of.
  const client = postgres(url, { max: 5, prepare: false });
  return drizzle(client, { schema });
}

// Lazily initialized singleton — not constructed at import time so the build
// succeeds without CONTROL_PLANE_DATABASE_URL being set.
let _controlDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getControlDbInstance() {
  if (!_controlDb) _controlDb = getControlDb();
  return _controlDb;
}

// Named export for direct use — callers get the singleton on first access.
export const controlDb = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getControlDbInstance() as any)[prop];
  },
});

export { schema as controlSchema };
