'use client';

import { Modal, Text, Group, Button, Alert, Loader, getDefaultZIndex } from '@mantine/core';
import type { ReactNode } from 'react';

/** One above Mantine's default for modals and drawers (notifications stay above). */
const CONFIRM_Z_INDEX = getDefaultZIndex('modal') + 1;

type Props = {
  opened: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  /** `danger` (default): red confirm button. `neutral`: the primary color — e.g. Reactivate, FLSA status. */
  tone?: 'danger' | 'neutral';
  /**
   * The action's error, shown INSIDE the dialog above the buttons (feature-plan-ux-page-fixes.md §3): the action behind
   * a confirm reports its failure here, never as a toast as well.
   */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Shared confirmation — replaces the browser's native confirm dialog everywhere. While `loading` it can't be closed
 * (no Esc, overlay click or ✕: Mantine closes every open modal on a window-level Esc, so an error arriving after Esc
 * would never be seen) and both buttons are aria-disabled with a click guard — never `disabled` (focus would drop) and
 * never Mantine `loading` (it sets `disabled`). Callers close it only on success (feature-plan-ux-foundations.md §4.5).
 */
export function ConfirmModal({
  opened,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  tone = 'danger',
  error,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal
      opened={opened}
      onClose={() => { if (!loading) onCancel(); }}
      title={title}
      closeOnEscape={!loading}
      closeOnClickOutside={!loading}
      withCloseButton={!loading}
      // A confirm always sits above the Modal or Drawer that opened it. With the same default z-index, whichever
      // portal mounted later wins, so a confirm declared before its edit Modal rendered behind it.
      zIndex={CONFIRM_Z_INDEX}
    >
      <Text size="sm" mb="lg">{message}</Text>
      {error && <Alert role="alert" color="red" mb="sm">{error}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" onClick={() => { if (!loading) onCancel(); }} aria-disabled={loading || undefined} data-disabled={loading || undefined}>
          {cancelLabel}
        </Button>
        <Button
          color={tone === 'danger' ? 'red' : undefined}
          onClick={() => { if (!loading) onConfirm(); }}
          aria-disabled={loading || undefined}
          data-disabled={loading || undefined}
          leftSection={loading ? <Loader size={14} aria-hidden="true" /> : undefined}
        >
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
