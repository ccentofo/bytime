'use client';

import { Select } from '@mantine/core';

export interface MappingLike {
  id: string;
  externalEntityId: string;
  externalEntityName: string | null;
}

/**
 * One contract's or CLIN's QuickBooks match (feature-plan-ux-page-fixes.md C13; feature-plan-ux-integrations-billing.md
 * §3.2 — QuickBooks data loads on its own, so there's no "load first" mode). A saved match missing from a LOADED list
 * is kept as "(not found in QuickBooks)"; while the list loads or after it failed, the saved name shows as it is
 * (UX-4C2B-AUDIT.md F2). Clearing the Select removes the mapping. While the row's save or delete
 * is in flight, or the list isn't available, the Select is aria-disabled and ignores changes.
 */
export function MappingSelect({
  name,
  mapping,
  options,
  listOk,
  busy,
  placeholder,
  onSelect,
  onClear,
}: {
  /** The CadenzPoint entity's name. */
  name: string;
  mapping: MappingLike | undefined;
  options: Array<{ value: string; label: string }>;
  /** QuickBooks's list loaded (only then can a saved match be "not found"). */
  listOk: boolean;
  busy: boolean;
  placeholder: string;
  onSelect: (externalId: string, label: string) => void;
  onClear: () => void;
}) {
  const data = mapping && !options.some((o) => o.value === mapping.externalEntityId)
    ? [{ value: mapping.externalEntityId, label: `${mapping.externalEntityName ?? mapping.externalEntityId}${listOk ? ' (not found in QuickBooks)' : ''}` }, ...options]
    : options;
  return (
    <Select
      aria-label={`QuickBooks match for ${name}`}
      placeholder={placeholder}
      data={data}
      value={mapping?.externalEntityId ?? null}
      onChange={(value) => {
        if (busy) return;
        if (value) onSelect(value, data.find((o) => o.value === value)?.label ?? value);
        else if (mapping) onClear();
      }}
      searchable
      clearable
      allowDeselect={false}
      clearButtonProps={{ 'aria-label': `Remove match for ${name}` }}
      readOnly={busy}
      aria-disabled={busy || undefined}
      data-disabled={busy || undefined}
      size="xs"
    />
  );
}
