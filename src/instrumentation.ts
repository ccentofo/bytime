import * as Sentry from '@sentry/nextjs';

// Next.js calls register() once per server instance, in both the Node.js and Edge runtimes.
// This is what actually loads Sentry on the server — without this file, sentry.server.config.ts
// and sentry.edge.config.ts are never imported and server errors are never reported.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
    // Fail loudly at boot (not at the first decrypt) if a production deploy is missing a valid ENCRYPTION_KEY.
    if (process.env.NODE_ENV === 'production' && !/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY ?? '')) {
      console.error('FATAL: ENCRYPTION_KEY must be set to 64 hex characters in production (openssl rand -hex 32).');
    }
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Reports errors thrown in Server Components, route handlers, server actions, and the proxy.
export const onRequestError = Sentry.captureRequestError;
