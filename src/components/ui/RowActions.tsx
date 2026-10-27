'use client';

import { useId } from 'react';
import { ActionIcon, Button, Group, Loader, Menu, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { READ_ONLY_TOOLTIP, useCanWrite } from '@/components/shell/WorkspaceMode';
import { Icons, ICON_SIZE } from './icons';
import classes from './RowActions.module.css';

/**
 * One row-action pattern for every table (feature-plan-ux-foundations.md §4.4; UX-AUDIT V8, §4.1, B2): an optional
 * visible primary button plus a "More actions" menu. Danger items always sit last, behind a divider. Unavailable
 * actions are `aria-disabled` (never `disabled`) so keyboard and screen-reader users still reach them and hear why.
 * Visibility only — the server write gate is the real control.
 */
export type RowAction = {
  key: string;
  label: string;              // sentence case, verb first: "Edit", "Change labor category", "Deactivate…"
  icon: keyof typeof Icons;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  writes?: boolean;           // default true: disabled when the workspace is read-only
  disabledReason?: string;    // e.g. "You can't deactivate your own account"
  hidden?: boolean;
  busy?: boolean;             // shows a loader and blocks clicks while this row's action runs
};

/** The danger menu-item class, for other menus that need danger text (sets --menu-item-color / --menu-item-hover). */
export const DANGER_MENU_ITEM_CLASS = classes.danger;

const READ_ONLY_REASON = 'Read-only workspace';
const noop = () => {};

function reasonFor(action: RowAction, canWrite: boolean): string | null {
  if (action.disabledReason) return action.disabledReason;
  if ((action.writes ?? true) && !canWrite) return READ_ONLY_REASON;
  return null;
}

/** A visible quiet button (the primary, or a lone action). Read-only → aria-disabled + tooltip + described-by text. */
function ActionButton({ action, canWrite, single }: { action: RowAction; canWrite: boolean; single: boolean }) {
  const describedById = useId();
  const Icon = Icons[action.icon];
  const danger = action.tone === 'danger';
  const reason = reasonFor(action, canWrite);
  const common = {
    variant: 'subtle' as const,
    size: 'compact-sm' as const,
    color: single && danger ? 'red' : undefined,
    leftSection: <Icon size={ICON_SIZE.button} />,
    loading: action.busy,
  };
  if (!reason) {
    return <Button {...common} onClick={action.busy ? noop : action.onSelect}>{action.label}</Button>;
  }
  if (action.disabledReason && single) {
    // Rule 3: a lone action disabled for a reason shows the reason as visible text beside it.
    return (
      <Group gap={6} wrap="nowrap">
        <Button {...common} aria-disabled="true" className={classes.blocked} onClick={noop}>{action.label}</Button>
        <Text size="xs" c="dimmed">{reason}</Text>
      </Group>
    );
  }
  // Rule 4b: read-only (or a reason on the primary) → tooltip for pointer users, described-by text for keyboard users.
  const tip = reason === READ_ONLY_REASON ? READ_ONLY_TOOLTIP : reason;
  return (
    <>
      <Tooltip label={tip}>
        <Button {...common} aria-disabled="true" aria-describedby={describedById} className={classes.blocked} onClick={noop}>
          {action.label}
        </Button>
      </Tooltip>
      <VisuallyHidden id={describedById}>{tip}</VisuallyHidden>
    </>
  );
}

export function RowActions({ rowLabel, primary, items }: { rowLabel: string; primary?: RowAction; items: RowAction[] }): React.ReactElement {
  const canWrite = useCanWrite();
  const visible = items.filter((i) => !i.hidden);
  const shownPrimary = primary && !primary.hidden ? primary : undefined;

  // Rule 3: no primary and exactly one visible item → a single labelled button, no menu.
  if (!shownPrimary && visible.length === 1) {
    return (
      <Group gap={4} wrap="nowrap" justify="flex-end">
        <ActionButton action={visible[0]} canWrite={canWrite} single />
      </Group>
    );
  }

  const regular = visible.filter((i) => i.tone !== 'danger');
  const danger = visible.filter((i) => i.tone === 'danger');
  const item = (action: RowAction) => {
    const Icon = Icons[action.icon];
    const reason = reasonFor(action, canWrite);
    const blocked = reason !== null || !!action.busy;
    const className = [action.tone === 'danger' ? classes.danger : '', blocked ? classes.blocked : ''].filter(Boolean).join(' ') || undefined;
    return (
      <Menu.Item
        key={action.key}
        leftSection={action.busy ? <Loader size={ICON_SIZE.menu} /> : <Icon size={ICON_SIZE.menu} />}
        className={className}
        aria-disabled={blocked ? 'true' : undefined}
        aria-busy={action.busy ? 'true' : undefined}
        closeMenuOnClick={!blocked}
        onClick={blocked ? noop : action.onSelect}
      >
        {action.label}
        {reason && <Text size="xs" c="dimmed">{reason}</Text>}
      </Menu.Item>
    );
  };

  return (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      {shownPrimary && <ActionButton action={shownPrimary} canWrite={canWrite} single={false} />}
      {visible.length > 0 && (
        <Menu position="bottom-end" withinPortal withInitialFocusPlaceholder={false}>
          <Menu.Target>
            <ActionIcon variant="subtle" aria-label={`More actions for ${rowLabel}`}>
              <Icons.moreActions size={ICON_SIZE.menu} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {regular.map(item)}
            {regular.length > 0 && danger.length > 0 && <Menu.Divider />}
            {danger.map(item)}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
