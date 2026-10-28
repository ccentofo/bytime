import { Container, Group, Paper, Skeleton, Stack } from '@mantine/core';

/** The timesheet's loading skeleton (feature-plan-ux-timesheet-ui.md §4.1): the header band, then the grid. */
export default function TimesheetLoading() {
  return (
    <Container fluid px="md" py="lg">
      {/* Header band: the title and actions, then the period control */}
      <Group justify="space-between" mb="xs">
        <Skeleton height={32} width={180} radius="sm" />
        <Skeleton height={36} width={320} radius="sm" />
      </Group>
      <Skeleton height={36} width={420} radius="sm" mb="md" />
      {/* Status line */}
      <Skeleton height={18} width={360} radius="sm" mb="sm" />
      {/* Grid */}
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Skeleton height={44} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={40} radius="sm" />
        </Stack>
      </Paper>
    </Container>
  );
}
