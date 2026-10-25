'use client';

import { Anchor, Badge, Group, Paper, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { CURRENT_RATES_NOTE } from '@/lib/cost-labels';
import type { UnpricedHoursReportRow } from '@/server/actions/labor-categories';
import type { OverlapRow } from '@/server/internal/cost-basis';

/**
 * feature-plan-certified-outputs.md C3 reports (CO-D10/CO-D17): "Unpriced hours" — every entry the cost-basis rule left
 * without a price, and how to fix it — and "Overlapping labor-category assignments". Opened from the "X hours unpriced"
 * links (scoped by ?contractId / clinId / slinId / startDate / endDate).
 */
export function CostBasisReports({ report, unpriced, overlaps, scoped }: {
  report: 'unpriced' | 'overlaps';
  unpriced: { rows: UnpricedHoursReportRow[]; truncated: boolean };
  overlaps: OverlapRow[];
  scoped: boolean;
}) {
  const router = useRouter();
  const total = Math.round(unpriced.rows.reduce((s, r) => s + r.hours, 0) * 100) / 100;
  return (
    <Paper withBorder p="lg" radius="md" mt="xl" id="cost-basis-reports">
      <Group justify="space-between" mb="sm">
        <Title order={4}>Cost basis</Title>
        <SegmentedControl
          value={report}
          onChange={(v) => router.push(`/admin/labor-categories?report=${v}#cost-basis-reports`)}
          data={[{ value: 'unpriced', label: `Unpriced hours (${unpriced.rows.length}${unpriced.truncated ? '+' : ''})` }, { value: 'overlaps', label: `Overlapping assignments (${overlaps.length})` }]}
        />
      </Group>
      <Text size="xs" c="dimmed" mb="md">
        Each hour is priced with its charge code&apos;s labor category, else the employee&apos;s labor category on that SLIN,
        else on that CLIN (effective on the day worked). With none — or two different ones at the same level — the hour is
        unpriced: it counts in hours, carries no cost, and is listed here. {CURRENT_RATES_NOTE}
      </Text>

      {report === 'unpriced' && (
        <Stack gap="xs">
          {scoped && (
            <Text size="xs">Showing the hours behind one total. <Anchor size="xs" href="/admin/labor-categories?report=unpriced#cost-basis-reports">Show all</Anchor></Text>
          )}
          {unpriced.rows.length === 0 ? (
            <Text size="sm" c="dimmed">No unpriced hours — every hour has a labor category.</Text>
          ) : (
            <>
              <Text size="sm" fw={600}>{total} hours unpriced{unpriced.truncated ? ' (first 500 entries shown)' : ''}</Text>
              <Table.ScrollContainer minWidth={800}>
                <Table striped withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Employee</Table.Th><Table.Th>Date</Table.Th><Table.Th>Code</Table.Th><Table.Th>Hours</Table.Th>
                      <Table.Th>Reason</Table.Th><Table.Th>How to fix</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {unpriced.rows.map((r, i) => (
                      <Table.Tr key={`${r.userId}-${r.entryDate}-${r.chargeCodeId ?? r.clinId}-${i}`}>
                        <Table.Td>{r.employeeName}</Table.Td>
                        <Table.Td>{r.entryDate}</Table.Td>
                        <Table.Td>{r.chargeCode ?? `CLIN ${r.clinNumber}`}{r.slinNumber ? ` / SLIN ${r.slinNumber}` : ''}</Table.Td>
                        <Table.Td>{r.hours.toFixed(2)}</Table.Td>
                        <Table.Td><Badge color={r.reason === 'conflict' ? 'warning' : 'gray'} variant="light">{r.reason === 'conflict' ? 'Two categories' : 'No category'}</Badge></Table.Td>
                        <Table.Td>
                          <Text size="sm">{r.fix}</Text>
                          <Group gap="xs">
                            {r.reason === 'conflict' ? (
                              <Anchor size="xs" href="/admin/labor-categories?report=overlaps#cost-basis-reports">Overlapping assignments</Anchor>
                            ) : (
                              <>
                                {r.chargeCode && <Anchor size="xs" href="/admin/charge-codes">Charge codes</Anchor>}
                                <Anchor size="xs" href="/admin/labor-categories">Assign a labor category</Anchor>
                              </>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </>
          )}
        </Stack>
      )}

      {report === 'overlaps' && (
        overlaps.length === 0 ? (
          <Text size="sm" c="dimmed">No overlapping assignments.</Text>
        ) : (
          <Table.ScrollContainer minWidth={800}>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Employee</Table.Th><Table.Th>Where</Table.Th><Table.Th>Assignment A</Table.Th><Table.Th>Assignment B</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {overlaps.map((o) => (
                  <Table.Tr key={`${o.a.assignmentId}-${o.b.assignmentId}`}>
                    <Table.Td>{o.employeeName}</Table.Td>
                    <Table.Td>{o.level === 'slin' ? `SLIN ${o.slinNumber}` : `CLIN ${o.clinNumber}`}</Table.Td>
                    {[o.a, o.b].map((x) => (
                      <Table.Td key={x.assignmentId}>{x.lcatCode} — {x.title}<br /><Text span size="xs" c="dimmed">{x.effectiveDate} → {x.endDate ?? 'open'}</Text></Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )
      )}
    </Paper>
  );
}
