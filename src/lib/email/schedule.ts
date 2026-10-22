import { after } from 'next/server';
import * as Sentry from '@sentry/nextjs';

/**
 * Schedule email work from a server action to run after the response is sent (Next 16 `after()`). The callback
 * never rejects: a failure is logged and reported, and the action that scheduled it is unaffected. Must be called
 * inside a request scope (`after()` throws outside one); read request data (tenant slug, headers) BEFORE calling.
 */
export function scheduleEmail(label: string, work: () => Promise<unknown>): void {
  after(async () => {
    try {
      await work();
    } catch (err) {
      console.error(`Scheduled email work failed (${label}):`, err instanceof Error ? err.message : err);
      Sentry.captureException(err, { tags: { emailWork: label } });
    }
  });
}
