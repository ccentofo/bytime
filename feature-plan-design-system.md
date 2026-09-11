# Blueprint: CadenzPoint Design System — Palette, Typography & Mantine Theme Foundation

> **Role for the executing developer: Senior design-systems / front-end engineer.** This establishes
> the visual foundation the whole app inherits. The acceptance bar is "audit-serious, but
> unmistakably modern": restrained, high-contrast, the accent used sparingly so it stays meaningful.
> The hexes below are a tuned starting point — you own final contrast/AA accessibility.

## 1. Brand & UX Overview

**Brand essence:** precise · disciplined · modern · human — "the composure of an auditor with the
polish of a great consumer app." The design tension to hold: modern enough to stand out from
Deltek/Unanet, serious enough that a CFO trusts it with audit-critical data. **When in doubt, resolve
toward clarity and restraint** — over-design reads as untrustworthy to this buyer.

**Chosen palette — Option A "Modern Ink + Signal Blue":** a deep navy ink with one confident
signal-blue accent. The accent is **"the point"** — reserve it for the primary CTA, the
cleared/verified status, and the single key number. Do not paint the UI rainbow.

| Role | Color | Hex |
|---|---|---|
| Primary ink | Deep navy | `#0C1B33` |
| Accent ("the point") | Signal blue/indigo | `#4F6BFF` |
| Success / "cleared" | Verified green | `#16A34A` |
| Warning / "needs reason code" | Amber | `#F59E0B` |
| Surface | Off-white | `#F7F8FB` |
| Hairline / borders | Cool gray | `#E2E6EE` |

**Chosen typography — Geist + Inter (both free):**
- **Wordmark + headings:** Geist (geometric, modern; already installed via `next/font`).
- **Body + UI:** Inter (exceptional small-size legibility for a data-dense timekeeping app).
- **Numerals:** **tabular (monospaced) figures everywhere numbers align** — timesheets, totals,
  reports. Hours must line up in columns. This is a small detail that signals "we understand data"
  to a finance buyer.

**Current state:** `src/app/layout.tsx` calls `createTheme({})` (empty) — no brand color, no fonts
wired into Mantine, default Mantine blue + default font stack. Geist & Geist_Mono are loaded as CSS
variables but never handed to Mantine. This blueprint fills that in.

---

## 2. Technical Direction

1. **Define brand colors as Mantine 10-shade tuples** (`signal`, `ink`, `success`, `warning`) and set
   `primaryColor: 'signal'`. Index 6 is Mantine's default filled shade; the tuples are anchored so
   `signal[6] = #4F6BFF` and `ink[9] = #0C1B33`.
2. **Wire fonts into the theme**: add Inter via `next/font/google`, keep Geist, and set Mantine's
   `fontFamily` (Inter) + `headings.fontFamily` (Geist) + `fontFamilyMonospace` (Geist Mono).
3. **Tabular numerals**: apply `font-variant-numeric: tabular-nums` to numeric/table contexts via a
   small `globals.css` rule + a `.tnum` utility class (the timesheet already does this inline; this
   generalizes it to totals, reports, dashboards).
4. **Restraint pass**: tune component defaults (radius, default props) and reduce the landing page's
   multi-color feature grid to ink + the single accent so the accent stays meaningful.
5. **Dark mode**: tune Mantine's `dark` tuple toward navy so dark mode reads on-brand, not generic gray.

Keep the change centralized in the theme. Do **not** hand-color individual components beyond the
specified swaps — the point of a token system is that components inherit.

---

## 3. File Topology

```
Files to CREATE:
└── src/theme.ts                               ← the CadenzPoint Mantine theme (colors, fonts, defaults)

Files to MODIFY:
├── src/app/layout.tsx                         ← import Inter; import theme from src/theme.ts; pass font vars
├── src/app/globals.css                        ← tabular-nums rule + .tnum utility + surface/hairline vars (optional)
└── src/app/page.tsx                           ← restraint pass: feature cards → ink + single accent (NOT a rewrite)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/**                ← already fit-to-width + tabular; theme flows in automatically
├── src/server/**                             ← no server changes
└── any *.module.css for MRT                   ← leave MRT overrides; theme tokens cascade
```

> **Scope discipline:** this blueprint sets tokens and a few high-visibility defaults. A full sweep
> migrating every literal `color="blue"` / `color="grape"` across the app to semantic tokens is a
> SEPARATE follow-up (noted in §6) — do not attempt it here or the diff becomes unreviewable.

---

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Per `AGENTS.md`, this is Mantine **v9** on Next.js **16** — confirm `createTheme` /
>   `MantineColorsTuple` / `next/font` APIs against `node_modules/@mantine/core` and
>   `node_modules/next/dist/docs/` before relying on them.
> - All six brand hexes must survive an AA contrast check for their intended use (text vs surface,
>   white-on-accent for buttons). Tune the tuple shades if a check fails; keep the anchor shades
>   (`signal[6]`, `ink[9]`) close to spec.
> - Do not regress dark mode. Verify both schemes after each step.
> - `npm run build` + `npm run test` must pass.

**Step 1 — Create the theme.** Create `src/theme.ts`:
```ts
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

// Navy-tinted dark scheme so dark mode reads on-brand (not generic gray).
// Mantine `dark[7]/dark[6]` are the app background + surface in dark mode.
const dark: MantineColorsTuple = [
  '#c4cad6', '#a6afc0', '#8794ab', '#6b7a96', '#4f5e7c',
  '#34435f', '#16243f', '#0f1b30', '#0a1426', '#060d1a',
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
  },
});
```

