import dayjs from 'dayjs';

/** Display date, e.g. "Jun 12, 2026". Use for every user-facing date — never `toLocaleDateString()`. */
export const formatDate = (d: Date | string | null | undefined) =>
  d ? dayjs(d).format('MMM D, YYYY') : '—';

/** Display date + time, e.g. "Jun 12, 2026 3:45 PM". */
export const formatDateTime = (d: Date | string | null | undefined) =>
  d ? dayjs(d).format('MMM D, YYYY h:mm A') : '—';

/** Short display date (no year), e.g. "Jun 12". For compact contexts like chart axes. */
export const formatShortDate = (d: Date | string | null | undefined) =>
  d ? dayjs(d).format('MMM D') : '—';
