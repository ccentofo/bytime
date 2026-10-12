import { createTheme, type MantineColorsTuple } from '@mantine/core';

// ── Brand color tuples (Mantine wants 10 shades, light→dark; index 6 = default filled) ──

// "Signal blue" — THE ACCENT / "the point". Anchored: signal[6] = #4F6BFF.
// Reserve for the primary CTA, cleared/verified status, and the single key number.
const signal: MantineColorsTuple = [
  '#eef1ff', '#dce1ff', '#b6c1ff', '#8d9eff', '#6b80ff',
  '#566eff', '#4f6bff', '#3f55e6', '#3346c0', '#283a9e',
];

// "Ink" — deep-navy neutral for text, surfaces, hairlines. Anchored: ink[9] = #0C1B33.
// ink[0] = surface off-white (#F7F8FB), ink[2] = hairline (#E2E6EE).
const ink: MantineColorsTuple = [
  '#f7f8fb', '#edeff4', '#e2e6ee', '#c8cfdc', '#99a3b7',
  '#6b7791', '#46526e', '#2a3650', '#16243f', '#0c1b33',
];

// Success / "cleared" — anchored success[6] = #16A34A.
const success: MantineColorsTuple = [
  '#e8f8ef', '#d0efdd', '#a1dfbb', '#6fce96', '#48c077',
  '#2fb766', '#16a34a', '#0f8d3f', '#077634', '#005f28',
];

// Warning / "needs reason code" — anchored warning[6] = #F59E0B.
const warning: MantineColorsTuple = [
  '#fff6e3', '#fee9c4', '#fbd28a', '#f8bc4b', '#f6aa1f',
  '#f5a00d', '#f59e0b', '#d98708', '#bf7305', '#a35f02',
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

export const theme = createTheme({
  primaryColor: 'signal',
  primaryShade: { light: 6, dark: 5 },
  colors: { signal, ink, success, warning, dark },

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
    Badge: { defaultProps: { variant: 'light' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } },
    Modal: { defaultProps: { centered: true, radius: 'md' } },
  },
});
