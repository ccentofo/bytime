import * as Sentry from '@sentry/nextjs';
import { UserFacingError } from '@/lib/errors';

/**
 * Provider failures the admin can act on (launch-blockers audit R9). Thrown at the QuickBooks / Gusto API boundary as
 * UserFacingErrors, so the sync log (safeErrorMessage passes them through) and action results show them. The raw
 * status and response body go only to the server log and Sentry — never into the message.
 *
 * - an expired / revoked connection (refresh 400/401, no stored tokens, or a 401 from any API call — a 401 right after
 *   a refresh means authorization was revoked) → reconnect;
 * - any other HTTP failure → the status only, try again / reconnect.
 * Missing client id/secret env stays a plain Error (an operator bug, not the admin's to fix).
 */

export type ProviderName = 'QuickBooks' | 'Gusto';

export function connectionExpiredError(provider: ProviderName): UserFacingError {
  return new UserFacingError(`Your ${provider} connection has expired — reconnect it on the Integrations page.`);
}

export const INTEGRATION_DISCONNECTED_MESSAGE = 'This integration is disconnected — reconnect it on the Integrations page.';

async function logProviderFailure(provider: ProviderName, what: string, response: Response): Promise<void> {
  const body = await response.text().catch(() => '');
  const detail = `${provider} ${what} failed: ${response.status} ${body}`;
  console.error(detail);
  Sentry.captureException(new Error(detail), { tags: { provider, status: String(response.status) } });
}

/** A failed QuickBooks / Gusto API call (query, create, batch, GET, POST). */
export async function providerHttpError(provider: ProviderName, what: string, response: Response): Promise<UserFacingError> {
  await logProviderFailure(provider, what, response);
  if (response.status === 401) return connectionExpiredError(provider);
  return new UserFacingError(`${provider} returned an error (HTTP ${response.status}). Try again; if it keeps happening, reconnect the integration.`);
}

/** A failed token refresh: 400 (invalid_grant — refresh token expired or revoked) or 401 → reconnect. */
export async function providerRefreshError(provider: ProviderName, response: Response): Promise<UserFacingError> {
  if (response.status === 400 || response.status === 401) {
    await logProviderFailure(provider, 'token refresh', response);
    return connectionExpiredError(provider);
  }
  return providerHttpError(provider, 'token refresh', response);
}
