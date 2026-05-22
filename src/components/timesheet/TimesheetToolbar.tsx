'use client';

import { Button, Group, Badge, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconArrowBack, IconSend, IconAlertCircle, IconCheck, IconX } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { useState } from 'react';
import { ReasonModal } from '@/components/timesheet/ReasonModal';
import { SubmitModal } from '@/components/timesheet/SubmitModal';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { getNumDaysInPeriod } from '@/lib/date-utils';

dayjs.extend(isSameOrAfter);

const STATUS_BADGES: Record<string, { color: string; label: string }> = {
  draft: { color: 'yellow', label: 'Draft' },
  submitted: { color: 'blue', label: 'Submitted — Pending Review' },
  approved: { color: 'green', label: 'Approved' },
  rejected: { color: 'red', label: 'Rejected — Corrections Needed' },
};

export function TimesheetToolbar() {
  const { dirtyCells, hasEdits, hasLateEntries, saveAll, discardChanges, submitTimesheet, state } = useTimesheet();
  const [reasonModalOpen, setReasonModalOpen] = useState(false);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);

  const dirtyCount = dirtyCells.length;
  const { periodStatus, periodStart } = state;
  const isEditable = periodStatus === 'draft' || periodStatus === 'rejected';

  // Build period label for the submit modal
  const start = dayjs(periodStart);
  const numDays = getNumDaysInPeriod(periodStart);
  const end = start.add(numDays - 1, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  // Submit only available on or after the last day of the pay period
  const periodEndDate = dayjs(periodStart).add(numDays - 1, 'day');
  const isPeriodComplete = dayjs().isSameOrAfter(periodEndDate, 'day');
  const canSubmit = isEditable && dirtyCount === 0 && isPeriodComplete
    && state.entries.some((e) => e.hours.some((h) => h > 0));

  const statusBadge = STATUS_BADGES[periodStatus] ?? STATUS_BADGES.draft;

  async function handleSave() {
    if (dirtyCount === 0) return;

    if (hasEdits || hasLateEntries) {
      setReasonModalOpen(true);
      return;
    }

    try {
      await saveAll();
      notifications.show({
        title: 'Timesheet Saved',
        message: `${dirtyCount} ${dirtyCount === 1 ? 'entry' : 'entries'} saved successfully.`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Save Failed',
        message: 'Failed to save timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  async function handleReasonConfirm(reasonCode: string, comment: string) {
    try {
      await saveAll(reasonCode, comment);
      setReasonModalOpen(false);
      notifications.show({
        title: 'Timesheet Saved',
        message: `${dirtyCount} ${dirtyCount === 1 ? 'entry' : 'entries'} saved with reason: ${reasonCode}.`,
        color: 'green',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Save Failed',
        message: 'Failed to save timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  function handleDiscard() {
    discardChanges();
    notifications.show({
      title: 'Changes Discarded',
      message: 'All unsaved changes have been reverted.',
      color: 'gray',
    });
  }

  async function handleSubmitConfirm(comment?: string) {
    try {
      await submitTimesheet(comment);
      setSubmitModalOpen(false);
      notifications.show({
        title: 'Timesheet Submitted',
        message: `Your timesheet for ${periodLabel} has been submitted for supervisor review.`,
        color: 'blue',
        icon: <IconCheck size={16} />,
      });
    } catch {
      notifications.show({
        title: 'Submit Failed',
        message: 'Failed to submit timesheet. Please try again.',
        color: 'red',
        icon: <IconX size={16} />,
      });
    }
  }

  return (
    <>
      {/* Rejection notice */}
      {periodStatus === 'rejected' && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" mb="sm">
          <Text size="sm" fw={600}>
            This timesheet was returned for corrections. Please review the supervisor&apos;s comments, make necessary changes, and re-submit.
          </Text>
        </Alert>
      )}

      <Group justify="space-between" mb="sm" gap="sm">
        {/* Left: Status badge */}
        <Badge variant="light" color={statusBadge.color} size="lg">
          {statusBadge.label}
        </Badge>

        {/* Right: Action buttons */}
        <Group gap="sm">
          {dirtyCount > 0 && (
            <Badge variant="light" color="yellow" size="lg">
              {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
            </Badge>
          )}

          {isEditable && (
            <>
              <Button
                variant="default"
                leftSection={<IconArrowBack size={16} />}
                onClick={handleDiscard}
                disabled={dirtyCount === 0}
              >
                Discard Changes
              </Button>
              <Button
                leftSection={<IconDeviceFloppy size={16} />}
                onClick={handleSave}
                disabled={dirtyCount === 0}
                loading={state.isSaving}
              >
                Save
              </Button>
              <div>
                <Button
                  color="green"
                  leftSection={<IconSend size={16} />}
                  onClick={() => setSubmitModalOpen(true)}
                  disabled={!canSubmit}
                  title={!isPeriodComplete ? `Submit available on ${periodEndDate.format('MMM D, YYYY')}` : undefined}
                >
                  Submit
                </Button>
                {!isPeriodComplete && isEditable && dirtyCount === 0 && (
                  <Text size="xs" c="dimmed" ta="center" mt={4}>
                    Available {periodEndDate.format('MMM D')}
                  </Text>
                )}
              </div>
            </>
          )}
        </Group>
      </Group>

      <ReasonModal
        opened={reasonModalOpen}
        onClose={() => setReasonModalOpen(false)}
        onConfirm={handleReasonConfirm}
        editedCells={dirtyCells.filter((c) => c.isEdit)}
        lateEntryCells={dirtyCells.filter((c) => c.isLateEntry)}
        chargeCodes={state.chargeCodes}
        periodStart={state.periodStart}
        isSaving={state.isSaving}
      />

      <SubmitModal
        opened={submitModalOpen}
        onClose={() => setSubmitModalOpen(false)}
        onConfirm={handleSubmitConfirm}
        isSaving={state.isSaving}
        periodLabel={periodLabel}
      />
    </>
  );
}
