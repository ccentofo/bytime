'use client';

import { useId } from 'react';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useTimesheetActions, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { formatCalendarDate, isBefore } from '@/lib/calendar-date';
import styles from './Timesheet.module.css';

/**
 * Discard changes, Save and Submit (feature-plan-ux-timesheet-ui.md §4.1). aria-disabled plus a click guard, never
 * `disabled`, so focus stays put when a control becomes unavailable. Submit's reason, when one applies, is VISIBLE text
 * linked by aria-describedby; when Submit is available there is no reason element and no aria-describedby.
 */
export function SaveSubmitControls({ onDiscard }: { onDiscard: () => void }) {
  const { state, hasUnsaved, unsavedCount, checks } = useTimesheetState();
  const { requestSave, openSubmit } = useTimesheetActions();
  const id = useId();
  const { periodStatus, readOnly, isLoadingPeriod, today, submitOpensOn } = state;
  const locked = periodStatus === 'submitted' || periodStatus === 'approved';
  const editable = !locked && !readOnly;

  // Submit reason precedence (§4.1), first match wins.
  const submitWhy = readOnly ? 'This workspace is read-only'
    : locked ? `This timesheet is ${periodStatus}`
      : isLoadingPeriod ? 'Loading…'
        : hasUnsaved ? 'Save your changes first'
          : isBefore(today, submitOpensOn) ? `Opens ${formatCalendarDate(submitOpensOn, 'dddd, MMM D')}`
            : checks.totalPeriodHours <= 0 ? 'Add hours before submitting'
              : null;
  const canSave = editable && hasUnsaved && !isLoadingPeriod;
  const canDiscard = hasUnsaved && !isLoadingPeriod;

  return (
    <Stack gap={4} align="flex-end">
      <Group gap="sm" wrap="wrap" justify="flex-end">
        {unsavedCount > 0 && (
          <Badge variant="light" color="warning" size="lg">{unsavedCount} unsaved {unsavedCount === 1 ? 'change' : 'changes'}</Badge>
        )}
        <Button variant="subtle" leftSection={<Icons.discard size={ICON_SIZE.button} />}
          aria-disabled={canDiscard ? undefined : 'true'} data-disabled={!canDiscard || undefined}
          onClick={() => { if (canDiscard) onDiscard(); }}>
          Discard changes
        </Button>
        <Button variant="default" leftSection={<Icons.save size={ICON_SIZE.button} />} loading={state.isSaving}
          aria-disabled={canSave ? undefined : 'true'} data-disabled={!canSave || undefined}
          onClick={() => { if (canSave) void requestSave(); }}>
          Save
        </Button>
        <Button color="success" leftSection={<Icons.submit size={ICON_SIZE.button} />}
          aria-disabled={submitWhy ? 'true' : undefined} aria-describedby={submitWhy ? `${id}-submit-why` : undefined}
          data-disabled={submitWhy !== null || undefined}
          onClick={() => { if (!submitWhy) openSubmit(); }}>
          Submit
        </Button>
      </Group>
      {submitWhy && <Text id={`${id}-submit-why`} className={styles.reason}>{submitWhy}</Text>}
    </Stack>
  );
}
