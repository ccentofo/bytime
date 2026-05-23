'use client';

import { Badge, Stack, Text } from '@mantine/core';
import type { ChargeCode } from '@/types/timesheet';

interface ChargeCodeCellProps {
  chargeCode: ChargeCode;
}

export function ChargeCodeCell({ chargeCode }: ChargeCodeCellProps) {
  return (
    <Stack gap={4}>
      <Text fw={700} size="sm">
        {chargeCode.projectName}
      </Text>
      <Badge variant="light" size="sm">
        {chargeCode.clin}{chargeCode.slinNumber ? ` / ${chargeCode.slinNumber}` : ''}
      </Badge>
      {chargeCode.slinNumber && (
        <Text size="xs" c="dimmed">SLIN: {chargeCode.slinNumber}</Text>
      )}
      <Text c="dimmed" size="xs">
        {chargeCode.description}
      </Text>
    </Stack>
  );
}
