import { describe, it, expect } from 'vitest';
import { parseDisasterArgs, runDisaster, type DisasterArgs, type DisasterDeps } from '../../../scripts/backup/disaster';

/** feature-plan-control-plane-disaster.md §11 T6 (the task's half): the grammar and the startedBy gate. */

const A = '0a1b2c3d-1111-4222-8333-444455556666';
const parse = (...argv: string[]) => parseDisasterArgs(argv, new Date('2026-11-18T12:00:00Z'));

describe('T6: parseDisasterArgs, the control-plane modes', () => {
  it.each([
    [['control-plane', '--targets', 'control-plane'], { mode: 'control-plane', targets: 'control-plane', override: 'none' }],
    [['control-plane', '--targets', 'control-plane', '--override', 'none', '--run-id', 'gh-1-1'], { mode: 'control-plane', targets: 'control-plane', runId: 'gh-1-1' }],
    [['reconcile', '--targets', 'control-plane'], { mode: 'reconcile', targets: 'control-plane', override: 'none' }],
    [['rehearse', '--targets', 'control-plane'], { mode: 'rehearse', targets: 'control-plane', override: 'none' }],
  ])('accepts %j', (argv, args) => {
    expect(parse(...argv)).toEqual({ ok: true, args: expect.objectContaining(args) });
  });

  it.each([
    ['control-plane with a workspace id', ['control-plane', '--targets', A]],
    ['control-plane with all-lost', ['control-plane', '--targets', 'all-lost']],
    ['reconcile with auto', ['reconcile', '--targets', 'auto']],
    ['control-plane with the canary', ['control-plane', '--targets', 'control-plane', '--override', 'canary']],
    ['control-plane with unreachable-4h', ['control-plane', '--targets', 'control-plane', '--override', 'unreachable-4h']],
    ['reconcile with the canary', ['reconcile', '--targets', 'control-plane', '--override', 'canary']],
    ['the control-plane rehearsal with the canary', ['rehearse', '--targets', 'control-plane', '--override', 'canary']],
    ['workspace with targets control-plane', ['workspace', '--targets', 'control-plane']],
    ['an unknown mode (still exit 1)', ['restore', '--targets', 'control-plane']],
  ])('refuses %s with exit 1', (_name, argv) => {
    expect(parse(...argv)).toMatchObject({ ok: false, exitCode: 1 });
  });

  it('an unknown flag still exits 2', () => {
    expect(parse('control-plane', '--targets', 'control-plane', '--force')).toMatchObject({ ok: false, exitCode: 2 });
  });
});

describe('T6: the startedBy gate (a schedule can only rehearse)', () => {
  const run = async (args: Partial<DisasterArgs>, startedBy: string) => {
    const logs: string[] = [];
    const deps = {
      controlPlaneUrl: 'postgresql://u:p@127.0.0.1:1/never', cpId: 'prod', log: (l: string) => logs.push(l),
      ecs: { self: async () => ({ taskArn: 'self', startedBy, createdAt: new Date() }), running: async () => [] },
    } as unknown as DisasterDeps;
    const r = await runDisaster({ mode: 'control-plane', targets: 'control-plane', override: 'none', runId: 'r', ...args }, deps);
    return { ...r, logs };
  };
  for (const mode of ['control-plane', 'reconcile'] as const) {
    it(`mode ${mode} from the schedule is refused before anything else`, async () => {
      const r = await run({ mode }, 'chronos-schedule/cadenzpoint-backup-disaster-rehearse-cp');
      expect(r.exitCode).toBe(1);
      expect(r.logs.join('\n')).toContain(`refused: mode ${mode} runs only from the button (gh-…) or the CloudShell fallback (cloudshell-…)`);
    });
  }
});
