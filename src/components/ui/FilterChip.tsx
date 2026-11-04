'use client';

import { CloseButton } from '@mantine/core';
import styles from './FilterChip.module.css';

/**
 * A removable filter chip (UX-4B1-AUDIT M2): the filter in words and a ✕ named "Remove filter {label}". Removing it is
 * the caller's job (usually dropping a URL parameter).
 */
export function FilterChip({ label, onRemove, 'data-testid': testId }: { label: string; onRemove: () => void; 'data-testid'?: string }) {
  return (
    <span className={styles.chip} data-testid={testId}>
      {label}
      <CloseButton size="xs" aria-label={`Remove filter ${label}`} onClick={onRemove} />
    </span>
  );
}
