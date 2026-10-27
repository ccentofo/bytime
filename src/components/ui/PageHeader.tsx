import { Group, Title, Text } from '@mantine/core';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** The page's h1 by default; 2 when the page has another h1 above it (e.g. BillingWall). Looks the same either way. */
  order?: 1 | 2;
};

/** Shared top-of-page header: title + optional description, with actions right-aligned. */
export function PageHeader({ title, description, actions, order = 1 }: Props) {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" wrap="wrap">
      <div>
        <Title order={order} size="h2">{title}</Title>
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
