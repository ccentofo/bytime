'use client';

import Link from 'next/link';
import { Badge, Box, Button, Container, Grid, Group, Paper, Progress, Stack, Text, Title } from '@mantine/core';
import { PageHeader } from '@/components/ui/PageHeader';
import { addDays, dayOfWeek, type CalendarDate } from '@/lib/calendar-date';
import { CURRENT_RATES_NOTE, unpricedHoursLabel } from '@/lib/cost-labels';
import { BURN_TIER_COLOR, BURN_TIER_LABEL } from '@/lib/ui/burn';
import { attentionItems, burnCard, withDismissedNotices, type HomeView } from '@/lib/home/attention';
import { BACK_ON_KEY, RECOMMEND_KEY, useStoredFlag } from '@/components/approvals/ApprovalNotices';
import classes from './Home.module.css';

const STATUS_WORD: Record<string, string> = { draft: 'Not submitted', submitted: 'Submitted', approved: 'Approved', rejected: 'Returned' };
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Home (feature-plan-ux-navigation-home.md §4.5; mockup "Admin home"). Money only for admins (view.admin). */
export function HomeClient({ view }: { view: HomeView }) {
  // L10: notices dismissed in ApprovalNotices stay dismissed here (same keys). Read as dismissed on the server and the
  // first client render, so nothing flashes or mismatches.
  const backOn = view.admin?.notices.selfApprovalBackOn;
  const backOnDismissed = useStoredFlag(backOn ? BACK_ON_KEY(backOn.logId) : null);
  const recommendDismissed = useStoredFlag(RECOMMEND_KEY(view.userId));
  const items = attentionItems(withDismissedNotices(view, { backOn: backOnDismissed, recommend: recommendDismissed }));
  const p = view.myPeriod;
  const days: CalendarDate[] = [];
  for (let d = p.periodStart as CalendarDate; d <= p.periodEnd; d = addDays(d, 1)) days.push(d);
  const inProgress = view.team.inProgress.count + view.team.returned.count;
  const contracts = view.admin ? burnCard(view.admin.contracts).slice(0, 5) : [];

  return (
    <Container size="lg" py="xl">
      <PageHeader title="Home" />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Title order={2} size="h4" mb="sm">Needs your attention</Title>
          {items.length === 0 ? (
            <Paper withBorder p="lg" radius="md"><Text data-testid="all-caught-up">You&apos;re all caught up.</Text></Paper>
          ) : (
            <Stack gap="sm" data-testid="attention">
              {items.map((item) => (
                <Paper key={item.key} withBorder p="md" radius="md" data-testid={`attention-${item.key}`}>
                  <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <div>
                      <Text fw={600}>{item.title}</Text>
                      {item.sentence && <Text size="sm" c="dimmed" mt={2}>{item.sentence}</Text>}
                    </div>
                    {item.action && <Button component={Link} href={item.action.href} variant="light" size="compact-sm">{item.action.label}</Button>}
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            <Paper withBorder p="md" radius="md">
              <Title order={2} size="h5" mb={4}>Your timesheet</Title>
              <Text size="sm">{p.periodLabel}</Text>
              <Group gap="xs" mb="sm">
                <Badge variant="light">{STATUS_WORD[p.status] ?? p.status}</Badge>
                <Text size="xs" c="dimmed">Due {p.submissionDeadline}</Text>
              </Group>
              <div className={classes.cadence} aria-hidden="true" data-testid="cadence">
                {days.map((d) => {
                  const weekend = dayOfWeek(d) === 0 || dayOfWeek(d) === 6;
                  const h = p.dailyHours[d] ?? 0;
                  return (
                    <div key={d} className={classes.cell} data-today={d === view.today || undefined} data-weekend={weekend || undefined}>
                      {!weekend && <div className={classes.bar} style={{ height: `${Math.min(h / 8, 1) * 100}%` }} />}
                    </div>
                  );
                })}
              </div>
              <Text size="sm" mt="xs" data-testid="cadence-summary">
                {p.totalHoursEntered} hours entered. {p.workdaysFilled} of {p.expectedWorkdays} workdays so far are filled in.
              </Text>
              <Button component={Link} href="/timesheet" variant="default" size="compact-sm" mt="sm">Open timesheet</Button>
            </Paper>

            <Paper withBorder p="md" radius="md" data-testid="team">
              <Title order={2} size="h5" mb="xs">This pay period</Title>
              <Stack gap={2}>
                <Text size="sm">Submitted: {view.team.submitted.count}</Text>
                <Text size="sm">
                  In progress: {inProgress}{view.team.returned.count > 0 ? ` (${view.team.returned.count} returned)` : ''}
                </Text>
                <Text size="sm">Not started: {view.team.notStarted.count}</Text>
              </Stack>
            </Paper>

            {view.admin && (
              <Box>
                <Paper withBorder p="md" radius="md" data-testid="contracts">
                  <Title order={2} size="h5" mb="xs">Contracts</Title>
                  {contracts.length === 0 && <Text size="sm" c="dimmed">No funded active contracts.</Text>}
                  <Stack gap="sm">
                    {contracts.map((c) => (
                      <div key={c.contractId}>
                        <Group justify="space-between" gap="xs" wrap="nowrap">
                          <Text size="sm" fw={600} truncate>{c.contractName}</Text>
                          <Text size="xs" c="dimmed">{BURN_TIER_LABEL[c.tier]}</Text>
                        </Group>
                        <Progress value={Math.min(c.pct, 100)} color={BURN_TIER_COLOR[c.tier]} size="sm" my={4} aria-label={`${c.contractName}: ${c.pct}% of funding`} />
                        <Text size="xs" c="dimmed">
                          {money(c.pricedCost)} priced cost of {money(Number(c.fundedValue ?? 0))} funded ({c.pct}%)
                        </Text>
                        {unpricedHoursLabel(c.unpricedHours) && <Text size="xs" c="warning">{unpricedHoursLabel(c.unpricedHours)}</Text>}
                      </div>
                    ))}
                  </Stack>
                </Paper>
                <Text size="xs" c="dimmed" mt={4}>{CURRENT_RATES_NOTE}</Text>
              </Box>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
