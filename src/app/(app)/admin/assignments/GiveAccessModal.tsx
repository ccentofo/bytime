'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { WriteButton } from '@/components/shell/WorkspaceMode';
import { useBusy } from '@/components/ui/useBusy';
import { runAction } from '@/lib/run-action';
import { toastSuccess } from '@/lib/toast';
import { formatCount } from '@/lib/format';
import { assignChargeCodesToUser } from '@/server/actions/charge-codes';
import classes from './Assignments.module.css';

export const CHOOSE_PERSON = 'Choose a person.';
export const CHOOSE_CODES = 'Choose at least one charge code.';

export type AccessPerson = { id: string; fullName: string; role: 'admin' | 'supervisor' | 'employee'; isActive: boolean };
export type AccessCode = {
  id: string; code: string; name: string; clinId: string; clinNumber: string; clinDescription?: string | null;
  contractName: string; workLocation: 'onsite' | 'telework' | 'other' | null; chargeable?: boolean;
};

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

/**
 * "Give access to charge codes" (feature-plan-ux-people-codes.md §4.2): one person (active only), a checklist of
 * chargeable codes grouped by contract and CLIN (a CLIN box selects its selectable codes; indeterminate when partly),
 * codes already held shown checked and aria-disabled. A charge code never gives approval authority
 * (feature-plan-approval-scope.md S1, S8): approval scope is granted only on Assignments → Approval scope.
 */
export function GiveAccessModal({ opened, onClose, onGiven, people, codes, heldBy, initialPersonId }: {
  opened: boolean;
  onClose: () => void;
  /** After a successful save (the caller refetches). */
  onGiven: () => void | Promise<void>;
  people: AccessPerson[];
  /** Every code; only chargeable ones are offered. */
  codes: AccessCode[];
  /** personId → the code ids they actively hold. */
  heldBy: Map<string, Set<string>>;
  initialPersonId: string | null;
}) {
  const busy = useBusy();
  const [personId, setPersonId] = useState<string | null>(initialPersonId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<{ person?: string; codes?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const person = people.find((p) => p.id === personId) ?? null;
  const held = (personId && heldBy.get(personId)) || new Set<string>();
  const groups = useMemo(() => {
    const byClin = new Map<string, { clinId: string; label: string; codes: AccessCode[] }>();
    for (const c of codes) {
      if (!c.chargeable) continue;
      const g = byClin.get(c.clinId) ?? { clinId: c.clinId, label: `${c.contractName} · CLIN ${c.clinNumber}${c.clinDescription ? ` ${c.clinDescription}` : ''}`, codes: [] };
      g.codes.push(c);
      byClin.set(c.clinId, g);
    }
    return [...byClin.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      .map((g) => ({ ...g, codes: g.codes.sort((a, b) => a.code.localeCompare(b.code)) }));
  }, [codes]);

  const choosePerson = (id: string | null) => {
    setPersonId(id);
    setPicked(new Set());
    setErrors({});
    setServerError(null);
  };
  const toggleCode = (id: string) => {
    if (held.has(id)) return;
    setErrors((e) => ({ ...e, codes: undefined }));
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const toggleClin = (g: (typeof groups)[number]) => {
    const selectable = g.codes.filter((c) => !held.has(c.id)).map((c) => c.id);
    if (selectable.length === 0) return;
    const all = selectable.every((id) => picked.has(id));
    setErrors((e) => ({ ...e, codes: undefined }));
    setPicked((prev) => { const next = new Set(prev); for (const id of selectable) { if (all) next.delete(id); else next.add(id); } return next; });
  };

  async function save() {
    const next: typeof errors = {};
    if (!personId) next.person = CHOOSE_PERSON;
    if (picked.size === 0) next.codes = CHOOSE_CODES;
    setErrors(next);
    setServerError(null);
    if (next.person || next.codes || !personId || !person) return;
    await busy.run('give', async () => {
      const result = await runAction(assignChargeCodesToUser({ userId: personId, chargeCodeIds: [...picked] }), { silent: true });
      if (!result.ok) { setServerError(result.error); return; } // the selection is kept
      toastSuccess({ title: 'Access given', message: `${person.fullName} can now charge ${plural(result.data.assigned, 'more code', 'more codes')}` });
      onClose();
      await onGiven();
    });
  }

  const n = picked.size;
  return (
    <Modal opened={opened} onClose={() => { if (!busy.any()) onClose(); }} title="Give access to charge codes" size="lg">
      <Stack gap="md">
        {serverError && <Alert color="red" role="alert" data-testid="give-access-error">{serverError}</Alert>}
        <Select
          label="Person" required searchable placeholder="Choose a person"
          description="Active people only."
          data={people.filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.fullName }))}
          value={personId} onChange={choosePerson} error={errors.person}
        />
        <div>
          <Text size="sm" fw={500} mb={4} id="give-access-codes">Charge codes <Text span c="red" aria-hidden="true">*</Text></Text>
          <div className={classes.pick} role="group" aria-labelledby="give-access-codes" data-testid="give-access-codes">
            {groups.length === 0 && <Text size="sm" c="dimmed">No charge codes can be charged right now.</Text>}
            {groups.map((g) => {
              const selectable = g.codes.filter((c) => !held.has(c.id));
              const chosen = selectable.filter((c) => picked.has(c.id)).length;
              return (
                <div key={g.clinId}>
                  <Checkbox
                    className={classes.pickGroup}
                    label={g.label}
                    aria-label={`All of ${g.label}`}
                    checked={selectable.length > 0 && chosen === selectable.length}
                    indeterminate={chosen > 0 && chosen < selectable.length}
                    aria-disabled={selectable.length === 0 || undefined}
                    onChange={() => toggleClin(g)}
                  />
                  {g.codes.map((c) => {
                    const had = held.has(c.id);
                    return (
                      <Checkbox
                        key={c.id}
                        className={classes.pickCode}
                        mt={4}
                        aria-label={had ? `${c.code}, already has access` : c.code}
                        checked={had || picked.has(c.id)}
                        aria-disabled={had || undefined}
                        onChange={() => toggleCode(c.id)}
                        label={<><span className={classes.mono}>{c.code}</span> — {c.name}{had && <span className={classes.dim}> · already has access</span>}</>}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {errors.codes && <Text size="xs" c="red" mt={4} role="alert">{errors.codes}</Text>}
        </div>
        <Group justify="flex-end" gap="sm">
          <Text size="sm" c="dimmed" mr="auto" data-testid="give-access-count">{plural(n, 'code', 'codes')} selected</Text>
          <Button variant="default" onClick={() => { if (!busy.any()) onClose(); }}>Cancel</Button>
          <WriteButton {...busy.props('give')} onClick={() => { void save(); }}>Give access to {plural(n, 'code', 'codes')}</WriteButton>
        </Group>
      </Stack>
    </Modal>
  );
}
