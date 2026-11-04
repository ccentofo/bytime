import { statusTone, statusWord, type Tone } from '@/lib/ui/status';
import styles from './StatusBadge.module.css';

/**
 * A status as a dot plus its word (feature-plan-ux-kit-contracts.md §3.1). `status` is a stored value ("rejected" →
 * "Returned", warn); `tone` / `word` override for labels outside the status map (e.g. "No category").
 */
export function StatusBadge({ status, word, tone }: { status?: string; word?: string; tone?: Tone }) {
  const t = tone ?? (status ? statusTone(status) : 'dim');
  return <span className={styles.badge} data-tone={t}>{word ?? (status ? statusWord(status) : '')}</span>;
}
