'use client';

import { Container, Paper, Skeleton, Stack } from '@mantine/core';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';
import type { EmployeeDashboardData } from '@/server/actions/employee-dashboard';
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
          <TimesheetGrid />
        )}
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

type Props = {
  initialData: TimesheetPageData;
  /** The old dashboard, until the page layout step removes it (§12 step 5). */
  dashboardData?: EmployeeDashboardData;
};

export function BiWeeklyTimesheetClient({ initialData, dashboardData }: Props) {
  return (
    <>
      {dashboardData && (
        <Container fluid px="md" pt="xl">
          <TimesheetDashboard data={dashboardData} />
        </Container>
      )}
      <TimesheetProvider initialData={initialData}>
        <TimesheetContent />
      </TimesheetProvider>
    </>
  );
}
