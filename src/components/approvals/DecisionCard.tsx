'use client';

import type { Ref } from 'react';
import { Alert, Checkbox, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import type { useBusy } from '@/components/ui/useBusy';
import { formatCount } from '@/lib/format';

export const DECISION_COMMENT_MAX = 1000;
export const RETURN_NEEDS_COMMENT = 'Add a comment so the employee knows what to fix.';

/**
 * The review's decision card (feature-plan-ux-approvals-payroll.md §3.3.2; replaces ReviewDecisionButtons): one
 * Comment (optional to approve, required to return; ≤ 1,000 with a counter), "Return for corrections" (outlined) and
 * "Approve" (primary) as WriteButtons — read-only aware, never `disabled` / `loading`; a decision blocks both (busy
 * group "decision") — and "Open the next timesheet after I decide". Errors show here, inline (one error location).
 */
export function DecisionCard({
  isOwnPeriod, comment, onCommentChange, commentError, error, busy, onApprove, onReturn, openNext, onOpenNextChange, textareaRef,
}: {
  isOwnPeriod: boolean;
  comment: string;
  onCommentChange: (value: string) => void;
  commentError: string | null;
  error: string | null;
  busy: ReturnType<typeof useBusy>;
  onApprove: () => void;
  onReturn: () => void;
  openNext: boolean;
  onOpenNextChange: (value: boolean) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <Paper withBorder radius="md" p="md" data-testid="decision-card">
      <Stack gap="sm">
        <Textarea
          ref={textareaRef}
          label="Comment"
          description="Optional to approve. Required to return, so the employee knows what to fix."
          value={comment}
          onChange={(e) => onCommentChange(e.currentTarget.value)}
          maxLength={DECISION_COMMENT_MAX}
          rows={3}
          error={commentError ?? undefined}
        />
        <Text size="xs" c="dimmed" ta="right" data-testid="comment-counter">
          {formatCount(comment.length)} / {formatCount(DECISION_COMMENT_MAX)}
        </Text>
        {error && <Alert color="red" role="alert" data-testid="decision-error">{error}</Alert>}
        <Group justify="space-between">
          <WriteButton variant="default" {...busy.props('decision:return', { group: 'decision' })} onClick={onReturn}>
            {isOwnPeriod ? 'Return (self)' : 'Return for corrections'}
          </WriteButton>
          <WriteButton {...busy.props('decision:approve', { group: 'decision' })} onClick={onApprove}>
            {isOwnPeriod ? 'Approve (self)' : 'Approve'}
          </WriteButton>
        </Group>
        <Checkbox
          label="Open the next timesheet after I decide"
          checked={openNext}
          onChange={(e) => onOpenNextChange(e.currentTarget.checked)}
        />
      </Stack>
    </Paper>
  );
}
