'use client';

import { Group } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { WriteButton } from '@/components/shell/WorkspaceMode';

/**
 * Approve / Reject for a submitted period. Disabled with the read-only tooltip when the workspace can't write
 * (feature-plan-launch-blockers.md P4 §5) — the server refuses anyway; this only keeps the UI honest.
 */
export function ReviewDecisionButtons({
  isOwnPeriod,
  canReject,
  pending,
  onApprove,
  onReject,
}: {
  isOwnPeriod: boolean;
  canReject: boolean;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <Group justify="flex-end" mt="md">
      <WriteButton
        color="red"
        variant="light"
        leftSection={<IconX size={16} />}
        onClick={onReject}
        disabled={!canReject}
        loading={pending}
      >
        {isOwnPeriod ? 'Reject (Self)' : 'Reject'}
      </WriteButton>
      <WriteButton
        color="success"
        leftSection={<IconCheck size={16} />}
        onClick={onApprove}
        loading={pending}
      >
        {isOwnPeriod ? 'Approve (Self)' : 'Approve'}
      </WriteButton>
    </Group>
  );
}
