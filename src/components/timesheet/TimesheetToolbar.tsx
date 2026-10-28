'use client';

import { Button, Group, Badge, Text, Alert, Paper } from '@mantine/core';
import { IconDeviceFloppy, IconArrowBack, IconSend, IconAlertCircle } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { formatCalendarDate } from '@/lib/calendar-date';
import { isBefore } from '@/lib/calendar-date';
import { PERIOD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { quietToast } from '@/lib/timesheet/toast';

const STATUS_BADGES: Record<string, { color: string; label: string }> = {
  draft: { color: PERIOD_STATUS_COLOR.draft, label: 'Draft' },
  submitted: { color: PERIOD_STATUS_COLOR.submitted, label: 'Submitted — Pending Review' },
  approved: { color: PERIOD_STATUS_COLOR.approved, label: 'Approved' },
  rejected: { color: PERIOD_STATUS_COLOR.rejected, label: 'Rejected — Corrections Needed' },
};

/**
 * The old toolbar, kept until the page layout step (feature-plan-ux-timesheet-ui.md §12 step 5). Saving goes through
 * the provider's save flow (requestSave: ReasonModal when hours need a reason) and Submit through its SubmitModal.
 */
export function TimesheetToolbar() {
  const { unsavedCount: dirtyCount, requestSave, discardChanges, openSubmit, state, checks } = useTimesheet();
  const { periodStatus } = state;
  const isEditable = (periodStatus === 'draft' || periodStatus === 'rejected') && !state.readOnly;
  const isPeriodComplete = !isBefore(state.today, state.submitOpensOn);
  const canSubmit = isEditable && dirtyCount === 0 && isPeriodComplete && checks.totalPeriodHours > 0;
  const statusBadge = STATUS_BADGES[periodStatus] ?? STATUS_BADGES.draft;

  async function handleSave() {
    if (dirtyCount === 0) return;
    await requestSave();
  }

  function handleDiscard() {
    discardChanges();
    quietToast({ title: 'Changes discarded', message: 'All unsaved changes have been reverted.', color: 'gray' });
  }

  return (
    <>
      {periodStatus === 'rejected' && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="sm">
          <Text size="sm" fw={600}>
            This timesheet was returned for corrections. Please review the supervisor&apos;s comments, make necessary changes, and re-submit.
          </Text>
        </Alert>
      )}

      <Group justify="space-between" mb="sm" gap="sm">
        <Group gap="xs">
          <Badge variant="light" color={statusBadge.color} size="lg">{statusBadge.label}</Badge>
          {/* certified-outputs C2 (CO-D6): a self-approval is visibly labelled wherever the timesheet appears. */}
          {state.approvalBadge && <Badge variant="outline" color="gray" size="lg">{state.approvalBadge}</Badge>}
        </Group>

        <Group gap="sm">
          {dirtyCount > 0 && (
            <Badge variant="light" color="warning" size="lg">
              {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
            </Badge>
          )}

          {isEditable && (
            <>
              <Button variant="default" leftSection={<IconArrowBack size={16} />} onClick={handleDiscard} disabled={dirtyCount === 0 || state.isLoadingPeriod}>
                Discard Changes
              </Button>
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={handleSave} disabled={dirtyCount === 0 || state.isLoadingPeriod} loading={state.isSaving}>
                Save
              </Button>
              <Button color="success" leftSection={<IconSend size={16} />} onClick={openSubmit} disabled={!canSubmit || state.isLoadingPeriod}
                title={!isPeriodComplete ? `Submit available on ${formatCalendarDate(state.submitOpensOn, 'MMM D, YYYY')}` : undefined}>
                Submit
              </Button>
            </>
          )}
        </Group>
      </Group>

      {state.flsaExempt && checks.totalPeriodHours > 0 && (
        <Paper withBorder p="xs" mb="sm" radius="sm">
          <Group gap="md">
            <Text size="sm" fw={600}>Total Period Hours: {checks.totalPeriodHours.toFixed(2)}</Text>
            {checks.uncompensatedHours > 0 && (
              <Badge color="warning" variant="light" size="lg">{checks.uncompensatedHours.toFixed(2)} hrs uncompensated OT</Badge>
            )}
          </Group>
        </Paper>
      )}
    </>
  );
}
