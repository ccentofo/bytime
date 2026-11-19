'use server';

import { headers } from 'next/headers';
import { getClientIpFromHeaders } from '@/lib/rate-limit';
import { prepareDownload, type PrepareResult } from '@/lib/export/delivery-access';

/**
 * feature-plan-cloud-export.md §6.6: the "Prepare download" POST. Everything is re-checked from the token (never from
 * the page's earlier render): the IP limit first, the token's state, the per-delivery limit, then a 5-minute URL. The URL
 * is returned to the page (serialised to the client), never logged.
 */
export type PrepareState = { status: 'idle' } | PrepareResult;

export async function prepareExportDownload(_prev: PrepareState, formData: FormData): Promise<PrepareState> {
  const token = String(formData.get('token') ?? '');
  const ip = getClientIpFromHeaders(await headers());
  return prepareDownload(token, ip);
}
