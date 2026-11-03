'use client';

import { useEffect, useState, useTransition } from 'react';
import { Container, Title, Text, Paper, Group, Stack, Radio, Select, Alert, Badge } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { updatePayPeriodConfig, getValidScheduleChangeDates, type ConfigHistoryRow, type ScheduleChangeOptions, type UpdatePayPeriodConfigResult } from '@/server/actions/pay-period-config';
import { sameSchedule, type PeriodConfig, type PeriodType } from '@/lib/date-utils';
import { formatDate } from '@/lib/format';
import { dayOfWeek, isCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { PageHeader } from '@/components/ui/PageHeader';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { Icons, ICON_SIZE } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

/**
 * Settings → Pay schedule (feature-plan-ux-navigation-home.md §4.4): the pay-period configuration, split out of the old
 * combined Settings page.
 *
 * feature-plan-ux-page-fixes.md C7 (R1): the page holds the current schedule and the pending change (with its row id)
 * as explicit state. The form starts from the pending change if there is one. Save is aria-disabled with a reason
 * until the form differs from that baseline (or, for the pending schedule, its date changes), and it asks first. The
 * pending change has its own Cancel. Every write sends expectedPendingId, so a stale page is refused.
 */
interface Props {
  initialConfig: PeriodConfig;
  pendingChange: ConfigHistoryRow | null;
}

const IMMEDIATE = 'immediate';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const periodTypeOptions = (weekStartDay: number) => [
  { value: 'weekly', label: `Weekly (7 days, ${DAY_NAMES[weekStartDay]} to ${DAY_NAMES[(weekStartDay + 6) % 7]})` },
  { value: 'biweekly', label: 'Bi-Weekly (14 days)' },
  { value: 'semimonthly', label: 'Semi-Monthly (1st–15th, 16th–end) — Default' },
  { value: 'monthly', label: 'Monthly (full calendar month)' },
];

const WEEK_START_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
];

const PERIOD_TYPE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-Weekly',
  semimonthly: 'Semi-Monthly',
  monthly: 'Monthly',
};
/** The period type in a sentence ("… will use bi-weekly pay periods"). */
const typeWord = (t: PeriodType) => PERIOD_TYPE_LABELS[t].toLowerCase();

type Pending = { id: string; config: PeriodConfig; effectiveFrom: CalendarDate };

const REASON_MATCHES_CURRENT = 'This matches your current schedule. To keep it, use Cancel scheduled change.';
const REASON_UNCHANGED = 'Change the period type, anchor date or week start to schedule a change.';
const REASON_NO_DATE = 'Choose when the new schedule takes effect.';

