# Blueprint: CadenzPoint Brand Identity — Logo Mark, Wordmark, Favicons & Placement

> **Role for the executing developer: Brand-minded front-end engineer.** You're translating a logo
> *concept* into shipped React + SVG. The geometry below is a precise starting point — you own the
> final optical balance (alignment, spacing, weight). The mark must read at 16px (favicon) and 200px
> (hero) without losing its identity.

> **Prerequisite:** this blueprint depends on **`feature-plan-design-system.md`** (it uses the
> `signal` accent token and the Geist heading font) and pairs with **`feature-plan-rebrand-cadenzpoint.md`**
> (the wordmark text is "CadenzPoint"). Run those first.

## 1. Brand Concept

**The idea:** a short sequence of **ascending bars** — the steady *cadence* (discipline, regular
rhythm, the daily-entry habit DCAA demands) — that resolves into a single **sharp diamond** — *the
point* (precision, a fixed reference, the moment everything lines up). The mark literally diagrams the
name: rhythm rising to a point.

**The wordmark:** "CadenzPoint" as one word with a deliberate internal capital — **`Cadenz` in a
medium weight, `Point` in a heavy weight, the same ink color**. The weight shift (not a color shift)
signals the two-part name without looking like two brands. An optional small accent diamond can act as
a closing "point."

**Why this works / what to avoid:** the cadence-to-point motif is ownable and scales to a standalone
app icon. **Avoid every category cliché:** no clock/stopwatch (timesheet-literal, and you're
expanding beyond it), no shield/lock (security cliché, explicitly ruled out), no eagle/flag/
stars-and-stripes (reads dated-government). The diamond is "the point" → it carries the **signal-blue
accent**; the bars are ink.

**Current state to replace:** a generic `/logo.png` shown via `<Avatar src="/logo.png">` in
`AppHeader.tsx` and `LoginForm.tsx`, a plain `<Title>` on the landing hero, and the default
`src/app/favicon.ico`.

---

## 2. Technical Direction

1. **Build the mark as inline SVG in a React component** (`BrandMark`) — not a PNG — so it's crisp at
   every size, inherits `currentColor` for the bars, and takes the accent for the diamond. Provide a
   `mono` prop (all-`currentColor`) for contexts where the accent would clash.
2. **Build the wordmark as a typographic component** (`Wordmark`) using the Geist heading font with
   the `Cadenz`(500) / `Point`(800) weight split. Compose both into `<Logo>` (mark + wordmark).
3. **Favicon/app icon via Next 16 file conventions**: a static `src/app/icon.svg` (an app-tile style
   mark with a navy background so it reads on light *and* dark browser chrome). Next serves it
   automatically as the favicon — verify the convention in the Next 16 docs.
4. **Replace placements**: header, login card, landing hero, and (optional) the signup card.

The components are presentational and dependency-light (Mantine `Group`/`Text` + inline SVG). They
work in both server and client component trees.

---

## 3. File Topology

```
Files to CREATE:
├── src/components/brand/Logo.tsx              ← BrandMark (SVG) + Wordmark + Logo (composed)
└── src/app/icon.svg                           ← favicon / app icon (Next 16 auto-serves it)

Files to MODIFY:
├── src/components/shell/AppHeader.tsx         ← replace Avatar+Title with <Logo size="sm" />
├── src/app/login/LoginForm.tsx                ← replace Avatar+Title with stacked <Logo size="lg" />
├── src/app/page.tsx                           ← hero: replace <Title>CadenzPoint</Title> with <Logo size="xl" />
└── (optional) src/app/signup/SignupForm.tsx   ← add <Logo> to the signup card header for consistency

Files to DELETE (after placements are migrated):
└── (optional) public/logo.png                 ← only once no component references /logo.png

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/app/favicon.ico                        ← leave the .ico as a legacy fallback (icon.svg takes precedence)
└── public/{file,globe,window,next,vercel}.svg ← unrelated scaffolding assets
```

---

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Per `AGENTS.md`, confirm the **Next.js 16 metadata-files convention** (`icon.svg` / `apple-icon`)
>   in `node_modules/next/dist/docs/` before relying on auto-favicon behavior.
> - The mark must stay recognizable at 16px — keep the bar count low (3) and the diamond bold.
> - Bars = ink (`currentColor`); diamond = accent. Provide a `mono` escape hatch.
> - Preserve the "CadenzPoint" internal-cap spelling and the `Cadenz`/`Point` weight split.
> - `npm run build` must pass; both color schemes must look right.

**Step 1 — Create the logo components.** Create `src/components/brand/Logo.tsx`:
```tsx
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
```
> Optical tuning is yours: nudge the diamond's vertical center so it visually sits at the apex of the
> tallest bar, and adjust the bar `rx` / gaps until the rhythm feels even. The bars use `currentColor`
> so the mark adopts the surrounding text color (ink in light, near-white in dark) automatically.

