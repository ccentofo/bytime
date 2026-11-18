import { defineConfig } from 'drizzle-kit';
import { postgresJsUrl } from './src/lib/db/pg-url';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // url-fix: drizzle-kit connects with postgres.js (pg isn't installed), which forwards unknown URL keys such as
    // Neon's channel_binding to the server as startup settings; reduce the query to sslmode.
    url: postgresJsUrl(process.env.DATABASE_URL ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime'),
  },
});
