'use client';

import Link from 'next/link';
import { Anchor, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { Icons } from '@/components/ui/icons';
import styles from './Notice.module.css';

type NoticeAction = { label: string; href: string } | { label: string; onClick: () => void };

/**
 * A page-level notice (feature-plan-ux-kit-contracts.md §3.2): the message and one action, right-aligned. role="note"
 * (it informs; it isn't an alert). The icon is decorative.
 */
export function Notice({ tone = 'warn', action, children }: { tone?: 'warn' | 'info'; action?: NoticeAction; children: ReactNode }) {
  const Icon = tone === 'warn' ? Icons.statusWarning : Icons.statusInfo;
  return (
    <div className={styles.notice} data-tone={tone} role="note">
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <div className={styles.message}>{children}</div>
      {action && ('href' in action
        ? <Anchor component={Link} href={action.href} size="sm" className={styles.action}>{action.label}</Anchor>
        : <UnstyledButton onClick={action.onClick} className={styles.action} c="var(--mantine-color-anchor)" fz="sm">{action.label}</UnstyledButton>)}
    </div>
  );
}