**Step 2 — Create the favicon / app icon.** Create `src/app/icon.svg` (a self-contained file — CSS
vars don't resolve in favicons, so use literal hexes; navy tile gives contrast on any browser chrome):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#0C1B33"/>
  <rect x="6"  y="19" width="3.5" height="7"  rx="1.25" fill="#E2E6EE"/>
  <rect x="12" y="14" width="3.5" height="12" rx="1.25" fill="#E2E6EE"/>
  <rect x="18" y="9"  width="3.5" height="17" rx="1.25" fill="#E2E6EE"/>
  <path d="M25 5 L29 9 L25 13 L21 9 Z" fill="#4F6BFF"/>
</svg>
```
> Next 16 auto-discovers `src/app/icon.svg` and emits the `<link rel="icon">` — no metadata code
> needed. The existing `favicon.ico` stays as a legacy fallback. (Optional: add `apple-icon.png` at
> 180×180 with the same tile for iOS home-screen polish — confirm the filename convention in the docs.)

**Step 3 — Header placement.** In `src/components/shell/AppHeader.tsx`, replace the avatar + title
brand block with the `Logo` (remove the now-unused `Avatar` import if nothing else uses it):
```diff
-import { Group, Title, Avatar, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme, Box } from '@mantine/core';
+import { Group, ActionIcon, Text, Menu, UnstyledButton, useMantineColorScheme, Box, Avatar } from '@mantine/core';
+import { Logo } from '@/components/brand/Logo';
```
```diff
       <Group gap="sm">
-        <Avatar src="/logo.png" size="md" radius="sm" />
-        <Title order={3}>ByTime</Title>
+        <Logo size="sm" />
       </Group>
```
> Keep `Avatar` imported only if the user-menu avatar still uses it (it does — the menu shows
> `user.fullName.charAt(0)`). Just drop the `Title` import if it's now unused.

**Step 4 — Login card placement.** In `src/app/login/LoginForm.tsx`, replace the stacked avatar +
title with the `Logo` (keep the "DCAA-Compliant Timekeeping" tagline below it):
```diff
         <Stack align="center" mb="lg">
-          <Avatar src="/logo.png" size="lg" radius="sm" />
-          <Title order={2}>ByTime</Title>
+          <Logo size="lg" />
           <Text c="dimmed" size="sm">
             DCAA-Compliant Timekeeping
           </Text>
         </Stack>
```
Add `import { Logo } from '@/components/brand/Logo';` and remove `Avatar`/`Title` from the Mantine
import if they're now unused in this file.

**Step 5 — Landing hero placement.** In `src/app/page.tsx`, replace the hero brand `<Title>` with the
extra-large `Logo` (the rebrand blueprint already changed the text to "CadenzPoint"; this swaps it for
the real lockup):
```diff
-          <Title order={1} ta="center" size={48}>
-            CadenzPoint
-          </Title>
+          <Logo size="xl" />
```
Add the import. Keep the `DCAA Compliant` badge above and the sub-headline below.

**Step 6 — (Optional) Signup card.** For consistency, add `<Logo size="lg" />` to the top of the
signup card in `src/app/signup/SignupForm.tsx` if it has a brand header.

**Step 7 — Retire the PNG.** Once `grep -rn "/logo.png" src/` returns nothing, delete
`public/logo.png`. If anything still references it, leave it.

---

## 5. Verification

### 5a. Build & visual
```bash
npm run build        # zero errors
npm run lint         # no NEW errors (watch for unused Avatar/Title imports)
grep -rn "/logo.png" src/   # should be empty before deleting public/logo.png
```

### 5b. The legibility ladder (the core acceptance check)
| Context | Size | Expected |
|---|---|---|
| Browser tab favicon | 16px | navy tile, three bars + blue diamond still distinguishable |
| App header | ~24px mark + wordmark | crisp; `Cadenz` lighter than `Point`; diamond accent visible |
| Login card | ~36px | balanced lockup, tagline reads below |
| Landing hero | ~52px | premium, optically centered |
| Dark mode (all of the above) | — | bars adopt near-white (currentColor); diamond stays accent; contrast holds |

### 5c. Brand fidelity
| Check | Expected |
|---|---|
| Weight split | `Cadenz` = 500, `Point` = 800, identical color |
| Diamond color | signal accent (`#4F6BFF`) in app; literal in favicon |
| Bars color | inherit text color (ink light / near-white dark) |
| `mono` prop | renders diamond in currentColor (no accent) when set |
| No clichés | no clock, shield, lock, eagle, or flag anywhere in the mark |

### 5d. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Diamond invisible in favicon | CSS var used in `icon.svg` | favicons can't resolve CSS vars — use literal hexes (Step 2) |
| Mark disappears in dark mode | bars hardcoded to ink instead of `currentColor` | bars must be `fill="currentColor"` |
| Favicon not updating | browser cache / wrong filename | hard-reload; confirm file is `src/app/icon.svg` per Next 16 docs |
| Wordmark uses wrong font | `--font-geist-sans` not loaded | ensure design-system blueprint wired Geist (it loads the var in layout) |
| Lint: unused import | `Avatar`/`Title` left imported after swap | remove unused imports |
| Mark looks cramped at 16px | too many bars / thin diamond | keep 3 bars; thicken the diamond; this is why the favicon is a separate, simplified file |

---

## 6. Follow-ups (out of scope — track separately)
- **Animated mark** (bars rising → diamond snapping in) for the loading/splash state.
- **`apple-icon.png` + `manifest.webmanifest`** for full PWA/home-screen install polish (the app
  already has offline support — a proper installable icon set complements it).
- **Email logo**: a hosted PNG version of the mark for email templates (emails can't use inline SVG
  reliably across clients) — pairs with the rebrand blueprint's email work.
