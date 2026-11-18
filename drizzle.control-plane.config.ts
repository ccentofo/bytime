import { defineConfig } from 'drizzle-kit';
import { postgresJsUrl } from './src/lib/db/pg-url';

export default defineConfig({
  schema: './src/db/control-plane/schema.ts',
  out: './drizzle/control-plane',
  dialect: 'postgresql',
  dbCredentials: {
    // url-fix: drizzle-kit connects with postgres.js (pg isn't installed), which forwards unknown URL keys such as
    // Neon's channel_binding to the server as startup settings; reduce the query to sslmode.
    url: postgresJsUrl(process.env.CONTROL_PLANE_DATABASE_URL ?? ''),
  },
});
