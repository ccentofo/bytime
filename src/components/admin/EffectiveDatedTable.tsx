'use client';

import type { ReactNode } from 'react';
import { Button, Table } from '@mantine/core';

/**
 * The schedule table shared by the dated-rate and dated-category modals (feature-plan-dated-rates.md D2/D3).
 * Presentational: "From the start" then each change ascending; the caller supplies the value cells; every row can be
 * corrected, changes (not the starting row) can be removed.
 */
export interface EffectiveDatedRow { ref: 'starting' | string; label: string; cells: ReactNode[] }

export function EffectiveDatedTable({ headers, rows, canWrite, onCorrect, onRemove, testIdPrefix }: {
  headers: string[];
  rows: EffectiveDatedRow[];
  canWrite: boolean;
  onCorrect: (ref: EffectiveDatedRow['ref']) => void;
  onRemove: (ref: string) => void;
  testIdPrefix: string;
}) {
  return (
    <Table data-testid={`${testIdPrefix}-schedule`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>From</Table.Th>
          {headers.map((h) => <Table.Th key={h}>{h}</Table.Th>)}
          <Table.Th />
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.ref}>
            <Table.Td>{r.label}</Table.Td>
            {r.cells.map((c, i) => <Table.Td key={i}>{c}</Table.Td>)}
            <Table.Td>
              <Button size="xs" variant="subtle" disabled={!canWrite} onClick={() => onCorrect(r.ref)} data-testid={`${testIdPrefix}-correct-${r.ref}`}>Correct</Button>
            </Table.Td>
            <Table.Td>
              {r.ref !== 'starting' && (
                <Button size="xs" variant="subtle" color="red" disabled={!canWrite} onClick={() => onRemove(r.ref)} data-testid={`${testIdPrefix}-remove-${r.ref}`}>Remove</Button>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
