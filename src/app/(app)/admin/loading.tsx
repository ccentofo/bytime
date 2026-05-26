import { Container, Skeleton, Stack } from '@mantine/core';

export default function AdminLoading() {
  return (
    <Container py="xl">
      <Skeleton height={32} width={200} radius="sm" mb="md" />
      <Skeleton height={300} radius="md" />
    </Container>
  );
}
