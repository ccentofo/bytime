'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Container, Group, Select, Stack, Text } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { PageHeader } from '@/components/ui/PageHeader';
import { Notice } from '@/components/ui/Notice';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useBusy } from '@/components/ui/useBusy';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { runAction } from '@/lib/run-action';
import { toastError } from '@/lib/toast';
import { REQUIRED_SETUP_STEPS, SETUP_STEP_TITLE, type SetupStepKey } from '@/lib/setup/steps';
import { DAY_NAMES, timezoneOptions } from '@/lib/timezone-options';
import { isCalendarDate } from '@/lib/calendar-date';
import { getSetupPageData } from '@/server/actions/setup';
import { updateWorkspaceTimezone, updateWorkweekStartDay } from '@/server/actions/workspace-settings';
import { updatePayPeriodConfig } from '@/server/actions/pay-period-config';
import type { SetupPageData, SetupStep } from '@/server/internal/setup';
import { CreateFromClinsModal } from '@/app/(app)/admin/charge-codes/CreateFromClinsModal';
import {
  DEFAULT_ANCHOR, PERIOD_OPTIONS, accessGapNote, clinsWithoutCodeWarning, nowStep, showsInlineForm, stepDetail, type PeriodChoice,
} from './setup-view';
import classes from './SetupChecklist.module.css';

const DAY_OPTIONS = DAY_NAMES.map((d, i) => ({ value: String(i), label: d }));

/**
 * The Setup checklist (feature-plan-ux-setup-import.md §3.3): progress, a pointer to Import, the six required steps and
 * the three recommended ones. The two settings steps edit inline while it's safe (P5); every other step links to its
 * page. After a save the page data is refetched; when a save completes a step its form unmounts, so focus moves to that
 * step's heading and a polite status announces it.
 */
