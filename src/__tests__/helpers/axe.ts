import axe from 'axe-core';

/**
 * axe-core accessibility check for jsdom render tests (feature-plan-ux-foundations.md §4.8). jsdom has no layout, so
 * `color-contrast` (proven by theme-contrast.test.ts) and `region` are off. Await every call — axe throws "Axe is
 * already running" if two runs overlap. Pass `document.body` whenever a Menu or Modal is open (they portal).
 */
export async function expectNoAxeViolations(root: Element): Promise<void> {
  const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  if (result.violations.length === 0) return;
  const lines = result.violations.map((v) =>
    `${v.id}: ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n')}`);
  throw new Error(`axe found ${result.violations.length} violation(s):\n${lines.join('\n')}`);
}
