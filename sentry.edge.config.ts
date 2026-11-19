import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // 'production' / 'staging' / 'development' (feature-plan-launch-blockers.md P6 §7). Unset → Sentry's default.
  environment: process.env.SENTRY_ENVIRONMENT,

  // Trace sampling. Defaults to 0.1 in production; override via SENTRY_TRACES_SAMPLE_RATE.
  // Set to 1 only in dev/staging when you need full traces.
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : (process.env.NODE_ENV === 'production' ? 0.1 : 1),

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // feature-plan-cloud-export.md §6.6: the export download link's token never reaches Sentry (URLs, transaction names,
  // spans, breadcrumbs).
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
