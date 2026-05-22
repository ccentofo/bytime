'use client';

import { Container, Paper, Text, Title } from '@mantine/core';
import dayjs from 'dayjs';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';

function TimesheetContent() {
  const { state } = useTimesheet();
  const { periodStart } = state;

  const start = dayjs(periodStart);
  const end = start.add(13, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  return (
    <Container fluid px="md" py="xl">
      <Title order={2} mb={4}>
        Bi-Weekly Timesheet
      </Title>
      <Text c="dimmed" size="sm" mb="md">
        Pay Period: {periodLabel}
      </Text>
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
