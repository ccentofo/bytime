'use client';

import { Avatar, Container, Group, Paper, Title } from '@mantine/core';
import { TimesheetProvider } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import logo from '../../assets/logo.png';

function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <Group>
        <Avatar
        size="xl"
        src="/logo.png"/>
        <Title>ByTime</Title>
      </Group>
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
