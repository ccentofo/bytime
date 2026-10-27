'use client';

import { useState, useSyncExternalStore } from 'react';
import { Alert, Anchor, CloseButton, Group, Stack, Text } from '@mantine/core';
import { IconInfoCircle, IconAlertTriangle } from '@tabler/icons-react';

/**
 * feature-plan-certified-outputs.md C2 (CO-D19) admin notices. Dismissals live in localStorage:
 * - "Self-approval is back on" — keyed by the admin_change_log row id, so a later switch-on shows it again;
 * - the designee recommendation — keyed per admin, cleared at sign-out (clearDesigneeNoticeDismissals), so it returns
 *   after the next sign-in.
 */

// Exported for Home's "Needs your attention" item, which honours the same dismissals (UX-2 fix round 1, L10).
export const BACK_ON_KEY = (logId: string) => `cadenzpoint:self-approval-back-on-dismissed:${logId}`;
const RECOMMEND_PREFIX = 'cadenzpoint:designee-notice-dismissed:';
export const RECOMMEND_KEY = (adminId: string) => `${RECOMMEND_PREFIX}${adminId}`;

/** Called on sign-out: the designee recommendation returns after the next sign-in. */
export function clearDesigneeNoticeDismissals(): void {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(RECOMMEND_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable — nothing to clear
  }
}

function readFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key: string): void {
  try { window.localStorage.setItem(key, '1'); } catch { /* storage unavailable — dismiss for this view only */ }
}

export interface ApprovalNoticesProps {
  adminId: string;
  notices: { selfApprovalBackOn: { logId: string } | null; recommendDesignee: boolean };
  show: Array<'backOn' | 'recommend'>;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/** A localStorage flag; on the server (and the first client render) it reads as set, so nothing flashes or mismatches. */
export function useStoredFlag(key: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (key ? readFlag(key) : true), () => true);
}

export function ApprovalNotices({ adminId, notices, show }: ApprovalNoticesProps) {
  const backOnKey = notices.selfApprovalBackOn ? BACK_ON_KEY(notices.selfApprovalBackOn.logId) : null;
  const storedBackOn = useStoredFlag(backOnKey);
  const storedRecommend = useStoredFlag(RECOMMEND_KEY(adminId));
  // Dismissals made in this view (localStorage's 'storage' event doesn't fire in the same tab).
  const [dismissedHere, setDismissedHere] = useState({ backOn: false, recommend: false });
  const dismissed = { backOn: storedBackOn || dismissedHere.backOn, recommend: storedRecommend || dismissedHere.recommend };
  const setDismissed = (d: typeof dismissed) => setDismissedHere(d);

  const backOn = show.includes('backOn') && notices.selfApprovalBackOn && !dismissed.backOn;
  const recommend = show.includes('recommend') && notices.recommendDesignee && !dismissed.recommend;
  if (!backOn && !recommend) return null;

  return (
    <Stack gap="sm" mb="md">
      {backOn && (
        <Alert color="warning" variant="light" icon={<IconAlertTriangle size={16} />}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Text size="sm">
              Self-approval is back on: you&apos;re now the only active admin and have no designated approver. Consider{' '}
              <Anchor href="/admin/users" size="sm">designating one</Anchor>.
            </Text>
            <CloseButton
              aria-label="Dismiss"
              onClick={() => { writeFlag(BACK_ON_KEY(notices.selfApprovalBackOn!.logId)); setDismissed({ ...dismissed, backOn: true }); }}
            />
          </Group>
        </Alert>
      )}
      {recommend && (
        <Alert color="signal" variant="light" icon={<IconInfoCircle size={16} />}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Text size="sm">
              Auditors prefer an independent reviewer. Designate another officer or your bookkeeper (supervisor role) to
              approve your timesheets.
            </Text>
            <CloseButton
              aria-label="Dismiss"
              onClick={() => { writeFlag(RECOMMEND_KEY(adminId)); setDismissed({ ...dismissed, recommend: true }); }}
            />
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
