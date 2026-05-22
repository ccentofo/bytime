'use client';

import { Container, Paper } from '@mantine/core';
import { TimesheetProvider } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';

function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        <BiWeeklyTable />
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

export function BiWeeklyTimesheetClient() {
  return (
    <TimesheetProvider>
      <TimesheetContent />
    </TimesheetProvider>
  );
}
