import { DAY_NAMES } from '@/lib/timezone-options';

/**
 * The anchor rule's refusal (a weekly / biweekly first period must start on the pay week's first day), shared by the
 * server and the Setup checklist's pay-schedule form, which shows exactly this message next to the date
 * (UX-4C2A-AUDIT.md F4). Client-safe.
 */
export const anchorDayMessage = (weekStartDay: number) => `The first period must start on a ${DAY_NAMES[weekStartDay] ?? 'week start day'}.`;
