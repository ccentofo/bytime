import { describe, it, expect } from 'vitest';
import path from 'path';
import { ESLint } from 'eslint';

/**
 * feature-plan-ux-foundations.md §4.8 / T17: the jsx-a11y recommended rules run at WARN on src/**\/*.tsx (rules-only
 * config — re-registering the plugin breaks ESLint 9), with the Mantine settings and the two no-restricted-syntax guards.
 */

const ROOT = path.resolve(__dirname, '../../..');

describe('ESLint accessibility config (T17)', () => {
  it('src/app/page.tsx gets the jsx-a11y recommended rules at warn, Next alt-text options kept, and the Mantine guards', async () => {
    const config = await new ESLint({ cwd: ROOT }).calculateConfigForFile(path.join(ROOT, 'src/app/page.tsx'));
    const level = (name: string) => { const v = config.rules?.[name]; return Array.isArray(v) ? v[0] : v; };
    expect(level('jsx-a11y/no-autofocus')).toBe(1);
    expect(level('jsx-a11y/label-has-associated-control')).toBe(1);
    expect(level('jsx-a11y/click-events-have-key-events')).toBe(1);
    expect(level('jsx-a11y/control-has-associated-label')).toBe(0); // 'off' in recommended stays off
    expect(config.rules?.['jsx-a11y/alt-text']).toEqual([1, { elements: ['img'], img: ['Image'] }]);
    const restricted = config.rules?.['no-restricted-syntax'] as unknown[];
    expect(restricted[0]).toBe(1);
    expect(restricted.slice(1).map((r) => (r as { message: string }).message)).toEqual([
      'ActionIcon needs an aria-label',
      'Anchor with onClick needs href or component="button"',
    ]);
    expect(config.settings?.['jsx-a11y']).toMatchObject({ polymorphicPropName: 'component', components: { ActionIcon: 'button', Anchor: 'a' } });
  });

  it('the guards flag an unlabeled ActionIcon and an href-less Anchor onClick, and pass the fixed forms', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const lint = async (code: string) => (await eslint.lintText(code, { filePath: path.join(ROOT, 'src/app/__fixture__.tsx') }))[0].messages
      .filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
    expect(await lint('export const A = () => <ActionIcon onClick={() => {}}>x</ActionIcon>;')).toEqual(['ActionIcon needs an aria-label']);
    expect(await lint('export const A = () => <ActionIcon aria-label="Close" onClick={() => {}}>x</ActionIcon>;')).toEqual([]);
    expect(await lint('export const A = () => <Anchor onClick={() => {}}>x</Anchor>;')).toEqual(['Anchor with onClick needs href or component="button"']);
    expect(await lint('export const A = () => <Anchor component="button" type="button" onClick={() => {}}>x</Anchor>;')).toEqual([]);
  });
});
