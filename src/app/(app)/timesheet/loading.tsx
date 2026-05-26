import { Container, Paper, Skeleton, Stack } from '@mantine/core';

export default function TimesheetLoading() {
  return (
    <Container fluid px="md" py="xl">
      {/* Dashboard skeleton */}
      <Skeleton height={120} radius="md" mb="lg" />
      {/* Period selector skeleton */}
      <Skeleton height={40} radius="sm" mb="sm" />
      {/* Toolbar skeleton */}
      <Skeleton height={36} radius="sm" mb="sm" />
      {/* Table skeleton */}
      <Paper shadow="xs" p="md" radius="md">
        <Stack gap="sm">
          <Skeleton height={40} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={40} radius="sm" />
        </Stack>
      </Paper>
    </Container>
  );
}