export function SetupChecklistClient({ initialData }: { initialData: SetupPageData }) {
  const [data, setData] = useState(initialData);
  const busy = useBusy();
  const [announcement, setAnnouncement] = useState('');
  const headings = useRef<Partial<Record<SetupStepKey, HTMLHeadingElement | null>>>({});
  const [bridgeOpen, setBridgeOpen] = useState(false);

  const { status } = data;
  const step = (key: SetupStepKey) => status.steps.find((s) => s.key === key)!;
  const recommended = status.steps.filter((s) => !s.required);
  const recommendedLeft = recommended.filter((s) => !s.done).length;
  const now = nowStep(status.steps);

  /** Refetch; if `key` just became done, move focus to its heading (its form is gone) and announce it. */
  async function refresh(key?: SetupStepKey) {
    let fresh: SetupPageData;
    try {
      fresh = await getSetupPageData();
    } catch {
      toastError({ title: 'Checklist not refreshed', message: 'Saved, but the checklist couldn’t refresh. Reload the page.' });
      return;
    }
    const wasDone = key ? step(key).done : true;
    setData(fresh);
    if (key && !wasDone && fresh.status.steps.find((s) => s.key === key)?.done) {
      setAnnouncement(`${SETUP_STEP_TITLE[key]} saved`);
      requestAnimationFrame(() => headings.current[key]?.focus());
    }
  }

  const required = status.steps.filter((s) => s.required);

  function badge(s: SetupStep) {
    if (s.key === 'chargeCodeAccess' && s.done && (s.withAccess ?? 0) < (s.total ?? 0)) {
      return <StatusBadge word={`${s.withAccess} of ${s.total}`} tone="warn" />;
    }
    if (s.done) return <StatusBadge word="Done" tone="ok" />;
    return <StatusBadge word={s.required ? 'Required' : 'Recommended'} tone={s.required ? 'warn' : 'dim'} />;
  }

  function stepItem(s: SetupStep, n: number) {
    const partial = s.key === 'chargeCodeAccess' && s.done && (s.withAccess ?? 0) < (s.total ?? 0);
    const titleId = `setup-step-${s.key}`;
    return (
      <li key={s.key} className={classes.step} data-step={s.key} data-now={s.key === now || undefined} data-done={s.done || undefined} aria-labelledby={titleId}>
        <span className={classes.dot} data-state={partial ? 'partial' : s.done ? 'done' : 'todo'} aria-hidden="true">{s.done && !partial ? '✓' : s.required ? n : '·'}</span>
        <div className={classes.body}>
          <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
            <div>
              <h3 id={titleId} className={classes.title} tabIndex={-1} ref={(el) => { headings.current[s.key] = el; }}>{SETUP_STEP_TITLE[s.key]}</h3>
              <Text size="sm" c="dimmed" data-testid={`detail-${s.key}`}>{stepDetail(s.key, data)}</Text>
              {s.key === 'chargeCodes' && clinsWithoutCodeWarning(data) && (
                <Text size="sm" c="var(--mantine-color-warning-text)" data-testid="clins-without-code">{clinsWithoutCodeWarning(data)}</Text>
              )}
              {s.key === 'chargeCodeAccess' && accessGapNote(data) && (
                <Text size="sm" c="dimmed" data-testid="access-gaps">{accessGapNote(data)}</Text>
              )}
            </div>
            {badge(s)}
          </Group>
          <div className={classes.action}>{stepAction(s)}</div>
        </div>
      </li>
    );
  }

  function stepAction(s: SetupStep) {
    switch (s.key) {
      case 'timeAndWeek':
        return showsInlineForm(s, status.hasTimesheetData)
          ? <TimeAndWeekForm data={data} busy={busy} onSaved={() => refresh('timeAndWeek')} />
          : <Anchor component={Link} href="/settings/workspace" size="sm">Change on Workspace</Anchor>;
      case 'paySchedule':
        return showsInlineForm(s, status.hasTimesheetData)
          ? <PayScheduleForm data={data} busy={busy} onSaved={() => refresh('paySchedule')} />
          : <Anchor component={Link} href="/settings/pay-schedule" size="sm">Change on Pay schedule</Anchor>;
      case 'contractsClins':
        return <Anchor component={Link} href="/admin/contracts" size="sm">Open Contracts</Anchor>;
      case 'chargeCodes':
        return status.counts.clinsWithoutCode > 0
          ? <WriteButton variant="default" size="xs" onClick={() => setBridgeOpen(true)}>Create codes from CLINs…</WriteButton>
          : <Anchor component={Link} href="/admin/charge-codes" size="sm">Open Charge codes</Anchor>;
      case 'people':
        return <Anchor component={Link} href="/admin/users" size="sm">{s.done ? 'Open Users' : 'Add people'}</Anchor>;
      case 'chargeCodeAccess':
        return <Anchor component={Link} href="/admin/assignments" size="sm">Give access</Anchor>;
      case 'indirectCodes':
        return <Anchor component={Link} href="/admin/charge-codes?tab=indirect" size="sm">Open Charge codes</Anchor>;
      case 'laborCategories':
        return <Anchor component={Link} href="/admin/labor-categories" size="sm">Open Labor categories</Anchor>;
      case 'connection':
        return <Anchor component={Link} href="/settings/integrations" size="sm">Open Integrations</Anchor>;
    }
  }

  return (
    <Container size="md" py="xl">
      <PageHeader
        title="Setup checklist"
        description="Everything a new workspace needs before people can record time. Steps can be done in any order. The first six are required."
      />
      <Stack gap="md">
        <div className={classes.progress} data-testid="setup-progress">
          <Text fw={600}>{status.requiredDone} of {REQUIRED_SETUP_STEPS} required steps done</Text>
          <div className={classes.bar} aria-hidden="true"><span style={{ width: `${(status.requiredDone / REQUIRED_SETUP_STEPS) * 100}%` }} /></div>
          {recommendedLeft > 0 && <Text size="sm" c="dimmed">{recommendedLeft} recommended {recommendedLeft === 1 ? 'step' : 'steps'} below.</Text>}
        </div>
        {status.isComplete && (
          <div data-testid="setup-complete"><Notice tone="info">Your workspace is set up. People can record time.</Notice></div>
        )}
        <Notice tone="info" action={{ label: 'Go to Import', href: '/settings/import' }}>
          Have a spreadsheet? Import people, contracts, CLINs, labor categories, charge codes and access in one go.
        </Notice>
        <ol className={classes.list} data-testid="setup-required">
          {required.map((s, i) => stepItem(s, i + 1))}
        </ol>
        <h2 className={classes.h2}>Recommended</h2>
        <ul className={classes.list} data-testid="setup-recommended">
          {recommended.map((s, i) => stepItem(s, required.length + i + 1))}
        </ul>
      </Stack>
      <div role="status" aria-live="polite" className={classes.srOnly} data-testid="setup-announce">{announcement}</div>
      <CreateFromClinsModal opened={bridgeOpen} onClose={() => setBridgeOpen(false)} onCreated={() => refresh('chargeCodes')}
        hasActiveClins={status.counts.clins > 0 && status.counts.contracts > 0} />
    </Container>
  );
}

type Busy = ReturnType<typeof useBusy>;

