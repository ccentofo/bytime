'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert, Anchor, Button, Container, Drawer, Group, Loader, Modal, Paper, Select, Stack, Table, Tabs, Text, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Notice } from '@/components/ui/Notice';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { WriteButton, useCanWrite } from '@/components/shell/WorkspaceMode';
import { runAction } from '@/lib/run-action';
import { formatInstant, type CalendarDate } from '@/lib/calendar-date';
import { periodLabel } from '@/lib/timesheet/labels';
import {
  emailSuggestions, seeFailuresLabel, syncResultText, type EmailSuggestion, type PersonMatchType, type ProviderPerson,
} from '@/lib/integrations/sync-display';
import { loadQboMappingData, triggerQBOSync } from '@/server/actions/qbo';
import {
  deleteMapping, disconnectIntegration, getSendPreview, getSyncFailures, matchPeopleByEmail, saveMapping, setPersonMapping,
  type SendPreview, type SyncLog,
} from '@/server/actions/integrations';
import { MappingSelect } from './MappingSelect';

dayjs.extend(relativeTime);

export interface ConfigMapping {
  id: string;
  entityType: string;
  bytimeEntityId: string;
  bytimeEntityName: string | null;
  externalEntityId: string;
  externalEntityName: string | null;
}

export interface SendPeriodOption { start: CalendarDate; end: CalendarDate; label: string }

