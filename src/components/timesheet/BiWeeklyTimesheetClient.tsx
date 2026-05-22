'use client';

import { Container, Paper, Skeleton, Stack } from '@mantine/core';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';

function TimesheetContent() {
  const { state } = useTimesheet();

  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <TimesheetToolbar />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        {state.isLoadingPeriod ? (
          <Stack gap="sm">
            <Skeleton height={40} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={40} radius="sm" />
          </Stack>
        ) : (
          <BiWeeklyTable />
        )}
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

type Props = {
  initialData: TimesheetPageData;
};

export function BiWeeklyTimesheetClient({ initialData }: Props) {
  return (
    <TimesheetProvider initialData={initialData}>
      <TimesheetContent />
    </TimesheetProvider>
  );
}
