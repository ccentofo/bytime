'use client';

import { Badge, Stack, Text, Tooltip } from '@mantine/core';
import type { ChargeCode } from '@/types/timesheet';
import type { Density } from '../BiWeeklyTable';
import { INDIRECT_CATEGORY_COLOR, WORK_LOCATION_COLOR } from '@/lib/ui/status-colors';

interface ChargeCodeCellProps {
  chargeCode: ChargeCode;
  density?: Density;
}

export function ChargeCodeCell({ chargeCode, density = 'comfortable' }: ChargeCodeCellProps) {
  const isDense = density === 'dense';
  const descFontSize = isDense ? 10 : undefined;

  // For direct codes: description = the charge code name; clin = the code string; projectName = contract name
  // For indirect codes: unchanged
  const primaryLabel = chargeCode.isIndirect ? chargeCode.projectName : chargeCode.description;
  const codeLabel = chargeCode.clin; // charge_codes.code for direct, indirect code for indirect
  const secondaryLabel = chargeCode.isIndirect ? null : chargeCode.projectName; // contract name as context

  const descElement = isDense && secondaryLabel ? (
    <Tooltip label={secondaryLabel} withArrow multiline maw={260} position="right">
      <Text c="dimmed" size="xs" style={{ fontSize: descFontSize, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', cursor: 'default' }}>
        {secondaryLabel}
      </Text>
    </Tooltip>
  ) : secondaryLabel ? (
    <Text c="dimmed" size="xs">{secondaryLabel}</Text>
  ) : null;

  return (
    <Stack gap={isDense ? 2 : 4}>
      {/* certified-outputs C4 (CO-D8): rows kept only because they have recorded hours in this period. */}
      {!chargeCode.assignable && (
        <Text size="xs" c="warning" fw={600}>Closed to new hours — you can correct existing hours</Text>
      )}
      <Text fw={700} size={isDense ? 'xs' : 'sm'}
        style={isDense ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}>
        {primaryLabel}
      </Text>
      <Badge
        variant="light"
        size={isDense ? 'xs' : 'sm'}
        color={chargeCode.isIndirect ? (INDIRECT_CATEGORY_COLOR[chargeCode.indirectCategory ?? ''] ?? 'gray') : 'ink'}
      >
        {codeLabel}{chargeCode.slinNumber ? ` / ${chargeCode.slinNumber}` : ''}
      </Badge>

      {/* Work-location badge for direct codes */}
      {!chargeCode.isIndirect && chargeCode.workLocation && (
        <Badge size="xs" variant="light" color={WORK_LOCATION_COLOR[chargeCode.workLocation] ?? 'gray'}>
          {chargeCode.workLocation}
        </Badge>
      )}

      {chargeCode.isIndirect && chargeCode.indirectCategory && (
        <Badge size="xs" variant="light" color={INDIRECT_CATEGORY_COLOR[chargeCode.indirectCategory] ?? 'gray'}>
          {chargeCode.indirectCategory.toUpperCase()}
        </Badge>
      )}

      {chargeCode.slinNumber && !chargeCode.isIndirect && (
        <Text size="xs" c="dimmed" style={isDense ? { fontSize: 10 } : undefined}>
          SLIN: {chargeCode.slinNumber}
        </Text>
      )}

      {descElement}
    </Stack>
  );
}
