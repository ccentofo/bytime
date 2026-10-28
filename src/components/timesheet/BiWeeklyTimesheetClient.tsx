'use client';

import { Container, Paper, Skeleton, Stack } from '@mantine/core';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';
import { TimesheetDashboard } from '@/components/timesheet/TimesheetDashboard';

function TimesheetContent() {
  const { state } = useTimesheet();

  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <TimesheetToolbar />
      {/* The grid fits 100% width — no scroll at ≥1024px. Mobile scroll guard is in Timesheet.module.css. */}
      <Paper shadow="xs" p="md" radius="md">
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
    <>
      {initialData.dashboardData && (
        <Container fluid px="md" pt="xl">
          <TimesheetDashboard data={initialData.dashboardData} />
        </Container>
      )}
      <TimesheetProvider initialData={initialData}>
        <TimesheetContent />
      </TimesheetProvider>
    </>
  );
}
