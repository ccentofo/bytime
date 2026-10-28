'use client';

import { useState } from 'react';
import { Modal, Button, Group, Loader, Stack, Text, Textarea, Alert, Checkbox, Paper } from '@mantine/core';
import { Icons } from '@/components/ui/icons';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (comment?: string) => Promise<void>;
  isSaving: boolean;
  periodLabel: string;
  flsaExempt?: boolean;
  totalPeriodHours?: number;
  uncompensatedHours?: number;
  completenessWarnings?: string[];
};

export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel, flsaExempt, totalPeriodHours, uncompensatedHours, completenessWarnings }: Props) {
  const [certified, setCertified] = useState(false);
  const [comment, setComment] = useState('');

  function handleClose() {
    if (!isSaving) {
      setCertified(false);
      setComment('');
      onClose();
    }
  }

  async function handleSubmit() {
    if (!certified || isSaving) return;

    // Append completeness warnings to the comment for audit trail
    let fullComment = comment.trim();
    if (completenessWarnings && completenessWarnings.length > 0) {
      const warningText = `[COMPLETENESS WARNINGS: ${completenessWarnings.join('; ')}]`;
      fullComment = fullComment ? `${fullComment}\n${warningText}` : warningText;
    }

    await onConfirm(fullComment || undefined);
    setCertified(false);
    setComment('');
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Submit Timesheet for Approval"
      size="md"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!isSaving}
    >
      <Stack>
        <Alert icon={<Icons.statusWarning size={16} />} color="warning" variant="light">
          <Text size="sm" fw={600}>
            You are submitting your timesheet for {periodLabel}.
          </Text>
          <Text size="sm" mt={4}>
            By submitting, you certify that all hours for this pay period have been recorded daily as required by DCAA regulations.
            Once submitted, you will not be able to edit this timesheet unless your supervisor returns it for corrections.
          </Text>
        </Alert>

        {completenessWarnings && completenessWarnings.length > 0 && (
          <Alert icon={<Icons.statusWarning size={16} />} color="warning" variant="light">
            <Text size="sm" fw={600} mb={4}>
              Period Completeness Warnings ({completenessWarnings.length}):
            </Text>
            <Stack gap={2}>
              {completenessWarnings.map((warning, idx) => (
                <Text key={idx} size="sm">• {warning}</Text>
              ))}
            </Stack>
            <Text size="sm" c="dimmed" mt={8}>
              These warnings are recorded in the audit trail. You may still submit if the gaps are intentional.
            </Text>
          </Alert>
        )}

        {flsaExempt && (
          <Paper withBorder p="sm" radius="sm">
            <Text size="sm" fw={600} mb={4}>FLSA Exempt — Total Time Accounting:</Text>
            <Text size="sm">Total Hours Recorded: <strong>{(totalPeriodHours ?? 0).toFixed(2)}</strong></Text>
            {(uncompensatedHours ?? 0) > 0 && (
              <Text size="sm">Uncompensated Overtime: <strong>{(uncompensatedHours ?? 0).toFixed(2)} hours</strong></Text>
            )}
            <Text size="sm" c="dimmed" mt={4}>
              As an FLSA-exempt employee, you are required to record all hours actually worked,
              including any uncompensated overtime, per DCAA total time accounting requirements.
            </Text>
          </Paper>
        )}

        <Textarea
          label="Comments (optional)"
          placeholder="Any notes for your supervisor..."
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />

        <Checkbox
          label={flsaExempt
            ? "I certify that the hours recorded on this timesheet represent ALL time actually worked during this pay period, including any uncompensated overtime, as required by DCAA total time accounting standards."
            : "I certify that the hours recorded on this timesheet are a true and accurate representation of the time I worked during this pay period."
          }
          checked={certified}
          onChange={(e) => setCertified(e.currentTarget.checked)}
          styles={{ label: { fontWeight: 600 } }}
        />

        <Group justify="flex-end" mt="md">
          {/* aria-disabled plus the handlers' guards, never `disabled` or `loading` (focus would drop, M2). */}
          <Button variant="default" onClick={handleClose} aria-disabled={isSaving || undefined} data-disabled={isSaving || undefined}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            aria-disabled={!certified || isSaving || undefined}
            data-disabled={!certified || isSaving || undefined}
            leftSection={isSaving ? <Loader size={16} aria-hidden="true" /> : undefined}
            color="success"
          >
            {isSaving ? 'Submitting…' : 'Submit Timesheet'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
