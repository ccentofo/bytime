#!/usr/bin/env node
/**
 * Patch mantine-react-table 2.0.0-beta.9 for Mantine 9 (feature-plan-ux-foundations.md §4.2, UX-AUDIT B4).
 *
 * Why: MRT beta.9 supports @mantine/core ^7.9; this app runs Mantine 9 (installed anyway because .npmrc sets
 * legacy-peer-deps). Mantine 9 renamed Collapse's `in` prop to `expanded`, so every MRT Collapse renders closed —
 * the global search, the column filters and the detail panel never open — and React warns about a non-boolean `in`
 * attribute on the DOM. This script rewrites ` in: ` → ` expanded: ` inside MRT's five Collapse calls, in both dist
 * files. It is idempotent and refuses (throws / exits 1) on any source it doesn't recognise, so a version drift fails
 * loudly instead of shipping a half-patched table.
 *
 * Runs on postinstall, predev, prebuild and pretest (prebuild covers the Dockerfile's `npm ci --ignore-scripts`).
 *
 * Remove when: delete when MRT ships Mantine 9 support or MRT is replaced.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MRT_VERSION = '2.0.0-beta.9';

/** The exact unpatched Collapse openings (feature-plan §1). The first appears 3 times per file; the others once. */
const TARGETS = {
  esm: [
    { text: 'jsx(Collapse, { in: ', count: 3 },
    { text: 'jsxs(Collapse, { className: classes$9.collapse, in: ', count: 1 },
    { text: "jsx(Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ", count: 1 },
  ],
  cjs: [
    { text: 'jsxRuntime.jsx(core.Collapse, { in: ', count: 3 },
    { text: 'jsxRuntime.jsxs(core.Collapse, { className: classes$9.collapse, in: ', count: 1 },
    { text: "jsxRuntime.jsx(core.Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ", count: 1 },
  ],
};

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const patchedForm = (unpatched) => `${unpatched.slice(0, -' in: '.length)} expanded: `;

function unexpected(found) {
  return new Error(
    `mantine-react-table patch: unexpected source (expected 5 Collapse \`in:\` props, found ${found}). ` +
    'Re-check the MRT version and update scripts/patch-mantine-react-table.mjs.',
  );
}

/**
 * Pure. Unpatched source → `{ text, changed: true }` with ` in: ` → ` expanded: ` inside the 5 Collapse calls only;
 * already-patched source → `{ text, changed: false }` (unchanged); anything else throws.
 * @param {string} text
 * @param {'esm' | 'cjs'} kind
 */
export function patchSource(text, kind) {
  const targets = TARGETS[kind];
  if (!targets) throw new Error(`mantine-react-table patch: unknown kind ${kind}`);
  const totalIn = occurrences(text, ' in: ');
  const totalExpanded = occurrences(text, 'expanded:');

  const unpatchedOk = totalIn === 5 && totalExpanded === 0 && targets.every((t) => occurrences(text, t.text) === t.count);
  if (unpatchedOk) {
    let out = text;
    for (const t of targets) out = out.split(t.text).join(patchedForm(t.text));
    return { text: out, changed: true };
  }

  const patchedOk = targets.every((t) => occurrences(text, patchedForm(t.text)) === t.count && occurrences(text, t.text) === 0);
  if (patchedOk) return { text, changed: false };

  throw unexpected(totalIn);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkgDir = path.join(root, 'node_modules', 'mantine-react-table');
  if (!existsSync(pkgDir)) {
    console.log('mantine-react-table patch: node_modules/mantine-react-table not found — nothing to patch.');
    process.exit(0);
  }
  const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (version !== MRT_VERSION) {
    console.error(`mantine-react-table patch: installed version is ${version}, but this patch is for ${MRT_VERSION}. ` +
      'Re-check the MRT version and update scripts/patch-mantine-react-table.mjs.');
    process.exit(1);
  }
  for (const [file, kind] of [['index.esm.mjs', 'esm'], ['index.cjs', 'cjs']]) {
    const full = path.join(pkgDir, 'dist', file);
    try {
      const { text, changed } = patchSource(readFileSync(full, 'utf8'), kind);
      if (changed) writeFileSync(full, text);
      console.log(`mantine-react-table patch: ${file} ${changed ? 'patched' : 'already patched'}`);
    } catch (err) {
      console.error(`${err.message} (${file})`);
      process.exit(1);
    }
  }
}

// CLI only when run directly — importing patchSource (tests) never touches node_modules or calls process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
