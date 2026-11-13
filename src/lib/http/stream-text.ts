import * as Sentry from '@sentry/nextjs';

/** Items per chunk (feature-plan-large-report-responses.md §6.1). */
export const STREAM_BATCH = 1_000;

/**
 * Streams `head + items.join(separator) + tail`, `batch` items per chunk, pulled on demand
 * (feature-plan-large-report-responses.md §6.1). Server-only use.
 *
 * Every string is prepared BEFORE the stream exists (by the caller), so anything that can fail has already failed with a
 * proper status code; the stream only slices and encodes. Chunks: the head, then one per batch (every batch after the
 * first starts with the separator), then the tail. A chunk is never empty: an empty head or tail is skipped.
 *
 * Rule: every `pull` either enqueues exactly one non-empty chunk or closes the stream (a pull that does neither hangs the
 * reader until maxDuration). No `request.signal` check: Next cancels the readable when the client goes away, and closing
 * on an abort would end a short body cleanly, which must never happen.
 */
export function streamJoined(parts: {
  head: string;
  items: readonly string[];
  separator: string;
  tail: string;
  batch?: number;
}): ReadableStream<Uint8Array> {
  const { head, items, separator, tail } = parts;
  const batch = parts.batch ?? STREAM_BATCH;
  const encoder = new TextEncoder();
  let headSent = false;
  let next = 0; // index of the next item to send
  let done = false;

  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (done) return;
        try {
          if (!headSent) {
            headSent = true;
            if (head !== '') {
              controller.enqueue(encoder.encode(head));
              return;
            }
            // An empty head: carry on in this same call.
          }
          while (next < items.length) {
            const chunk = (next > 0 ? separator : '') + items.slice(next, next + batch).join(separator);
            next += batch;
            if (chunk !== '') {
              controller.enqueue(encoder.encode(chunk));
              return;
            }
            // Only possible for a lone empty-string first batch with no separator: nothing to send, carry on.
          }
          done = true;
          if (tail !== '') controller.enqueue(encoder.encode(tail));
          controller.close();
        } catch (err) {
          done = true;
          Sentry.captureException(err);
          controller.error(err);
        }
      },
      cancel() {
        // The client went away: pull() is never called again.
        done = true;
      },
    },
    { highWaterMark: 0 },
  );
}
