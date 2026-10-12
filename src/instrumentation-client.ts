import * as Sentry from '@sentry/nextjs';

// Browser-side Sentry init. Next.js loads this file automatically before the app hydrates
// (replaces the legacy sentry.client.config.ts convention).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Trace sampling. Defaults to 0.1 in production; override via SENTRY_TRACES_SAMPLE_RATE.
  // Set to 1 only in dev/staging when you need full traces.
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : (process.env.NODE_ENV === 'production' ? 0.1 : 1),

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,
});

// Lets Sentry trace client-side navigations.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
