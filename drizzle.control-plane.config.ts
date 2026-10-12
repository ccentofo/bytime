import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/control-plane/schema.ts',
  out: './drizzle/control-plane',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.CONTROL_PLANE_DATABASE_URL ?? '',
  },
});
