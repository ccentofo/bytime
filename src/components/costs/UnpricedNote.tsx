'use client';

import { Anchor, Text } from '@mantine/core';
import { UNPRICED_REPORT_HREF, unpricedHoursLabel } from '@/lib/cost-labels';

/**
 * "X hours unpriced" next to a cost or funding total (feature-plan-certified-outputs.md C3, CO-D17), linking to the
 * Unpriced hours report scoped to the same contract / CLIN / SLIN / date range. Renders nothing when X = 0.
 */
export function UnpricedNote({ hours, scope = {}, size = 'xs' }: {
  hours: number;
  scope?: { contractId?: string; clinId?: string; slinId?: string; startDate?: string; endDate?: string };
  size?: 'xs' | 'sm';
}) {
  const label = unpricedHoursLabel(hours);
  if (!label) return null;
  const params = new URLSearchParams(Object.entries(scope).filter(([, v]) => !!v) as Array<[string, string]>);
  // Fix round 1 (F11): land on the report itself, not the top of the Labor Categories page.
  const href = `${params.size ? `${UNPRICED_REPORT_HREF}&${params.toString()}` : UNPRICED_REPORT_HREF}#cost-basis-reports`;
  return (
    <Text size={size} c="warning.7">
      <Anchor href={href} size={size} c="warning.7" underline="always">{label}</Anchor>
    </Text>
  );
}

/**
 * Beside a "Remaining" funding figure (fix round 1, F5 — CO-D17): while hours are unpriced, Remaining = funded − PRICED
 * cost, so it says so and links to the hours behind it. Renders nothing when X = 0.
 */
export function PricedBasisNote({ hours, scope = {}, size = 'xs' }: {
  hours: number;
  scope?: { contractId?: string; clinId?: string; slinId?: string; startDate?: string; endDate?: string };
  size?: 'xs' | 'sm';
}) {
  if (!unpricedHoursLabel(hours)) return null;
  return (
    <div data-testid="priced-basis-note">
      <Text size={size} c="dimmed">based on priced cost</Text>
      <UnpricedNote hours={hours} scope={scope} size={size} />
    </div>
  );
}
