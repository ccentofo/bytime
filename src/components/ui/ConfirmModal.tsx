'use client';

import { Modal, Text, Group, Button } from '@mantine/core';
import type { ReactNode } from 'react';

type Props = {
  opened: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  /** `danger` (default): red confirm button. `neutral`: the primary color — e.g. Reactivate, FLSA status. */
  tone?: 'danger' | 'neutral';
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Shared confirmation — replaces the browser's native confirm dialog everywhere. The confirm button is disabled while
 * `loading` (no double submit); callers close it only on success (feature-plan-ux-foundations.md §4.5).
 */
export function ConfirmModal({
  opened,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  tone = 'danger',
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal opened={opened} onClose={onCancel} title={title}>
      <Text size="sm" mb="lg">{message}</Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button color={tone === 'danger' ? 'red' : undefined} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