export function PayScheduleClient({ initialConfig, pendingChange }: Props) {
  // State is initialised from props once; the page doesn't refresh after a save.
  const [currentCfg, setCurrentCfg] = useState<PeriodConfig>(initialConfig);
  const [pendingCfg, setPendingCfg] = useState<Pending | null>(() => pendingChange && {
    id: pendingChange.id,
    config: { periodType: pendingChange.periodType, anchorDate: pendingChange.anchorDate, weekStartDay: pendingChange.weekStartDay },
    effectiveFrom: pendingChange.effectiveFrom,
  });
  const start = pendingCfg?.config ?? initialConfig;
  const [periodType, setPeriodType] = useState<PeriodType>(start.periodType);
  const [anchorDate, setAnchorDate] = useState<CalendarDate | null>(start.anchorDate);
  const [weekStartDay, setWeekStartDay] = useState<string>(String(start.weekStartDay));
  const [isPending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<'save' | 'cancel' | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const formCfg: PeriodConfig = { periodType, anchorDate: anchorDate as CalendarDate, weekStartDay: parseInt(weekStartDay, 10) };
  const differsFromCurrent = !!anchorDate && !sameSchedule(formCfg, currentCfg);
  const formIsPending = !!pendingCfg && sameSchedule(formCfg, pendingCfg.config);

  // §0.9: effective_from must be a boundary common to both the current and the new schedule —
  // the server computes and offers the valid choices; the client never picks one out of thin air.
  const [changeOptions, setChangeOptions] = useState<ScheduleChangeOptions | null>(null);
  const [selectedEffectiveFrom, setSelectedEffectiveFrom] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    // Dates are only needed for a schedule that differs from the current one (including moving the pending change).
    if (!differsFromCurrent || !anchorDate) {
      setChangeOptions(null);
      setSelectedEffectiveFrom(null);
      setLoadingOptions(false);
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    setSelectedEffectiveFrom(null);
    getValidScheduleChangeDates({ periodType, anchorDate, weekStartDay: parseInt(weekStartDay, 10) })
      .then((options) => {
        if (cancelled) return;
        if (formIsPending && pendingCfg) {
          // The pending schedule starts on its own date: never IMMEDIATE or dates[0] here, or Save would look dirty.
          const dates = options.dates.includes(pendingCfg.effectiveFrom) ? options.dates : [pendingCfg.effectiveFrom, ...options.dates];
          setChangeOptions({ ...options, dates });
          setSelectedEffectiveFrom(pendingCfg.effectiveFrom);
        } else {
          setChangeOptions(options);
          setSelectedEffectiveFrom(options.immediate ? IMMEDIATE : (options.dates[0] ?? null));
        }
      })
      .catch((error) => {
        if (!cancelled) setChangeOptions({ immediate: false, dates: [], problem: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [periodType, anchorDate, weekStartDay, differsFromCurrent, formIsPending, pendingCfg]);

  // The dirty rule (C7 §3.4).
  const baseline = pendingCfg?.config ?? currentCfg;
  const configChanged = !!anchorDate && !sameSchedule(formCfg, baseline);
  const dateChanged = !!pendingCfg && !configChanged && selectedEffectiveFrom !== null && selectedEffectiveFrom !== pendingCfg.effectiveFrom;
  const dirty = configChanged || dateChanged;
  const saveBlockedReason = pendingCfg && anchorDate && sameSchedule(formCfg, currentCfg)
    ? REASON_MATCHES_CURRENT
    : !dirty ? REASON_UNCHANGED
      : !selectedEffectiveFrom ? (loadingOptions ? null : REASON_NO_DATE)
        : null;
  const canSave = dirty && !!selectedEffectiveFrom && !loadingOptions;

  function resetForm(cfg: PeriodConfig) {
    setPeriodType(cfg.periodType);
    setAnchorDate(cfg.anchorDate);
    setWeekStartDay(String(cfg.weekStartDay));
  }

  function openConfirm(kind: 'save' | 'cancel') {
    setConfirmError(null);
    setConfirm(kind);
  }

  function handleSave() {
    if (!canSave || !anchorDate || !selectedEffectiveFrom) return;
    const effectiveFrom = selectedEffectiveFrom === IMMEDIATE ? null : (selectedEffectiveFrom as CalendarDate);
    const saved = { ...formCfg };
    startTransition(async () => {
      const outcome = await runAction(updatePayPeriodConfig({
        ...saved,
        effectiveFrom,
        expectedPendingId: pendingCfg?.id ?? null,
      }), { silent: true });
      if (!outcome.ok) {
        setConfirmError(outcome.error);
        return;
      }
      const result: UpdatePayPeriodConfigResult = outcome.data;
      setConfirm(null);
      if (result.cancelledPending) {
        setPendingCfg(null);
        resetForm(currentCfg);
      } else if (result.effectiveFrom && result.pendingId) {
        setPendingCfg({ id: result.pendingId, config: saved, effectiveFrom: result.effectiveFrom });
      } else if (!result.effectiveFrom) {
        setCurrentCfg(saved);
        setPendingCfg(null);
      }
    });
  }

  function handleCancelPending() {
    if (!pendingCfg) return;
    startTransition(async () => {
      const outcome = await runAction(updatePayPeriodConfig({
        ...currentCfg,
        effectiveFrom: null,
        cancelPending: true,
        expectedPendingId: pendingCfg.id,
      }), { silent: true });
      if (!outcome.ok) {
        setConfirmError(outcome.error);
        return;
      }
      setConfirm(null);
      setPendingCfg(null);
      resetForm(currentCfg);
      notifications.show({ title: 'Scheduled change cancelled', message: 'Scheduled change cancelled.', color: 'success', icon: <Icons.statusSuccess size={ICON_SIZE.button} /> });
    });
  }

  const showAnchorDate = periodType === 'weekly' || periodType === 'biweekly';
  const effectiveFromChoices = [
    ...(changeOptions?.immediate ? [{ value: IMMEDIATE, label: 'Immediately (no timesheets entered yet)' }] : []),
    ...(changeOptions?.dates ?? []).map((d) => ({ value: d, label: formatDate(d) })),
  ];
  const saveMessage = selectedEffectiveFrom === IMMEDIATE
    ? `Every employee's timesheets will use ${typeWord(periodType)} pay periods starting now. No timesheets have been entered yet.`
    : `Starting ${formatDate(selectedEffectiveFrom as CalendarDate)}, every employee's timesheets will use ${typeWord(periodType)} pay periods. Current and past periods don't change.`;

  return (
    <Container size="md" py="xl">
      <PageHeader title="Pay schedule" description="How timesheets are divided into pay periods." />

      <Paper withBorder p="lg" radius="md" mb="xl">
        <Title order={4} mb="md">Pay Period Configuration</Title>

        {/* Pending change banner */}
        {pendingCfg && (
          <Alert icon={<Icons.statusInfo size={ICON_SIZE.button} />} color="signal" variant="light" mb="lg" data-testid="pending-change">
            <Group gap="xs" justify="space-between" wrap="nowrap" align="flex-start">
              <Group gap="xs">
                <Text size="sm">
                  <strong>Scheduled change:</strong> Your new {PERIOD_TYPE_LABELS[pendingCfg.config.periodType]} schedule
                  takes effect <strong>{formatDate(pendingCfg.effectiveFrom)}</strong>.
                  Current and past periods are unchanged.
                </Text>
                <Badge color="signal" variant="light" size="sm">Pending</Badge>
              </Group>
              <WriteButton variant="light" size="xs" onClick={() => openConfirm('cancel')}>
                Cancel scheduled change
              </WriteButton>
            </Group>
          </Alert>
        )}

        <Alert icon={<Icons.statusWarning size={ICON_SIZE.button} />} color="warning" variant="light" mb="lg">
          <Text size="sm">
            <strong>Future-effective only.</strong> Changes apply starting at a future date that's a
            period boundary under both your current and new schedule — the current period and all
            historical data are preserved. You cannot set a retroactive schedule.
          </Text>
        </Alert>

        <Stack gap="lg">
          <Radio.Group
            label="Period type"
            value={periodType}
            onChange={(val) => setPeriodType(val as PeriodType)}
          >
            <Stack gap="xs" mt="xs">
              {periodTypeOptions(parseInt(weekStartDay, 10)).map((opt) => (
                <Radio key={opt.value} value={opt.value} label={opt.label} />
              ))}
            </Stack>
          </Radio.Group>

          {showAnchorDate && (
            <DatePickerInput
              label="Anchor date"
              description={periodType === 'biweekly'
                ? `A ${DAY_NAMES[parseInt(weekStartDay, 10)]} that marks the start of a bi-weekly period. All periods are calculated relative to this date.`
                : `A ${DAY_NAMES[parseInt(weekStartDay, 10)]} that marks the start of a weekly period.`}
              value={anchorDate}
              onChange={(val) => setAnchorDate(val && isCalendarDate(val) ? val : null)}
              excludeDate={(d) => isCalendarDate(d) && dayOfWeek(d) !== parseInt(weekStartDay, 10)}
              placeholder="Select anchor date..."
              maw={360}
            />
          )}

          {(periodType === 'weekly' || periodType === 'biweekly') && (
            <Select
              label="Week start day"
              data={WEEK_START_OPTIONS}
              value={weekStartDay}
              onChange={(val) => setWeekStartDay(val ?? '1')}
              w={200}
              allowDeselect={false}
            />
          )}

          <div>
            <Select
              label="Effective from"
              description="Only dates that are a period boundary under both your current schedule and this new one are offered — this is what keeps every day in exactly one period across the change."
              data={effectiveFromChoices}
              value={selectedEffectiveFrom}
              onChange={setSelectedEffectiveFrom}
              placeholder={loadingOptions ? 'Finding valid dates…' : effectiveFromChoices.length === 0 ? 'No valid date' : 'Select effective date...'}
              disabled={loadingOptions || effectiveFromChoices.length === 0}
              maw={420}
              allowDeselect={false}
            />
            {!loadingOptions && changeOptions?.problem && (
              <Text size="xs" c="red" mt="xs">{changeOptions.problem}</Text>
            )}
          </div>

          <Stack gap={4}>
            <Group>
              <WriteButton
                onClick={() => { if (canSave) openConfirm('save'); }}
                aria-disabled={!canSave || undefined}
                data-disabled={!canSave || undefined}
                aria-describedby={saveBlockedReason ? 'pay-save-why' : undefined}
              >
                Save Schedule Change
              </WriteButton>
            </Group>
            {saveBlockedReason && <Text id="pay-save-why" size="xs" c="dimmed">{saveBlockedReason}</Text>}
          </Stack>

          <Text size="xs" c="dimmed">
            You can update this setting again before it takes effect — your most recent save
            replaces any pending change.
          </Text>
        </Stack>
      </Paper>

      <ConfirmModal
        opened={confirm === 'save'}
        tone="neutral"
        title="Change the pay schedule?"
        message={saveMessage}
        confirmLabel={selectedEffectiveFrom === IMMEDIATE ? 'Change schedule' : 'Schedule change'}
        loading={isPending}
        error={confirmError}
        onConfirm={handleSave}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmModal
        opened={confirm === 'cancel'}
        tone="neutral"
        title="Cancel the scheduled change?"
        message={`Your current ${typeWord(currentCfg.periodType)} schedule stays in effect.`}
        confirmLabel="Cancel scheduled change"
        cancelLabel="Keep scheduled change"
        loading={isPending}
        error={confirmError}
        onConfirm={handleCancelPending}
        onCancel={() => setConfirm(null)}
      />
    </Container>
  );
}
