/**
 * Download a report through fetch, never window.open (feature-plan-ux-page-fixes.md C15, R5): a failed request shows a
 * message in the page instead of opening a tab of JSON. Client-only (uses fetch, Blob URLs and the DOM).
 */

export type DownloadResult = { ok: true } | { ok: false; error: string };

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";
const GENERIC_ERROR = "The report couldn't be generated. Try again in a moment.";

/** The user-facing message for a failed report request (`retryAfter` from a 429 body, else the Retry-After header). */
export function downloadErrorMessage(status: number, retryAfter: number | null): string {
  switch (status) {
    case 400: return 'Check the dates and try again.';
    case 401: return 'Your session has expired. Sign in again.';
    case 403: return "You don't have access to this report.";
    case 404: return "That employee wasn't found.";
    case 429: return `Too many downloads. Try again in ${retryAfter ?? 60} seconds.`;
    default: return GENERIC_ERROR;
  }
}

/**
 * The file name from a Content-Disposition header: the RFC 5987 `filename*=UTF-8''…` form (decoded; a malformed escape
 * falls back), then the plain `filename="…"`, else `fallback`.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch {
      // a malformed %-escape: try the plain form next
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
  const name = plain?.[1]?.trim();
  return name ? name : fallback;
}

/** A 422's `{ error }` from a JSON body (feature-plan-ux-kit-contracts.md R4), else null. Never throws. */
async function jsonErrorOf(res: Response): Promise<string | null> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : null;
  } catch {
    return null;
  }
}

async function retryAfterOf(res: Response): Promise<number | null> {
  // Parse the body only when it says it's JSON — and never throw on it.
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const body = (await res.json()) as { retryAfter?: unknown };
      if (typeof body.retryAfter === 'number' && Number.isFinite(body.retryAfter)) return body.retryAfter;
    } catch {
      // a broken JSON body: fall through to the header
    }
  }
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : null;
}

/** Save a Blob as a file: an anchor appended to the body (Firefox ignores a click on a detached one), then removed. */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export interface DownloadOptions {
  /** Per-status overrides, e.g. the PDF's { 404: "That employee wasn't found." }. */
  messages?: Partial<Record<number, string>>;
}

/**
 * Fetch a report and save it. A failure returns its message instead: a 422 (no hours in range, R4) shows the route's
 * own JSON `error`; other statuses use `opts.messages` first, then the standard copy.
 */
export async function downloadFile(url: string, fallbackName: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!res.ok) {
    if (res.status === 422) return { ok: false, error: (await jsonErrorOf(res)) ?? opts.messages?.[422] ?? GENERIC_ERROR };
    const override = opts.messages?.[res.status];
    if (override) return { ok: false, error: override };
    const retryAfter = res.status === 429 ? await retryAfterOf(res) : null;
    return { ok: false, error: downloadErrorMessage(res.status, retryAfter) };
  }
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  saveBlob(blob, filenameFromDisposition(res.headers.get('content-disposition'), fallbackName));
  return { ok: true };
}
