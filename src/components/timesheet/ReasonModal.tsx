'use client';

import { useState, useEffect } from 'react';
import { Modal, Select, Textarea, Button, Group, Stack, Text, Table, Badge } from '@mantine/core';
import dayjs from 'dayjs';
import { REASON_CODES } from '@/lib/reason-codes';
import type { DirtyCell, ChargeCode } from '@/types/timesheet';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (reasonCode: string, comment: string) => Promise<void>;
  editedCells: DirtyCell[];
  lateEntryCells: DirtyCell[];
  chargeCodes: ChargeCode[];
  periodStart: Date;
  isSaving: boolean;
};

export function ReasonModal({
  opened,
  onClose,
  onConfirm,
  editedCells,
  lateEntryCells,
  chargeCodes,
  periodStart,
  isSaving,
}: Props) {
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const hasEdits = editedCells.length > 0;
  const hasLateEntries = lateEntryCells.length > 0;
  const onlyLateEntries = hasLateEntries && !hasEdits;

  // Auto-select LATE_ENTRY when only late entries are present
  useEffect(() => {
    if (opened && onlyLateEntries) {
      setReasonCode('LATE_ENTRY');
    }
  }, [opened, onlyLateEntries]);

  const canSubmit = reasonCode !== null && comment.trim().length > 0;

  // Dynamic title based on what types of cells are in the batch
  let modalTitle = 'DCAA Compliance — Reason Required';
  if (onlyLateEntries) {
    modalTitle = 'DCAA Compliance — Late Entry Reason';
  } else if (hasEdits && !hasLateEntries) {
    modalTitle = 'DCAA Compliance — Reason for Edit';
  } else if (hasEdits && hasLateEntries) {
    modalTitle = 'DCAA Compliance — Reason for Changes';
  }

  // Dynamic description
  let description = 'Per DCAA requirements, you must provide a reason for these changes. The reason will be recorded in the audit trail.';
  if (onlyLateEntries) {
    description = 'You are entering time for dates that have already passed. Per DCAA daily time entry requirements (FAR 31.201-1), late entries must be documented with a reason code.';
  } else if (hasEdits && hasLateEntries) {
    description = 'This save includes edits to previously-saved data and late entries for past dates. Per DCAA requirements, you must provide a reason. The reason will be recorded in the audit trail.';
  }

  function handleClose() {
    if (!isSaving) {
      setReasonCode(null);
      setComment('');
      onClose();
    }
  }

  async function handleConfirm() {
    if (!canSubmit) return;
    await onConfirm(reasonCode!, comment.trim());
    setReasonCode(null);
    setComment('');
  }

  function renderCellTable(cells: DirtyCell[], label: string, badgeColor: string) {
    if (cells.length === 0) return null;
    return (
      <>
        <Text fw={600} size="sm">{label}:</Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Charge Code</Table.Th>
              <Table.Th>Date</Table.Th>
              <Table.Th>New Hours</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {cells.map((cell, idx) => {
              const cc = chargeCodes.find((c) => c.id === cell.chargeCodeId);
              const date = dayjs(periodStart).add(cell.dayIndex, 'day');
              return (
                <Table.Tr key={idx}>
                  <Table.Td>{cc?.clin ?? cell.chargeCodeId} — {cc?.projectName ?? ''}</Table.Td>
                  <Table.Td>{date.format('MMM D, YYYY')}</Table.Td>
                  <Table.Td>
                    <Badge color={badgeColor} variant="light">{cell.hours.toFixed(2)}</Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </>
    );
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={modalTitle}
      size="lg"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!isSaving}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {description}
        </Text>

        {/* Late entry cells (orange badges) */}
        {renderCellTable(lateEntryCells, 'Late Entries (past dates)', 'orange')}

        {/* Edited cells (yellow badges) */}
        {renderCellTable(editedCells, 'Edited Entries (corrections)', 'yellow')}

        <Select
          label="Reason for Change"
          placeholder="Select a reason code..."
          data={REASON_CODES}
          value={reasonCode}
          onChange={setReasonCode}
          required
          withAsterisk
        />

        <Textarea
          label="Comments"
          placeholder={onlyLateEntries
            ? 'Explain why time was not entered on the day work was performed...'
            : 'Describe the reason for this correction...'
          }
          minRows={3}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          required
          withAsterisk
        />

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canSubmit}
            loading={isSaving}
            color="blue"
          >
            Confirm Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
