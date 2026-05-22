'use client';

import { useState } from 'react';
import { Modal, Button, Group, Stack, Text, Textarea, Alert, Checkbox } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

type Props = {
  opened: boolean;
  onClose: () => void;
  onConfirm: (comment?: string) => Promise<void>;
  isSaving: boolean;
  periodLabel: string;
};

export function SubmitModal({ opened, onClose, onConfirm, isSaving, periodLabel }: Props) {
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
    if (!certified) return;
    await onConfirm(comment.trim() || undefined);
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
        <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
          <Text size="sm" fw={600}>
            You are submitting your timesheet for {periodLabel}.
          </Text>
          <Text size="sm" mt={4}>
            By submitting, you certify that all hours for this pay period have been recorded daily as required by DCAA regulations.
            Once submitted, you will not be able to edit this timesheet unless your supervisor returns it for corrections.
          </Text>
        </Alert>

        <Textarea
          label="Comments (optional)"
          placeholder="Any notes for your supervisor..."
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />

        <Checkbox
          label="I certify that the hours recorded on this timesheet are a true and accurate representation of the time I worked during this pay period."
          checked={certified}
          onChange={(e) => setCertified(e.currentTarget.checked)}
          styles={{ label: { fontWeight: 600 } }}
        />

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!certified}
            loading={isSaving}
            color="green"
          >
            Submit Timesheet
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
