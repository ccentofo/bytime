'use client';

import { Button, Group, Badge, Text, Alert, Paper } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconArrowBack, IconSend, IconAlertCircle, IconCheck, IconX } from '@tabler/icons-react';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { useState, useMemo } from 'react';
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

  // Overtime calculations for FLSA exempt employees
  const overtimeInfo = useMemo(() => {
    if (!state.flsaExempt) return null;

    const totalPeriodHours = state.entries.reduce(
      (sum, entry) => sum + entry.hours.reduce((a, b) => a + b, 0),
      0
    );

    // Calculate weekly totals within the period
    const dailyTotals: number[] = [];
    const numDaysInPeriod = state.entries[0]?.hours.length ?? 0;
    for (let i = 0; i < numDaysInPeriod; i++) {
      let dayTotal = 0;
      for (const entry of state.entries) {
        dayTotal += entry.hours[i] ?? 0;
      }
      dailyTotals.push(dayTotal);
    }

    // Group by week (Sun-Sat) and calculate compensated vs uncompensated
    const weeklyTotals: { weekLabel: string; total: number; compensated: number; uncompensated: number }[] = [];
    let currentWeekStart: dayjs.Dayjs | null = null;
    let currentWeekHours = 0;
    let currentWeekLabel = '';

    for (let i = 0; i < numDaysInPeriod; i++) {
      const date = dayjs(state.periodStart).add(i, 'day');
      const weekStart = date.startOf('week');

      if (!currentWeekStart || !weekStart.isSame(currentWeekStart, 'day')) {
        if (currentWeekStart !== null) {
          weeklyTotals.push({
            weekLabel: currentWeekLabel,
            total: Math.round(currentWeekHours * 100) / 100,
            compensated: Math.min(currentWeekHours, 40),
            uncompensated: Math.max(0, Math.round((currentWeekHours - 40) * 100) / 100),
          });
        }
        currentWeekStart = weekStart;
        currentWeekHours = 0;
        currentWeekLabel = `Week of ${date.format('MMM D')}`;
      }
      currentWeekHours += dailyTotals[i];
    }
    if (currentWeekStart !== null) {
      weeklyTotals.push({
        weekLabel: currentWeekLabel,
        total: Math.round(currentWeekHours * 100) / 100,
        compensated: Math.min(currentWeekHours, 40),
        uncompensated: Math.max(0, Math.round((currentWeekHours - 40) * 100) / 100),
      });
    }

    const totalUncompensated = weeklyTotals.reduce((sum, w) => sum + w.uncompensated, 0);
    const hasLowHoursWarning = weeklyTotals.some((w) => w.total > 0 && w.total < 40);

    return {
      totalPeriodHours: Math.round(totalPeriodHours * 100) / 100,
      totalUncompensated: Math.round(totalUncompensated * 100) / 100,
      weeklyTotals,
      hasLowHoursWarning,
    };
  }, [state.entries, state.periodStart, state.flsaExempt]);

  // Period completeness validation warnings
  const completenessWarnings = useMemo(() => {
    const warnings: string[] = [];
    const numDaysInPeriod = state.entries[0]?.hours.length ?? 0;
    if (numDaysInPeriod === 0) return warnings;

    // Calculate daily totals across all charge codes
    const dailyTotals: number[] = [];
    for (let i = 0; i < numDaysInPeriod; i++) {
      let dayTotal = 0;
      for (const entry of state.entries) {
        dayTotal += entry.hours[i] ?? 0;
      }
      dailyTotals.push(Math.round(dayTotal * 100) / 100);
    }

    // Check for missing workdays (weekdays with 0 hours)
    const missingDays: string[] = [];
    for (let i = 0; i < numDaysInPeriod; i++) {
      const date = dayjs(state.periodStart).add(i, 'day');
      const dow = date.day(); // 0=Sun, 6=Sat
      const isWeekday = dow >= 1 && dow <= 5;
      const isPastOrToday = date.isBefore(dayjs(), 'day') || date.isSame(dayjs(), 'day');

      if (isWeekday && isPastOrToday && dailyTotals[i] === 0) {
        missingDays.push(date.format('ddd MMM D'));
      }
    }

    if (missingDays.length > 0) {
      warnings.push(
        `${missingDays.length} workday${missingDays.length !== 1 ? 's' : ''} with no hours recorded: ${missingDays.join(', ')}`
      );
    }

    // Check for excessive hours on any single day (> 16 hours)
    for (let i = 0; i < numDaysInPeriod; i++) {
      if (dailyTotals[i] > 16) {
        const date = dayjs(state.periodStart).add(i, 'day');
        warnings.push(
          `${dailyTotals[i].toFixed(2)} hours recorded on ${date.format('ddd MMM D')} — please verify this is correct`
        );
      }
    }

    // Total period hours
    const totalHours = dailyTotals.reduce((sum, h) => sum + h, 0);

    // Check for very low total hours (less than 50% of expected workdays × 8)
    const workdayCount = Array.from({ length: numDaysInPeriod }, (_, i) => {
      const dow = dayjs(state.periodStart).add(i, 'day').day();
      return dow >= 1 && dow <= 5 ? 1 : 0;
    }).reduce((a: number, b: number) => a + b, 0);

    const expectedMinHours = workdayCount * 4; // 50% of expected (4 hrs/day minimum threshold)
    if (totalHours > 0 && totalHours < expectedMinHours) {
      warnings.push(
        `Total period hours (${totalHours.toFixed(2)}) seem low for ${workdayCount} workdays. Ensure all time is accounted for.`
      );
    }

    return warnings;
  }, [state.entries, state.periodStart]);

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

      {/* Overtime summary for FLSA exempt employees */}
      {state.flsaExempt && overtimeInfo && overtimeInfo.totalPeriodHours > 0 && (
        <Paper withBorder p="xs" mb="sm" radius="sm">
          <Group justify="space-between" wrap="wrap">
            <Group gap="md">
              <Text size="sm" fw={600}>
                Total Period Hours: {overtimeInfo.totalPeriodHours.toFixed(2)}
              </Text>
              {overtimeInfo.totalUncompensated > 0 && (
                <Badge color="orange" variant="light" size="lg">
                  {overtimeInfo.totalUncompensated.toFixed(2)} hrs uncompensated OT
                </Badge>
              )}
            </Group>
            {overtimeInfo.hasLowHoursWarning && (
              <Text size="xs" c="orange" fw={500}>
                ⚠ Some weeks have fewer than 40 hours — ensure all time is recorded
              </Text>
            )}
          </Group>
        </Paper>
      )}

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
        flsaExempt={state.flsaExempt}
        totalPeriodHours={overtimeInfo?.totalPeriodHours}
        uncompensatedHours={overtimeInfo?.totalUncompensated}
        completenessWarnings={completenessWarnings}
      />
    </>
  );
}