/** P5 inline: the time zone (pre-selected) and the FLSA workweek (no default). Validated on click. */
function TimeAndWeekForm({ data, busy, onSaved }: { data: SetupPageData; busy: Busy; onSaved: () => Promise<void> }) {
  const [timezone, setTimezone] = useState<string | null>(data.settings.timezone);
  const [day, setDay] = useState<string | null>(data.settings.workweekStartDay === null ? null : String(data.settings.workweekStartDay));
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  async function save() {
    setServerError(null);
    if (day === null) { setError('Choose the day the workweek starts.'); return; }
    setError(null);
    await busy.run('time', async () => {
      try {
        if (timezone && timezone !== data.settings.timezone) {
          const tz = await runAction(updateWorkspaceTimezone(timezone), { silent: true });
          if (!tz.ok) { setServerError(tz.error); return; }
        }
        const wk = await runAction(updateWorkweekStartDay(Number(day)), { silent: true });
        if (!wk.ok) setServerError(wk.error);
      } finally {
        await onSaved();   // §3.3: refetch on any outcome, so a partial save (time zone saved, workweek failed) retries correctly
      }
    });
  }

  return (
    <Stack gap="xs" data-testid="form-timeAndWeek">
      {serverError && <Alert color="red" role="alert">{serverError}</Alert>}
      <Group align="flex-start" gap="sm">
        <Select label="Time zone" searchable data={timezoneOptions(timezone)} value={timezone} onChange={setTimezone} allowDeselect={false} w={260} />
        <Select label="Workweek starts on (FLSA overtime)" description="Overtime is worked out per workweek." data={DAY_OPTIONS} value={day}
          onChange={(v) => { setDay(v); setError(null); }} error={error} placeholder="Choose a day" w={260} />
      </Group>
      <Group><WriteButton size="xs" {...busy.props('time')} onClick={() => { void save(); }}>Save</WriteButton></Group>
    </Stack>
  );
}

/** P5 inline: the pay schedule, saved immediately (P6: the default can be confirmed with no row yet). */
function PayScheduleForm({ data, busy, onSaved }: { data: SetupPageData; busy: Busy; onSaved: () => Promise<void> }) {
  const current = data.settings.payConfig;
  const [periodType, setPeriodType] = useState<PeriodChoice>((current.periodType as PeriodChoice) ?? 'semimonthly');
  const [anchor, setAnchor] = useState<string | null>(periodType === 'weekly' || periodType === 'biweekly' ? current.anchorDate : null);
  const [weekStart, setWeekStart] = useState<string>(String(data.settings.workweekStartDay ?? current.weekStartDay ?? 1));
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const weekly = periodType === 'weekly' || periodType === 'biweekly';

  async function save() {
    setServerError(null);
    if (weekly && (!anchor || !isCalendarDate(anchor))) { setAnchorError('Choose the date the first period starts.'); return; }
    setAnchorError(null);
    await busy.run('pay', async () => {
      const result = await runAction(updatePayPeriodConfig({
        periodType,
        anchorDate: (weekly ? anchor : DEFAULT_ANCHOR) as never,
        weekStartDay: weekly ? Number(weekStart) : 1,
        effectiveFrom: null,
      }), { silent: true });
      if (!result.ok) {
        // The anchor rule's message belongs next to the date (it must fall on the pay week's first day).
        if (weekly && /anchor|start/i.test(result.error)) setAnchorError(result.error); else setServerError(result.error);
        return;
      }
      await onSaved();
    });
  }

  return (
    <Stack gap="xs" data-testid="form-paySchedule">
      {serverError && <Alert color="red" role="alert">{serverError}</Alert>}
      <Group align="flex-start" gap="sm">
        <Select label="Pay periods" data={PERIOD_OPTIONS.map((o) => ({ ...o }))} value={periodType} allowDeselect={false}
          onChange={(v) => setPeriodType((v as PeriodChoice) ?? 'semimonthly')} w={300} />
        {weekly && (
          <>
            <DateInput label="First period starts" value={anchor} onChange={(d) => { setAnchor(d); setAnchorError(null); }} error={anchorError} valueFormat="MMM D, YYYY" w={200} />
            <Select label="Pay weeks start on" data={DAY_OPTIONS} value={weekStart} allowDeselect={false} onChange={(v) => setWeekStart(v ?? '1')} w={180} />
          </>
        )}
      </Group>
      <Group><WriteButton size="xs" {...busy.props('pay')} onClick={() => { void save(); }}>Save pay schedule</WriteButton></Group>
    </Stack>
  );
}

