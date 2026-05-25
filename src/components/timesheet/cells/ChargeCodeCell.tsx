'use client';

import { Badge, Stack, Text } from '@mantine/core';
import type { ChargeCode } from '@/types/timesheet';

interface ChargeCodeCellProps {
  chargeCode: ChargeCode;
}

const CATEGORY_COLORS: Record<string, string> = {
  overhead: 'blue',
  ga: 'grape',
  irad: 'cyan',
  bp: 'orange',
  leave: 'green',
  unallowable: 'red',
};

export function ChargeCodeCell({ chargeCode }: ChargeCodeCellProps) {
  return (
    <Stack gap={4}>
      <Text fw={700} size="sm">
        {chargeCode.projectName}
      </Text>
      <Badge variant="light" size="sm" color={chargeCode.isIndirect ? (CATEGORY_COLORS[chargeCode.indirectCategory ?? ''] ?? 'gray') : undefined}>
        {chargeCode.clin}{chargeCode.slinNumber ? ` / ${chargeCode.slinNumber}` : ''}
      </Badge>
      {chargeCode.isIndirect && chargeCode.indirectCategory && (
        <Badge size="xs" variant="light" color={CATEGORY_COLORS[chargeCode.indirectCategory] ?? 'gray'}>
          {chargeCode.indirectCategory.toUpperCase()}
        </Badge>
      )}
      {chargeCode.slinNumber && !chargeCode.isIndirect && (
        <Text size="xs" c="dimmed">SLIN: {chargeCode.slinNumber}</Text>
      )}
      <Text c="dimmed" size="xs">
        {chargeCode.description}
      </Text>
    </Stack>
  );
}
