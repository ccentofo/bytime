import * as Sentry from '@sentry/nextjs';

// Next.js calls register() once per server instance, in both the Node.js and Edge runtimes.
// This is what actually loads Sentry on the server — without this file, sentry.server.config.ts
// and sentry.edge.config.ts are never imported and server errors are never reported.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Reports errors thrown in Server Components, route handlers, server actions, and the proxy.
export const onRequestError = Sentry.captureRequestError;
