'use client';

import Link from 'next/link';
import { Alert, Anchor, Badge, Container, Group, Stack, Text } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { useState } from 'react';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { TimesheetProvider, useTimesheetActions, useTimesheetState } from '@/components/timesheet/TimesheetContext';
import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { PeriodControl } from '@/components/timesheet/PeriodControl';
import { SaveSubmitControls } from '@/components/timesheet/SaveSubmitControls';
import { StatusLine } from '@/components/timesheet/StatusLine';
import { WeeklyNotice } from '@/components/timesheet/WeeklyNotice';
import { STATUS_WORD } from '@/lib/timesheet/labels';
import { PERIOD_STATUS_COLOR } from '@/lib/ui/status-colors';
import { quietToast } from '@/lib/timesheet/toast';
import type { TimesheetPageData } from '@/types/timesheet';
import styles from './Timesheet.module.css';

/**
 * The timesheet page (feature-plan-ux-timesheet-ui.md §4.1, mockup "Employee timesheet"): the header band (title, the
 * period control below it; status, self-approval badge and Save/Submit on the right), the status line with the "Past
 * timesheets" link, the returned banner, the weekly notice (exempt only), then the grid's slot, which fills the rest of
 * the viewport (§15.2: one scroll container).
 */
export function TimesheetClient({ initialData }: { initialData: TimesheetPageData }) {
  return (
    <TimesheetProvider initialData={initialData}>
      <TimesheetPage />
    </TimesheetProvider>
  );
}

/** The page body, inside a TimesheetProvider (exported for tests). */
export function TimesheetPage() {
  const { state, unsavedCount, sessionAlert } = useTimesheetState();
  const { discardChanges, guardPeriodChange } = useTimesheetActions();
  const { periodStatus } = state;

  // §4.9.5: Discard changes asks first; confirming discards (DISCARD_CHANGES in flushSync).
  const [discardOpen, setDiscardOpen] = useState(false);
  const discard = () => {
    setDiscardOpen(false);
    discardChanges();
    quietToast({ title: 'Changes discarded', message: 'Your unsaved changes were reverted.', color: 'gray' });
  };

  return (
    <>
      <Container fluid px="md" py="lg" className={styles.page}>
        <PageHeader
          title="Timesheet"
          below={<PeriodControl go={guardPeriodChange} />}
          actions={(
            <Group gap="sm" align="flex-start" wrap="wrap">
              <Badge variant="light" size="lg" color={PERIOD_STATUS_COLOR[periodStatus]}>{STATUS_WORD[periodStatus]}</Badge>
              {/* certified-outputs C2 (CO-D6): a self-approval is visibly labelled wherever the timesheet appears. */}
              {state.approvalBadge && <Badge variant="outline" color="gray" size="lg">{state.approvalBadge}</Badge>}
              <SaveSubmitControls onDiscard={() => setDiscardOpen(true)} />
            </Group>
          )}
        />
        {/* The header area (§15.2): everything above the grid keeps its natural height. */}
        <Stack gap="sm" mb="sm">
          {sessionAlert && (
            // Visual only (role="note"): the announcer already spoke the message assertively (§4.5).
            <Alert role="note" color="red" variant="light" icon={<Icons.statusError size={ICON_SIZE.button} />} data-testid="session-expired">
              <Text size="sm">{sessionAlert.message}</Text>
              {sessionAlert.signInHref && <Anchor href={sessionAlert.signInHref} target="_blank" rel="noopener" size="sm" fw={600}>Sign in (new tab)</Anchor>}
            </Alert>
          )}
          <Group justify="space-between" align="baseline" gap="sm" wrap="wrap">
            <StatusLine />
            <Anchor component={Link} href="/timesheet/history" size="sm">Past timesheets</Anchor>
          </Group>
          {periodStatus === 'rejected' && (
            <Alert role="note" color="warning" variant="light" icon={<Icons.statusWarning size={ICON_SIZE.button} />} title="Returned for corrections" data-testid="returned-banner">
              {state.reviewComment && <Text size="sm">&ldquo;{state.reviewComment}&rdquo;</Text>}
            </Alert>
          )}
          <WeeklyNotice />
        </Stack>
        {/* The page's last child and the only part that flexes: the grid fills the remaining height (one scroll container). */}
        <div className={styles.gridSlot}>
          <TimesheetGrid />
        </div>
      </Container>
      <ConfirmModal
        opened={discardOpen}
        title={`Discard ${unsavedCount} unsaved ${unsavedCount === 1 ? 'change' : 'changes'}?`}
        message="Your unsaved hours and notes on this timesheet will be reverted to what was last saved."
        confirmLabel="Discard changes"
        onConfirm={discard}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
}
