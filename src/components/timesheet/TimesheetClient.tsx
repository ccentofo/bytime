'use client';

import Link from 'next/link';
import { Alert, Anchor, Badge, Container, Group, Stack, Text } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
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
 * period control below it; status, self-approval badge and Save/Submit on the right), the status line, the returned
 * banner, the weekly notice (exempt only), the grid and the "Past timesheets" link.
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
  const { state } = useTimesheetState();
  const { discardChanges, guardPeriodChange } = useTimesheetActions();
  const { periodStatus } = state;

  const discard = () => {
    discardChanges();
    quietToast({ title: 'Changes discarded', message: 'Your unsaved changes were reverted.', color: 'gray' });
  };

  return (
    <Container fluid px="md" py="lg" className={styles.page}>
      <PageHeader
        title="Timesheet"
        below={<PeriodControl go={guardPeriodChange} />}
        actions={(
          <Group gap="sm" align="flex-start" wrap="wrap">
            <Badge variant="light" size="lg" color={PERIOD_STATUS_COLOR[periodStatus]}>{STATUS_WORD[periodStatus]}</Badge>
            {/* certified-outputs C2 (CO-D6): a self-approval is visibly labelled wherever the timesheet appears. */}
            {state.approvalBadge && <Badge variant="outline" color="gray" size="lg">{state.approvalBadge}</Badge>}
            <SaveSubmitControls onDiscard={discard} />
          </Group>
        )}
      />
      <Stack gap="sm">
        <StatusLine />
        {periodStatus === 'rejected' && (
          <Alert color="warning" variant="light" icon={<Icons.statusWarning size={ICON_SIZE.button} />} title="Returned for corrections" data-testid="returned-banner">
            {state.reviewComment && <Text size="sm">&ldquo;{state.reviewComment}&rdquo;</Text>}
          </Alert>
        )}
        <WeeklyNotice />
        <TimesheetGrid />
        <Anchor component={Link} href="/timesheet/history" size="sm">Past timesheets</Anchor>
      </Stack>
    </Container>
  );
}
