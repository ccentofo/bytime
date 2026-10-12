import { Group, Text, type MantineSize } from '@mantine/core';

type MarkProps = {
  /** pixel size of the square mark */
  size?: number;
  /** override the diamond ("the point") color; defaults to the signal accent token */
  accent?: string;
  /** render everything in currentColor (no accent) — for tight/low-contrast contexts */
  mono?: boolean;
};

/**
 * The CadenzPoint mark: three ascending bars (the cadence) resolving into a sharp
 * diamond (the point). Bars inherit currentColor; the diamond carries the accent.
 */
export function BrandMark({ size = 28, accent = 'var(--mantine-color-signal-6)', mono = false }: MarkProps) {
  const diamond = mono ? 'currentColor' : accent;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="CadenzPoint"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* ascending bars — the cadence (rising left → right) */}
      <rect x="2"  y="20" width="4" height="8"  rx="1.5" fill="currentColor" />
      <rect x="8"  y="14" width="4" height="14" rx="1.5" fill="currentColor" />
      <rect x="14" y="8"  width="4" height="20" rx="1.5" fill="currentColor" />
      {/* the point — a sharp diamond at the apex of the rise, in the accent */}
      <path d="M25 3.5 L29.5 8 L25 12.5 L20.5 8 Z" fill={diamond} />
    </svg>
  );
}

const WORDMARK_FZ: Record<string, number> = { sm: 18, md: 22, lg: 28, xl: 40 };

/**
 * The CadenzPoint wordmark: "Cadenz" medium + "Point" heavy, same ink color.
 * The weight shift (not color) signals the two-part name.
 */
export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const fz = WORDMARK_FZ[size] ?? 22;
  return (
    <Text
      component="span"
      style={{
        fontFamily: 'var(--font-geist-sans), sans-serif',
        fontSize: fz,
        lineHeight: 1,
        letterSpacing: '-0.01em',
        color: 'var(--mantine-color-text)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontWeight: 500 }}>Cadenz</span>
      <span style={{ fontWeight: 800 }}>Point</span>
    </Text>
  );
}

const MARK_PX: Record<string, number> = { sm: 24, md: 28, lg: 36, xl: 52 };

/** Mark + wordmark, horizontally aligned. */
export function Logo({ size = 'md', mono = false }: { size?: 'sm' | 'md' | 'lg' | 'xl'; mono?: boolean }) {
  return (
    <Group gap={size === 'xl' ? 'sm' : 'xs'} align="center" wrap="nowrap" c="var(--mantine-color-text)">
      <BrandMark size={MARK_PX[size] ?? 28} mono={mono} />
      <Wordmark size={size} />
    </Group>
  );
}
