import { Group, Title, Text } from '@mantine/core';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

/** Shared top-of-page header: title + optional description, with actions right-aligned. */
export function PageHeader({ title, description, actions }: Props) {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" wrap="wrap">
      <div>
        <Title order={2}>{title}</Title>
        {description && (
          <Text size="sm" c="dimmed" mt={4}>
            {description}
          </Text>
        )}
      </div>
      {actions}
    </Group>
  );
}
