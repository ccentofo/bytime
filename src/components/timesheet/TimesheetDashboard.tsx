'use client';

import {
  SimpleGrid,
  Paper,
  Group,
  Text,
  Badge,
  Progress,
  ThemeIcon,
  Stack,
  Table,
  Alert,
} from '@mantine/core';
import {
  IconClock,
  IconCalendar,
  IconCheck,
  IconSend,
  IconAlertCircle,
  IconHistory,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { EmployeeDashboardData } from '@/server/actions/employee-dashboard';

type Props = {
  data: EmployeeDashboardData;
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'yellow',
  submitted: 'blue',
  approved: 'green',
  rejected: 'red',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function TimesheetDashboard({ data }: Props) {
  const { currentPeriod, recentPeriods } = data;

  // Calculate completion percentage
  const completionPct = currentPeriod.expectedWorkdays > 0
    ? Math.min(100, Math.round((currentPeriod.daysWithEntries / currentPeriod.expectedWorkdays) * 100))
    : 0;

  const completionColor = completionPct >= 80 ? 'green' : completionPct >= 50 ? 'yellow' : 'red';

  return (
    <Stack gap="md" mb="lg">
      {/* Rejection notice */}
      {currentPeriod.status === 'rejected' && currentPeriod.reviewComment && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          <Text size="sm" fw={600}>Timesheet returned for corrections:</Text>
          <Text size="sm" mt={4}>"{currentPeriod.reviewComment}"</Text>
        </Alert>
      )}

      {/* Current Period Status Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
        {/* Period Status */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Period Status</Text>
              <Badge color={STATUS_COLORS[currentPeriod.status] ?? 'gray'} size="lg" mt={4}>
                {STATUS_LABELS[currentPeriod.status] ?? currentPeriod.status}
              </Badge>
            </div>
            <ThemeIcon color={STATUS_COLORS[currentPeriod.status] ?? 'gray'} variant="light" size="lg" radius="md">
              {currentPeriod.status === 'approved' ? <IconCheck size={20} /> :
               currentPeriod.status === 'submitted' ? <IconSend size={20} /> :
               <IconClock size={20} />}
            </ThemeIcon>
          </Group>
        </Paper>

        {/* Hours This Period */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Hours This Period</Text>
              <Text size="xl" fw={700} mt={4}>{currentPeriod.totalHoursEntered.toFixed(1)}</Text>
            </div>
            <ThemeIcon color="blue" variant="light" size="lg" radius="md">
              <IconClock size={20} />
            </ThemeIcon>
          </Group>
        </Paper>

        {/* Days Completed */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" mb="xs">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Days Completed</Text>
              <Text size="xl" fw={700} mt={4}>
                {currentPeriod.daysWithEntries} / {currentPeriod.expectedWorkdays}
              </Text>
            </div>
            <ThemeIcon color={completionColor} variant="light" size="lg" radius="md">
              <IconCalendar size={20} />
            </ThemeIcon>
          </Group>
          <Progress value={completionPct} color={completionColor} size="sm" mt="xs" />
        </Paper>

        {/* Submission Deadline */}
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Submit By</Text>
              <Text size="lg" fw={700} mt={4}>{currentPeriod.submissionDeadline}</Text>
              {currentPeriod.canSubmitToday && currentPeriod.status === 'draft' && (
                <Text size="xs" c="green" fw={500}>Ready to submit</Text>
              )}
              {!currentPeriod.canSubmitToday && currentPeriod.daysRemaining > 0 && (
                <Text size="xs" c="dimmed">{currentPeriod.daysRemaining} workdays remaining</Text>
              )}
            </div>
            <ThemeIcon
              color={currentPeriod.canSubmitToday ? 'green' : 'gray'}
              variant="light"
              size="lg"
              radius="md"
            >
              <IconSend size={20} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Recent Periods History */}
      {recentPeriods.length > 0 && (
        <Paper withBorder p="md" radius="md">
          <Group mb="sm">
            <IconHistory size={18} />
            <Text fw={600} size="sm">Recent Periods</Text>
          </Group>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Period</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Hours</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th>Reviewed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {recentPeriods.map((rp) => (
                <Table.Tr key={rp.periodStart.toString()}>
                  <Table.Td>{rp.periodLabel}</Table.Td>
                  <Table.Td>
                    <Badge
                      color={STATUS_COLORS[rp.status] ?? 'gray'}
                      variant="light"
                      size="sm"
                    >
                      {STATUS_LABELS[rp.status] ?? rp.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{rp.totalHours.toFixed(1)}</Table.Td>
                  <Table.Td>
                    {rp.submittedAt ? dayjs(rp.submittedAt).format('MMM D') : '—'}
                  </Table.Td>
                  <Table.Td>
                    {rp.reviewedAt ? dayjs(rp.reviewedAt).format('MMM D') : '—'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}