type QboList<T> = { ok: true; data: T[] } | { ok: false; error: string };
interface QboLists {
  employees: QboList<ProviderPerson>;
  vendors: QboList<ProviderPerson>;
  customers: QboList<{ id: string; name: string }>;
  items: QboList<{ id: string; name: string }>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const people = (n: number) => plural(n, 'person', 'people');
const HOW: Record<string, string> = { manual: 'Manual', auto: 'On approval', retry: 'Retry' };
const NONE = 'none';
const TITLE = 'QuickBooks Online';

/** The rendered "now" for relative times, ticking once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The QuickBooks integration page (feature-plan-ux-integrations-billing.md I2–I7, §3.2): status line, People /
 * Contracts / CLINs matching with counts, History, "Send hours now…", Reconnect when expired, Disconnect. QuickBooks
 * data loads when the page opens (one action, I3); the auto-sync switch isn't shown (product owner).
 */
export function IntegrationConfigView({
  connection,
  people: persons,
  contracts,
  clins,
  mappings: initialMappings,
  syncLogs,
  periods,
  expiredMessage,
  workspaceTimezone,
}: {
  connection: { id: string; companyName: string | null; connectedAt: Date; expired: boolean };
  people: Array<{ id: string; fullName: string; email: string }>;
  contracts: Array<{ id: string; contractNumber: string; name: string }>;
  clins: Array<{ id: string; clinNumber: string; description: string | null }>;
  mappings: ConfigMapping[];
  syncLogs: SyncLog[];
  /** Last completed (the default), this period, and the two before — built by the page from the schedule. */
  periods: SendPeriodOption[];
  /** connectionExpiredError('QuickBooks').message, from the server. */
  expiredMessage: string;
  workspaceTimezone: string;
}) {
  const router = useRouter();
  const canWrite = useCanWrite();
  const now = useNow();
  const [mappings, setMappings] = useState(initialMappings);
  // A router.refresh() (after a send or a match by email) brings new mappings from the server: adopt them (state
  // adjusted during render when the prop changes, not in an effect).
  const [seenMappings, setSeenMappings] = useState(initialMappings);
  if (seenMappings !== initialMappings) {
    setSeenMappings(initialMappings);
    setMappings(initialMappings);
  }
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(new Set());
  const setBusy = (key: string, on: boolean) => setBusyRows((prev) => {
    const next = new Set(prev);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  // ── I3: load QuickBooks data when the page opens (a ref guards StrictMode's double effect) ─────────────────────
  const [lists, setLists] = useState<QboLists | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadStarted = useRef(false);
  async function load() {
    setLoading(true);
    const result = await runAction(loadQboMappingData(connection.id), { silent: true });
    setLoading(false);
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setLists(result.data as QboLists);
    setLoadedAt(Date.now());
  }
  useEffect(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listData = <T,>(l: QboList<T> | undefined): T[] => (l && l.ok ? l.data : []);
  const employees = listData(lists?.employees);
  const vendors = listData(lists?.vendors);
  // UX-4C2B-AUDIT.md F2, F3: a list counts only once it loaded.
  const employeesOk = !!lists?.employees.ok;
  const vendorsOk = !!lists?.vendors.ok;

  // ── People (I4, I5) ───────────────────────────────────────────────────────────────────────────────────────────
  const personRows = useMemo(() => {
    const byUser = new Map<string, { employee?: ConfigMapping; vendor?: ConfigMapping }>();
    for (const m of mappings) {
      if (m.entityType !== 'employee' && m.entityType !== 'vendor') continue;
      byUser.set(m.bytimeEntityId, { ...byUser.get(m.bytimeEntityId), [m.entityType]: m });
    }
    return persons.map((p) => ({ ...p, ...byUser.get(p.id) }));
  }, [persons, mappings]);
  const matchedCount = personRows.filter((p) => p.employee || p.vendor).length;
  // F3: email suggestions (and "Match by email") need BOTH lists — with one missing, an email on an employee and a
  // vendor wouldn't be seen as ambiguous.
  const suggestions = useMemo(() => !(employeesOk && vendorsOk) ? new Map<string, EmailSuggestion>() : emailSuggestions(
    persons,
    employees,
    vendors,
    {
      userIds: new Set(personRows.filter((p) => p.employee || p.vendor).map((p) => p.id)),
      employeeIds: new Set(mappings.filter((m) => m.entityType === 'employee').map((m) => m.externalEntityId)),
      vendorIds: new Set(mappings.filter((m) => m.entityType === 'vendor').map((m) => m.externalEntityId)),
    },
  ), [persons, employees, vendors, personRows, mappings, employeesOk, vendorsOk]);

  async function choosePerson(userId: string, name: string, match: { type: PersonMatchType; externalId: string; externalName: string } | null) {
    const key = `person:${userId}`;
    if (busyRows.has(key)) return;
    const before = mappings.filter((m) => m.bytimeEntityId === userId && (m.entityType === 'employee' || m.entityType === 'vendor'));
    const optimistic: ConfigMapping | null = match
      ? { id: `pending-${userId}`, entityType: match.type, bytimeEntityId: userId, bytimeEntityName: name, externalEntityId: match.externalId, externalEntityName: match.externalName }
      : null;
    const isPerson = (m: ConfigMapping) => m.bytimeEntityId === userId && (m.entityType === 'employee' || m.entityType === 'vendor');
    setMappings((prev) => [...prev.filter((m) => !isPerson(m)), ...(optimistic ? [optimistic] : [])]);
    setBusy(key, true);
    const result = await runAction(setPersonMapping({ connectionId: connection.id, userId, match }), { errorTitle: 'Couldn’t save the match' });
    setBusy(key, false);
    if (!result.ok) {
      setMappings((prev) => [...prev.filter((m) => !isPerson(m)), ...before]); // reverted
      return;
    }
    const saved = result.data.mapping;
    setMappings((prev) => [...prev.filter((m) => !isPerson(m)), ...(saved ? [saved as ConfigMapping] : [])]);
  }

  const [matchingByEmail, setMatchingByEmail] = useState(false);
  async function matchByEmail() {
    if (matchingByEmail || suggestions.size === 0) return;
    setMatchingByEmail(true);
    const pairs = [...suggestions].map(([userId, s]) => ({ userId, match: { type: s.type, externalId: s.externalId, externalName: s.externalName } }));
    const result = await runAction(matchPeopleByEmail({ connectionId: connection.id, pairs }), { errorTitle: 'Couldn’t match by email' });
    setMatchingByEmail(false);
    if (!result.ok) return;
    const { matched, skipped } = result.data;
    notifications.show({
      title: 'Matched by email',
      message: `${people(matched)} matched.${skipped > 0 ? ` ${people(skipped)} skipped (already matched or inactive).` : ''}`,
      color: skipped > 0 ? 'warning' : 'success',
    });
    router.refresh();
  }

  // ── Contracts and CLINs (C13) ─────────────────────────────────────────────────────────────────────────────────
  async function saveEntity(entityType: 'contract' | 'clin', bytimeId: string, bytimeName: string, externalId: string, externalName: string) {
    const key = `${entityType}:${bytimeId}`;
    setBusy(key, true);
    const saved = await runAction(saveMapping({
      connectionId: connection.id, entityType, bytimeEntityId: bytimeId, bytimeEntityName: bytimeName, externalEntityId: externalId, externalEntityName: externalName,
    }), { errorTitle: 'Couldn’t save the match' });
    setBusy(key, false);
    if (!saved.ok) return;
    const row: ConfigMapping = { id: saved.data.id, entityType, bytimeEntityId: bytimeId, bytimeEntityName: bytimeName, externalEntityId: externalId, externalEntityName: externalName };
    setMappings((prev) => [...prev.filter((m) => !(m.entityType === entityType && m.bytimeEntityId === bytimeId)), row]);
  }
  async function clearEntity(entityType: 'contract' | 'clin', bytimeId: string) {
    const mapping = mappings.find((m) => m.entityType === entityType && m.bytimeEntityId === bytimeId);
    if (!mapping) return;
    const key = `${entityType}:${bytimeId}`;
    setBusy(key, true);
    const result = await runAction(deleteMapping(mapping.id), { errorTitle: 'Couldn’t remove the match' });
    setBusy(key, false);
    if (result.ok || result.error === 'That mapping no longer exists.') setMappings((prev) => prev.filter((m) => m.id !== mapping.id));
  }

  // ── Header actions ───────────────────────────────────────────────────────────────────────────────────────────
  const [sendOpen, setSendOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  async function disconnect() {
    setDisconnecting(true);
    const result = await runAction(disconnectIntegration(connection.id), { silent: true });
    if (!result.ok) {
      setDisconnecting(false);
      setDisconnectError(result.error);
      return;
    }
    window.location.href = '/settings/integrations';
  }

  const expired = connection.expired || loadError === expiredMessage;
  const reconnect = canWrite
    ? <Button component="a" href="/api/integrations/qbo-connect" variant="filled">Reconnect</Button>
    : <WriteButton variant="filled">Reconnect</WriteButton>;

  const contractCount = contracts.filter((c) => mappings.some((m) => m.entityType === 'contract' && m.bytimeEntityId === c.id)).length;
  const clinCount = clins.filter((c) => mappings.some((m) => m.entityType === 'clin' && m.bytimeEntityId === c.id)).length;
  const listError = (l: QboList<unknown> | undefined) => (l && !l.ok ? l.error : null);

  return (
    <Container size="lg" py="xl">
      <PageHeader
        title={TITLE}
        breadcrumb={<><Anchor component={Link} href="/settings/integrations" size="sm">Integrations</Anchor> › {TITLE}</>}
        description={`Connected to ${connection.companyName ?? 'QuickBooks'} since ${formatInstant(new Date(connection.connectedAt), workspaceTimezone, 'MMM D, YYYY')}.`}
        actions={(
          <Group gap="xs">
            <WriteButton variant={expired ? 'default' : 'filled'} onClick={() => setSendOpen(true)}>Send hours now…</WriteButton>
            {expired && reconnect}
            <WriteButton variant="subtle" color="red" onClick={() => { setDisconnectError(null); setDisconnectOpen(true); }}>Disconnect…</WriteButton>
          </Group>
        )}
      />

      <Paper withBorder p="sm" radius="md" mb="md" aria-busy={loading || undefined} data-testid="qbo-status-line">
        <Group justify="space-between" gap="sm">
          {loading ? (
            <Group gap="xs"><Loader size="xs" aria-hidden="true" /><Text size="sm">Loading QuickBooks data…</Text></Group>
          ) : loadError ? (
            <Text size="sm" c="red" role="alert">{loadError}</Text>
          ) : (
            <Text size="sm" c="dimmed">QuickBooks data loaded {loadedAt ? dayjs(loadedAt).from(now) : ''}</Text>
          )}
          {!loading && (
            <Group gap="xs">
              {loadError === expiredMessage && reconnect}
              <UnstyledButton onClick={() => void load()} c="var(--mantine-color-anchor)" fz="sm">{loadError ? 'Retry' : 'Refresh'}</UnstyledButton>
            </Group>
          )}
        </Group>
      </Paper>

      <Tabs defaultValue="people" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="people">People ({matchedCount} of {persons.length} matched)</Tabs.Tab>
          <Tabs.Tab value="contracts">Contracts ({contractCount} of {contracts.length})</Tabs.Tab>
          <Tabs.Tab value="clins">CLINs ({clinCount} of {clins.length})</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="people">
          <PeopleTab
            rows={personRows}
            employees={employees}
            vendors={vendors}
            listsOk={{ employee: employeesOk, vendor: vendorsOk }}
            suggestions={suggestions}
            listError={listError(lists?.employees) ?? listError(lists?.vendors)}
            onRetry={() => void load()}
            busyRows={busyRows}
            readOnly={!canWrite}
            onChoose={choosePerson}
            matchingByEmail={matchingByEmail}
            onMatchByEmail={matchByEmail}
          />
        </Tabs.Panel>

        <Tabs.Panel value="contracts">
          {listError(lists?.customers) && <Notice action={{ label: 'Retry', onClick: () => void load() }}>{listError(lists?.customers)}</Notice>}
          <EntityTable
            heading="Contract"
            rows={contracts.map((c) => ({ id: c.id, name: c.name, detail: c.contractNumber }))}
            entityType="contract"
            options={listData(lists?.customers).map((c) => ({ value: c.id, label: c.name }))}
            listOk={!!lists?.customers.ok}
            mappings={mappings}
            busyRows={busyRows}
            unavailable={loading || !canWrite}
            placeholder="Choose a QuickBooks customer"
            onSave={saveEntity}
            onClear={clearEntity}
          />
        </Tabs.Panel>

        <Tabs.Panel value="clins">
          {listError(lists?.items) && <Notice action={{ label: 'Retry', onClick: () => void load() }}>{listError(lists?.items)}</Notice>}
          <EntityTable
            heading="CLIN"
            rows={clins.map((c) => ({ id: c.id, name: c.clinNumber, detail: c.description ?? '' }))}
            entityType="clin"
            options={listData(lists?.items).map((i) => ({ value: i.id, label: i.name }))}
            listOk={!!lists?.items.ok}
            mappings={mappings}
            busyRows={busyRows}
            unavailable={loading || !canWrite}
            placeholder="Choose a QuickBooks service item"
            onSave={saveEntity}
            onClear={clearEntity}
          />
        </Tabs.Panel>

        <Tabs.Panel value="history">
          <HistoryTab logs={syncLogs} now={now} timeZone={workspaceTimezone} />
        </Tabs.Panel>
      </Tabs>

      {sendOpen && (
        <SendHoursModal
          connectionId={connection.id}
          periods={periods}
          anyoneMatched={matchedCount > 0}
          timeZone={workspaceTimezone}
          onClose={() => setSendOpen(false)}
          onSent={() => router.refresh()}
        />
      )}

      <ConfirmModal
        opened={disconnectOpen}
        title="Disconnect QuickBooks Online?"
        message="This removes the stored sign-in for QuickBooks. Matches and send history are kept, and reconnecting the same company brings them back."
        confirmLabel="Disconnect"
        loading={disconnecting}
        error={disconnectError}
        onConfirm={disconnect}
        onCancel={() => setDisconnectOpen(false)}
      />
    </Container>
  );
}

// ── People tab ──────────────────────────────────────────────────────────────────────────────────────────────────

type PersonRow = { id: string; fullName: string; email: string; employee?: ConfigMapping; vendor?: ConfigMapping };
type Show = 'unmatchedFirst' | 'unmatchedOnly' | 'all';

function PeopleTab({ rows, employees, vendors, listsOk, suggestions, listError, onRetry, busyRows, readOnly, onChoose, matchingByEmail, onMatchByEmail }: {
  rows: PersonRow[];
  employees: ProviderPerson[];
  vendors: ProviderPerson[];
  listsOk: Record<PersonMatchType, boolean>;
  suggestions: Map<string, EmailSuggestion>;
  listError: string | null;
  onRetry: () => void;
  busyRows: ReadonlySet<string>;
  readOnly: boolean;
  onChoose: (userId: string, name: string, match: { type: PersonMatchType; externalId: string; externalName: string } | null) => void;
  matchingByEmail: boolean;
  onMatchByEmail: () => void;
}) {
  const [show, setShow] = useState<Show>('unmatchedFirst');
  const isMatched = (r: PersonRow) => !!(r.employee || r.vendor);
  const shown = show === 'unmatchedOnly'
    ? rows.filter((r) => !isMatched(r))
    : show === 'unmatchedFirst'
      ? [...rows.filter((r) => !isMatched(r)), ...rows.filter(isMatched)]
      : rows;

  return (
    <Stack gap="sm">
      {listError && <Notice action={{ label: 'Retry', onClick: onRetry }}>{listError}</Notice>}
      <Select
        label="Show"
        data={[
          { value: 'unmatchedFirst', label: 'Not matched first' },
          { value: 'unmatchedOnly', label: 'Not matched only' },
          { value: 'all', label: 'All' },
        ]}
        value={show}
        onChange={(v) => v && setShow(v as Show)}
        allowDeselect={false}
        w={220}
        size="xs"
      />
      <Paper withBorder radius="md">
        <Table.ScrollContainer minWidth={640}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Person</Table.Th>
                <Table.Th>QuickBooks match</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.length === 0 ? (
                <Table.Tr><Table.Td colSpan={3}><Text c="dimmed" ta="center" py="md" size="sm">Everyone is matched.</Text></Table.Td></Table.Tr>
              ) : shown.map((r) => {
                const current = r.employee ?? r.vendor;
                const value = current ? `${current.entityType}:${current.externalEntityId}` : NONE;
                const withMissing = (type: PersonMatchType, list: ProviderPerson[]) => {
                  const own = r[type];
                  const items = list.map((p) => ({ value: `${type}:${p.id}`, label: `${p.name} · ${type === 'employee' ? 'Employee' : 'Vendor'}` }));
                  if (own && !list.some((p) => p.id === own.externalEntityId)) {
                    // F2: "not found" only against a loaded list; otherwise the saved name.
                    const kind = type === 'employee' ? 'Employee' : 'Vendor';
                    items.unshift({ value: `${type}:${own.externalEntityId}`, label: `${own.externalEntityName ?? own.externalEntityId}${listsOk[type] ? ' (not found in QuickBooks)' : ` · ${kind}`}` });
                  }
                  return items;
                };
                const groups = [
                  { group: 'Employees (W-2)', items: withMissing('employee', employees) },
                  { group: 'Vendors (1099)', items: withMissing('vendor', vendors) },
                ].filter((g) => g.items.length > 0);
                const data = [{ value: NONE, label: 'Not matched' }, ...groups];
                const nameOf = (v: string) => {
                  for (const g of groups) { const hit = g.items.find((i) => i.value === v); if (hit) return hit.label.replace(/ · (Employee|Vendor)$/, ''); }
                  return v;
                };
                const busy = busyRows.has(`person:${r.id}`) || readOnly;
                const suggestion = !current ? suggestions.get(r.id) : undefined;
                return (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>{r.fullName}</Text>
                      <Text size="xs" c="dimmed">{r.email}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        aria-label={`QuickBooks match for ${r.fullName}`}
                        data={data}
                        value={value}
                        onChange={(raw) => {
                          const v = raw == null ? null : String(raw);
                          if (busy || !v || v === value) return;
                          if (v === NONE) return onChoose(r.id, r.fullName, null);
                          const [type, ...rest] = v.split(':');
                          const externalId = rest.join(':');
                          onChoose(r.id, r.fullName, { type: type as PersonMatchType, externalId, externalName: nameOf(v) });
                        }}
                        allowDeselect={false}
                        searchable
                        readOnly={busy}
                        aria-disabled={busy || undefined}
                        data-disabled={busy || undefined}
                        size="xs"
                        miw={280}
                      />
                      {suggestion && (
                        <Text size="xs" c="var(--mantine-color-anchor)" mt={4}>Suggested: {suggestion.externalName} (same email)</Text>
                      )}
                      {r.employee && r.vendor && (
                        <Text size="xs" c="var(--mantine-color-warning-text, var(--mantine-color-orange-8))" mt={4} role="note">
                          Also matched to vendor {r.vendor.externalEntityName ?? r.vendor.externalEntityId}. Choose one.{' '}
                          <UnstyledButton
                            fz="xs"
                            c="var(--mantine-color-anchor)"
                            onClick={() => !busy && onChoose(r.id, r.fullName, { type: 'employee', externalId: r.employee!.externalEntityId, externalName: r.employee!.externalEntityName ?? r.employee!.externalEntityId })}
                          >
                            Keep the employee match
                          </UnstyledButton>
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{current ? <StatusBadge word="Matched" tone="ok" /> : <StatusBadge word="Not matched" tone="warn" />}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {suggestions.size > 0 && (
        <Group gap="sm">
          <WriteButton size="xs" variant="default" onClick={onMatchByEmail} loading={matchingByEmail}>
            Match {people(suggestions.size)} by email
          </WriteButton>
          <Text size="xs" c="dimmed">Only fills people who aren’t matched yet.</Text>
        </Group>
      )}
    </Stack>
  );
}

// ── Contracts / CLINs ───────────────────────────────────────────────────────────────────────────────────────────

function EntityTable({ heading, rows, entityType, options, listOk, mappings, busyRows, unavailable, placeholder, onSave, onClear }: {
  heading: string;
  rows: Array<{ id: string; name: string; detail: string }>;
  entityType: 'contract' | 'clin';
  options: Array<{ value: string; label: string }>;
  listOk: boolean;
  mappings: ConfigMapping[];
  busyRows: ReadonlySet<string>;
  unavailable: boolean;
  placeholder: string;
  onSave: (entityType: 'contract' | 'clin', bytimeId: string, bytimeName: string, externalId: string, externalName: string) => void;
  onClear: (entityType: 'contract' | 'clin', bytimeId: string) => void;
}) {
  const mappingOf = (id: string) => mappings.find((m) => m.entityType === entityType && m.bytimeEntityId === id);
  const ordered = [...rows.filter((r) => !mappingOf(r.id)), ...rows.filter((r) => mappingOf(r.id))];
  return (
    <Paper withBorder radius="md">
      <Table.ScrollContainer minWidth={560}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{heading}</Table.Th>
              <Table.Th>QuickBooks match</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {ordered.length === 0 ? (
              <Table.Tr><Table.Td colSpan={3}><Text c="dimmed" ta="center" py="md" size="sm">Nothing to match yet.</Text></Table.Td></Table.Tr>
            ) : ordered.map((r) => {
              const mapping = mappingOf(r.id);
              return (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{r.name}</Text>
                    {r.detail && <Text size="xs" c="dimmed">{r.detail}</Text>}
                  </Table.Td>
                  <Table.Td>
                    <MappingSelect
                      name={r.name}
                      mapping={mapping}
                      options={options}
                      listOk={listOk}
                      busy={unavailable || busyRows.has(`${entityType}:${r.id}`)}
                      placeholder={placeholder}
                      onSelect={(value, label) => onSave(entityType, r.id, r.name, value, label)}
                      onClear={() => onClear(entityType, r.id)}
                    />
                  </Table.Td>
                  <Table.Td>{mapping ? <StatusBadge word="Matched" tone="ok" /> : <StatusBadge word="Not matched" tone="warn" />}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

// ── History (I7, §6) ────────────────────────────────────────────────────────────────────────────────────────────

function HistoryTab({ logs, now, timeZone }: { logs: SyncLog[]; now: number; timeZone: string }) {
  const [drawerLog, setDrawerLog] = useState<SyncLog | null>(null);
  const [failures, setFailures] = useState<Array<{ id: string; label: string; error: string | null }> | null>(null);
  const [failuresError, setFailuresError] = useState<string | null>(null);
  async function openFailures(log: SyncLog) {
    setDrawerLog(log);
    setFailures(null);
    setFailuresError(null);
    try {
      setFailures(await getSyncFailures(log.id));
    } catch {
      setFailuresError('Couldn’t load the failures. Try again.');
    }
  }

  return (
    <>
      <Paper withBorder radius="md">
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Hours from</Table.Th>
                <Table.Th>How</Table.Th>
                <Table.Th ta="right">Sent</Table.Th>
                <Table.Th ta="right">Failed</Table.Th>
                <Table.Th ta="right">Skipped</Table.Th>
                <Table.Th>Result</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.length === 0 ? (
                <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py="md" size="sm">Nothing sent yet.</Text></Table.Td></Table.Tr>
              ) : logs.map((log) => {
                const result = syncResultText(log, now);
                const see = seeFailuresLabel(log.failedRecords);
                return (
                  <Table.Tr key={log.id}>
                    <Table.Td>{formatInstant(new Date(log.createdAt), timeZone, 'MMM D, h:mm A')}</Table.Td>
                    <Table.Td>{log.periodStart && log.periodEnd ? periodLabel(log.periodStart, log.periodEnd) : '—'}</Table.Td>
                    <Table.Td>{HOW[log.triggerType] ?? log.triggerType}</Table.Td>
                    <Table.Td ta="right">{log.recordsPushed}</Table.Td>
                    <Table.Td ta="right">{log.recordsFailed}</Table.Td>
                    <Table.Td ta="right">{log.recordsSkipped}</Table.Td>
                    <Table.Td>
                      <span data-testid="sync-result"><StatusBadge word={result.head} tone={result.tone} />{result.rest && <Text span size="sm">{result.rest}</Text>}</span>
                      {see && <Button size="compact-xs" variant="subtle" ml="xs" onClick={() => void openFailures(log)}>{see}</Button>}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      <Drawer opened={drawerLog !== null} onClose={() => setDrawerLog(null)} position="right" title="Entries that failed" size="md">
        {failuresError ? <Alert color="red" role="alert">{failuresError}</Alert>
          : failures === null ? <Group gap="xs" aria-busy="true"><Loader size="xs" aria-hidden="true" /><Text size="sm">Loading…</Text></Group>
            : (
              <Stack gap="sm">
                {failures.map((f) => (
                  <div key={f.id}>
                    <Text size="sm" fw={500}>{f.label}</Text>
                    {f.error && <Text size="xs" c="dimmed">{f.error}</Text>}
                  </div>
                ))}
              </Stack>
            )}
      </Drawer>
    </>
  );
}

// ── Send hours (I6) ─────────────────────────────────────────────────────────────────────────────────────────────

function SendHoursModal({ connectionId, periods, anyoneMatched, timeZone, onClose, onSent }: {
  connectionId: string;
  periods: SendPeriodOption[];
  anyoneMatched: boolean;
  timeZone: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [start, setStart] = useState<CalendarDate>(periods[0]?.start);
  // The preview (or its error) of the period it was read for; a stale one reads as "checking".
  const [checked, setChecked] = useState<{ start: CalendarDate; preview: SendPreview | null; error: string | null } | null>(null);
  const preview = checked?.start === start ? checked.preview : null;
  const previewError = checked?.start === start ? checked.error : null;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSendPreview(connectionId, start)
      .then((p) => { if (live) setChecked({ start, preview: p, error: null }); })
      .catch(() => { if (live) setChecked({ start, preview: null, error: 'Couldn’t check this pay period. You can still send it.' }); });
    return () => { live = false; };
  }, [connectionId, start]);

  const day = (d: Date) => formatInstant(new Date(d), timeZone, 'MMM D, YYYY');

  async function send() {
    if (sending || !anyoneMatched) return;
    setSending(true);
    setError(null);
    const outcome = await runAction(triggerQBOSync({ connectionId, periodStart: start }), { silent: true });
    setSending(false);
    onSent(); // a failed send still leaves a log to show
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    const r = outcome.data.result;
    const status = r.failed === 0 ? 'success' : r.pushed > 0 ? 'partial' : 'failed';
    const text = syncResultText({ status, recordsPushed: r.pushed, recordsSkipped: r.skipped, errorSummary: null, startedAt: null, createdAt: new Date() }, Date.now());
    notifications.show({
      title: 'Send finished',
      message: `${text.head}${text.rest}${r.failed > 0 ? ` · ${plural(r.failed, 'entry', 'entries')} failed` : ''}`,
      color: r.failed > 0 || r.pushed === 0 ? 'warning' : 'success',
    });
    onClose();
  }

  return (
    <Modal opened onClose={() => !sending && onClose()} title="Send hours to QuickBooks" closeOnEscape={!sending} closeOnClickOutside={!sending}>
      <Stack gap="sm">
        <Select
          label="Approved hours from"
          data={periods.map((p) => ({ value: p.start, label: p.label }))}
          value={start}
          onChange={(v) => v && setStart(v as CalendarDate)}
          allowDeselect={false}
        />
        {!anyoneMatched && <Notice>Match at least one person first.</Notice>}
        {previewError && <Text size="sm" c="dimmed">{previewError}</Text>}
        {!preview && !previewError && <Group gap="xs" aria-busy="true"><Loader size="xs" aria-hidden="true" /><Text size="sm">Checking this pay period…</Text></Group>}
        {preview && (
          <>
            {preview.sentAt && (
              <Notice>Already sent on {day(preview.sentAt)}. Sending again creates duplicate time entries in QuickBooks.</Notice>
            )}
            {preview.partlySentAt && <Notice>This period may have been partly sent on {day(preview.partlySentAt)}.</Notice>}
            {preview.unmatchedPeople > 0 && (
              <Notice>{preview.unmatchedPeople === 1 ? '1 person isn’t' : `${preview.unmatchedPeople} people aren’t`} matched, so their hours will be skipped.</Notice>
            )}
            {preview.notApprovedPeople > 0 && (
              <Notice tone="info">
                {preview.notApprovedPeople === 1 ? '1 person isn’t' : `${preview.notApprovedPeople} people aren’t`} approved yet. Their hours won’t be sent, and sending this period again later resends everyone.
              </Notice>
            )}
          </>
        )}
        {error && <Alert color="red" role="alert">{error}</Alert>}
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={() => !sending && onClose()} aria-disabled={sending || undefined}>Cancel</Button>
          <WriteButton
            onClick={send}
            aria-disabled={sending || !anyoneMatched || undefined}
            data-disabled={sending || !anyoneMatched || undefined}
            leftSection={sending ? <Loader size="xs" aria-hidden="true" /> : undefined}
          >
            Send hours
          </WriteButton>
        </Group>
      </Stack>
    </Modal>
  );
}