**Step 2 — Add Inter + wire the theme into the root layout.** In `src/app/layout.tsx`:
- Add `Inter` to the `next/font/google` import alongside `Geist`/`Geist_Mono`, exposing `--font-inter`.
- Replace the inline empty theme with the imported one.
```diff
-import { Geist, Geist_Mono } from "next/font/google";
+import { Geist, Geist_Mono, Inter } from "next/font/google";
 import "@mantine/core/styles.css";
 import "@mantine/dates/styles.css";
 import "@mantine/notifications/styles.css";
 import "./globals.css";
-import { MantineProvider, ColorSchemeScript, createTheme } from "@mantine/core";
+import { MantineProvider, ColorSchemeScript } from "@mantine/core";
 import { Notifications } from "@mantine/notifications";
+import { theme } from "@/theme";
-
-const theme = createTheme({});

 const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
 const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
+const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
```
Then add Inter's variable to the `<html>` className:
```diff
-    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
+    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${inter.variable}`} suppressHydrationWarning>
```
> Leave the `ColorSchemeScript`-in-`<body>` pattern and `defaultColorScheme="auto"` exactly as they
> are — that placement is the Mantine-v9-for-Next-App-Router requirement (the existing comment explains why).

**Step 3 — Tabular numerals + surface tokens in globals.css.** Append to `src/app/globals.css`:
```css
/* ---------------------------------------------------------------------------
   CadenzPoint design tokens — tabular figures for aligned numbers.
   Hours, totals, and report figures must line up in columns ("we understand data").
   --------------------------------------------------------------------------- */
.tnum,
table td,
table th,
[class*="MRT_"] td,
[class*="MRT_"] th {
  font-variant-numeric: tabular-nums;
}
```
> The timesheet grid already sets `tabular-nums` inline on its total cells; this generalizes it to
> reports, dashboards, and any `<table>`. The `.tnum` class is available for one-off numbers (e.g. a
> dashboard KPI) without restyling the element.

**Step 4 — Restraint pass on the landing feature grid.** `src/app/page.tsx`'s `FeatureCard`s
currently use eight different colors (`blue`, `green`, `grape`, `orange`, `cyan`, `red`, `indigo`,
`yellow`). That rainbow contradicts "use the accent sparingly so it stays meaningful." Make the
feature icons uniform **ink** with the accent reserved for emphasis:
- Change each `<FeatureCard ... color="..." />` to a single restrained treatment — pass `color="ink"`
  (or drop per-card color and default the `ThemeIcon` to `variant="light" color="ink"`), and let the
  **CTA buttons** and a single highlighted card carry the `signal` accent.
- Keep semantic colors where they carry meaning elsewhere in the app (success = cleared, warning =
  reason-code) — this step is specifically about the marketing grid's decorative rainbow.
> This is a judgment-driven polish step; the goal is restraint, not literal find/replace. If a fully
> monochrome grid feels flat, allow the accent on ONE hero card. Hold the "audit-serious, modern" bar.

**Step 5 — Verify both color schemes.** Toggle light/dark (header sun/moon). Confirm: primary buttons
are signal blue; text is high-contrast ink on off-white (light) / light-on-navy (dark); hairlines/
borders read as the cool-gray tone; dark mode background is navy-tinted, not neutral gray.

---

## 5. Verification

### 5a. Build & tests
```bash
npm run build        # zero errors
npm run test         # unit tests pass
npm run lint         # no NEW errors
```

### 5b. Token adoption
| Check | How | Expected |
|---|---|---|
| Primary color is signal blue | Inspect any primary `<Button>` | fill ≈ `#4F6BFF` |
| Body font is Inter | DevTools → computed `font-family` on body text | `Inter …` |
| Headings font is Geist | computed `font-family` on a `<Title>` | `Geist …` |
| Numbers are tabular | Type `111` then `888` in an hours cell | same width, columns don't jiggle |
| Dark mode on-brand | toggle to dark | navy-tinted background, not gray |
| Accent restraint | view landing | feature icons uniform; accent on CTAs only |

### 5c. Accessibility
| Pair | Min ratio | Check |
|---|---|---|
| Ink text on off-white surface | 4.5:1 (body) | passes |
| White text on `signal[6]` button | 4.5:1 | passes (tune to `signal[7]` if borderline) |
| Success/warning text vs surface | 4.5:1 | passes |

### 5d. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Fonts didn't change | theme `fontFamily` references a CSS var not added to `<html>` className | add `${inter.variable}` to the html class (Step 2) |
| `primaryColor: 'signal'` throws | color name not registered in `theme.colors` | ensure `signal` is in the `colors` object |
| Mantine "10 shades required" error | a tuple has ≠10 entries | each `MantineColorsTuple` must have exactly 10 hexes |
| Dark mode looks unchanged | overrode `dark` but Mantine cached scheme | hard-reload; confirm `dark` tuple is in `colors` |
| White button text unreadable | `primaryShade` too light | set `primaryShade.light` to 6 (or 7) so white text passes AA |
| Numbers still proportional in reports | report tables aren't `<table>`/MRT | add `.tnum` to the numeric cells/components |

---

## 6. Follow-ups (out of scope here — track separately)
- **Semantic color sweep:** migrate literal `color="blue"|"green"|"orange"|"red"` across app
  components to `signal`/`success`/`warning`/`ink` tokens so the whole app is consistently on-palette.
- **Component default polish:** Paper/Card shadow + border tuning, AppShell header border to the
  hairline token, focus-ring color.
- These depend on this blueprint's tokens existing first.
