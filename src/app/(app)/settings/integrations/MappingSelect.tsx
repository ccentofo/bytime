'use client';

import { Select, Text } from '@mantine/core';

export interface MappingLike {
  id: string;
  externalEntityId: string;
  externalEntityName: string | null;
}

/**
 * One row's match in an integration's mapping table (feature-plan-ux-page-fixes.md C13), shared by QuickBooks and Gusto.
 * Before the provider's data is loaded, a mapped row shows its saved match and how to change it. After loading, a
 * saved match missing from the provider's list is kept as "(not found in …)". Clearing the Select removes the
 * mapping. While the row's save or delete is in flight, the Select is aria-disabled and ignores changes.
 */
export function MappingSelect({
  provider,
  name,
  mapping,
  options,
  loaded,
  busy,
  placeholder,
  emptyMessage,
  onSelect,
  onClear,
}: {
  provider: 'QuickBooks' | 'Gusto';
  /** The CadenzPoint entity's name. */
  name: string;
  mapping: MappingLike | undefined;
  options: Array<{ value: string; label: string }>;
  loaded: boolean;
  busy: boolean;
  placeholder: string;
  /** Shown for an unmapped row before the provider's data is loaded. */
  emptyMessage: string;
  onSelect: (externalId: string, label: string) => void;
  onClear: () => void;
}) {
  if (!loaded) {
    if (!mapping) return <Text size="xs" c="dimmed">{emptyMessage}</Text>;
    return (
      <>
        <Text size="sm">{mapping.externalEntityName ?? mapping.externalEntityId}</Text>
        <Text size="xs" c="dimmed">Load {provider} data to change</Text>
      </>
    );
  }
  const data = mapping && !options.some((o) => o.value === mapping.externalEntityId)
    ? [{ value: mapping.externalEntityId, label: `${mapping.externalEntityName ?? mapping.externalEntityId} (not found in ${provider})` }, ...options]
    : options;
  return (
    <Select
      aria-label={`${provider} match for ${name}`}
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
      clearButtonProps={{ 'aria-label': `Remove mapping for ${name}` }}
      readOnly={busy}
      aria-disabled={busy || undefined}
      data-disabled={busy || undefined}
      size="xs"
    />
  );
}
