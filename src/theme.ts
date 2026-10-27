import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

// ── Brand color tuples (Mantine wants 10 shades, light→dark; index 6 = default filled) ──

// "Signal blue" — THE ACCENT / "the point". signal[6] = #4F6BFF stays the accent (focus ring, today, meters, logo
// dot); filled buttons and primary text use signal[7] = #3F55E6 (UX-D1, primaryShade 7). signal[4] is the dark-mode
// text shade (#6f84ff passes 4.5:1 on dark cards).
const signal: MantineColorsTuple = [
  '#eef1ff', '#dce1ff', '#b6c1ff', '#8d9eff', '#6f84ff',
  '#566eff', '#4f6bff', '#3f55e6', '#3346c0', '#283a9e',
];

// "Ink" — deep-navy neutral for text, surfaces, hairlines. Anchored: ink[9] = #0C1B33.
// ink[0] = surface off-white (#F7F8FB), ink[2] = hairline (#E2E6EE).
const ink: MantineColorsTuple = [
  '#f7f8fb', '#edeff4', '#e2e6ee', '#c8cfdc', '#99a3b7',
  '#6b7791', '#46526e', '#2a3650', '#16243f', '#0c1b33',
];

// Success / "cleared" — success[6] = #16A34A; shades 7–9 darkened for 4.5:1 text and white-on-filled (UX-1 §4.1).
const success: MantineColorsTuple = [
  '#e8f8ef', '#d0efdd', '#a1dfbb', '#6fce96', '#48c077',
  '#2fb766', '#16a34a', '#0e823a', '#0c6f31', '#0a5b29',
];

// Warning / "needs reason code" — warning[6] = #F59E0B; shades 7–9 darkened for 4.5:1 (UX-1 §4.1).
const warning: MantineColorsTuple = [
  '#fff6e3', '#fee9c4', '#fbd28a', '#f8bc4b', '#f6aa1f',
  '#f5a00d', '#f59e0b', '#9e6306', '#865405', '#6f4504',
];

// Red and cyan: Mantine's defaults for 0–6, shades 7–9 darkened for 4.5:1 (UX-1 §4.1). red[7] = #c92a2a also keeps
// danger menu text at 4.5:1 on the gray-1 hover.
const red: MantineColorsTuple = [
  '#fff5f5', '#ffe3e3', '#ffc9c9', '#ffa8a8', '#ff8787',
  '#ff6b6b', '#fa5252', '#c92a2a', '#a82424', '#8c1d1d',
];
const cyan: MantineColorsTuple = [
  '#e3fafc', '#c5f6fa', '#99e9f2', '#66d9e8', '#3bc9db',
  '#22b8cf', '#15aabf', '#0d7b8c', '#0b6977', '#095662',
];

// "Cool Slate" dark scheme — desaturated cool-gray (GitHub-dark-ish). Keeps a faint cool
// cast so it feels on-brand, but pulls saturation way down vs. the earlier navy (which read
// "Solarized"). The signal-blue accent stays the only real color in dark mode.
// Mantine maps: dark[7] = body background, dark[6] = surfaces/cards, dark[4] = borders,
// dark[2] = dimmed text, dark[0] = body text.
const dark: MantineColorsTuple = [
  '#c7cad2', '#abafba', '#878d9c', '#646a7c', '#474d5e',
  '#343a48', '#23262f', '#181a20', '#121319', '#0c0d11',
];

/**
 * Checked / active indicators (Checkbox, Radio, Switch fills, the Tabs indicator) — UX-1 fix round 1, M1. Mantine uses
 * the primary filled color (signal-7 in both schemes), which is below 3:1 on dark surfaces; signal-4 in dark passes
 * (and keeps the white check / thumb ≥ 3:1). Only when the caller passes no `color` of its own.
 */
export const INDICATOR_COLOR = 'light-dark(var(--mantine-color-signal-7), var(--mantine-color-signal-4))';
const indicator = (cssVar: string) => (_theme: unknown, props: { color?: unknown }) =>
  ({ root: { [cssVar]: props.color ? undefined : INDICATOR_COLOR } });

export const theme = createTheme({
  primaryColor: 'signal',
  // Shade 7 for every color's filled / text variants, both schemes (UX-1 §4.1: white on filled ≥ 4.5:1).
  primaryShade: { light: 7, dark: 7 },
  colors: { signal, ink, success, warning, red, cyan, dark },
  respectReducedMotion: true,

  // Type: Inter for body/UI, Geist for headings + wordmark, Geist Mono for code/mono.
  fontFamily:
    'var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace: 'var(--font-geist-mono), ui-monospace, monospace',
  headings: {
    fontFamily: 'var(--font-geist-sans), var(--font-inter), sans-serif',
    fontWeight: '600',
  },

  defaultRadius: 'md',
  cursorType: 'pointer',

  // Tabular figures for inputs (hours align as you type — pairs with the .tnum rule in globals.css).
  components: {
    NumberInput: { defaultProps: { style: { fontVariantNumeric: 'tabular-nums' } } },
    // Sentence case (UX-D2): no uppercase transform.
    Badge: { defaultProps: { variant: 'light' }, styles: { root: { textTransform: 'none', fontWeight: 600 } } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } },
    // The close (×) button has no accessible name by default (axe button-name) — name it everywhere.
    Modal: { defaultProps: { centered: true, radius: 'md', closeButtonProps: { 'aria-label': 'Close' } } },
    Drawer: { defaultProps: { closeButtonProps: { 'aria-label': 'Close' } } },
    Checkbox: { vars: indicator('--checkbox-color') },
    Radio: { vars: indicator('--radio-color') },
    Switch: { vars: indicator('--switch-color') },
    Tabs: { vars: indicator('--tabs-color') },
  },
});

/**
 * Contrast-safe global text / border colors (UX-1 §4.1.3). Mantine deep-merges this with its default resolver, so it
 * returns only the overrides. Passed by src/app/providers.tsx (a client component) — never from the Server Component
 * layout, which can't pass a function prop. Hex literals so the contrast test (theme-contrast.test.ts) can read them.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-dimmed': '#46526e',          // ink-6, 7.8:1 on white
    '--mantine-color-error': '#c92a2a',           // red-7
    '--mantine-color-placeholder': '#5f6b85',     // ≥ 4.5:1 on white, ink-0 and gray-1
    '--mantine-color-default-border': '#858fa5',  // ≥ 3:1 on white and ink-0 (input edges)
  },
  dark: {
    '--mantine-color-dimmed': '#abafba',          // dark-1
    '--mantine-color-error': '#ff8787',           // red-4
    '--mantine-color-placeholder': '#abafba',     // dark-1
    '--mantine-color-default-border': '#737a8e',  // ≥ 3:1 on dark-6 and dark-7
  },
});
