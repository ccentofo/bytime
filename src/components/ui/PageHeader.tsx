import { Group, Title } from '@mantine/core';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  /** Rendered in a div with the description typography (a ReactNode inside a <p> could nest invalidly). */
  description?: ReactNode;
  actions?: ReactNode;
  /** The page's h1 by default; 2 when the page has another h1 above it (e.g. BillingWall). Looks the same either way. */
  order?: 1 | 2;
  /**
   * Rendered under the title, in the title's column (e.g. the timesheet's period control, feature-plan-ux-timesheet-ui.md
   * §4.1) — so reading and focus order is title → `below` → actions, the visual order (UX-TIMESHEET-B-AUDIT M6).
   */
  below?: ReactNode;
  /** feature-plan-ux-kit-contracts.md §3.2: above the title (e.g. "Downloads › Unpriced hours"). */
  breadcrumb?: ReactNode;
  /** feature-plan-ux-kit-contracts.md §3.2: page notices, rendered after the title row. */
  notices?: ReactNode;
};

/** Shared top-of-page header: title + optional description, with actions right-aligned. */
export function PageHeader({ title, description, actions, order = 1, below, breadcrumb, notices }: Props) {
  return (
    <div style={{ marginBottom: 'var(--mantine-spacing-lg)' }}>
      {breadcrumb && (
        <div data-testid="page-breadcrumb" style={{ fontSize: 'var(--mantine-font-size-sm)', color: 'var(--mantine-color-dimmed)', marginBottom: 6 }}>
          {breadcrumb}
        </div>
      )}
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={order} size="h2">{title}</Title>
          {description && (
            <div data-testid="page-description" style={{ fontSize: 'var(--mantine-font-size-sm)', color: 'var(--mantine-color-dimmed)', marginTop: 4, lineHeight: 'var(--mantine-line-height-sm)' }}>
              {description}
            </div>
          )}
          {below && <div style={{ marginTop: 'var(--mantine-spacing-sm)' }}>{below}</div>}
        </div>
        {actions}
      </Group>
      {notices && <div style={{ marginTop: 'var(--mantine-spacing-md)' }}>{notices}</div>}
    </div>
  );
}
