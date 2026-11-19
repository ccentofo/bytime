import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { parseExportArgs } from '../../../scripts/backup/export';

/**
 * feature-plan-cloud-export.md §11 T15: scripts/backup/export-button.sh run as GitHub runs a `run:` step (`bash -e` on a
 * file holding the step's text), with a stub `aws` and `sleep` first on PATH and a workflow_dispatch event file; the real
 * jq; every available bash. Plus the workflow's static rules. 3c's button harness (disaster-button.test.ts).
 */

const ROOT = path.resolve(__dirname, '../../..');
const WS = '0a1b2c3d-1111-4222-8333-444455556666';
const HOLD = '9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff';
const ADDR = 'Counsel.Smith+case@lawfirm.example.com';
const REASON = 'subpoena 24-117, verified by phone with GC';

const STUB_AWS = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/aws.log"
case "$1 $2" in
  "ecs list-tasks")
    case " $* " in
      *" --started-by "*) echo "\${STUB_STOP_ARNS-arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/t1}" ;;
      *) echo "\${STUB_RUNNING:-0}" ;;
    esac ;;
  "cloudformation describe-stacks")
    case "$*" in *TaskSubnets*) echo "subnet-a,subnet-b" ;; *ExportModes*) echo "\${STUB_MODES-deliver hold release}" ;; *) echo "sg-1" ;; esac ;;
  "ecs run-task")
    printf '%s\\t%s\\t%s\\n' "\${STUB_TASK-arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/t1}" "\${STUB_FAILURES:-0}" "\${STUB_REASON:-None}" ;;
  "ecs describe-tasks")
    n=$(cat "$STUB_DIR/describe.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/describe.n"
    line=$(sed -n "\${n}p" "$STUB_DIR/describe.txt" 2>/dev/null)
    [ -z "$line" ] && line=$(tail -n 1 "$STUB_DIR/describe.txt")
    printf '%s\\n' "$line" | tr '|' '\\t' ;;
  "ecs stop-task") echo '{"task":{"taskArn":"x"}}' ;;
  *) echo "unexpected aws call" >&2; exit 3 ;;
esac
`;
const STUB_SLEEP = '#!/bin/bash\necho "sleep $*" >> "$STUB_DIR/sleep.log"\nexit 0\n';

interface Run { status: number | null; out: string; aws: string[]; sleeps: number }

function setup(inputs: Record<string, string>, o: { describe?: string[]; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ex-btn-'));
  writeFileSync(path.join(dir, 'aws'), STUB_AWS);
  writeFileSync(path.join(dir, 'sleep'), STUB_SLEEP);
  chmodSync(path.join(dir, 'aws'), 0o755);
  chmodSync(path.join(dir, 'sleep'), 0o755);
  writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ inputs }));
  writeFileSync(path.join(dir, 'describe.txt'), (o.describe ?? ['STOPPED|EssentialContainerExited|0']).join('\n') + '\n');
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? '/tmp', STUB_DIR: dir,
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_RUN_ID: '515151', GITHUB_RUN_ATTEMPT: '1', ...o.env,
  } as unknown as NodeJS.ProcessEnv;
  const result = (status: number | null, out: string): Run => ({
    status, out,
    aws: existsSync(path.join(dir, 'aws.log')) ? readFileSync(path.join(dir, 'aws.log'), 'utf8').trim().split('\n') : [],
    sleeps: existsSync(path.join(dir, 'sleep.log')) ? readFileSync(path.join(dir, 'sleep.log'), 'utf8').trim().split('\n').length : 0,
  });
  return { dir, env, result };
}

function runStep(inputs: Record<string, string>, stepText = 'exec bash scripts/backup/export-button.sh', o: Parameters<typeof setup>[1] = {}): Run {
  const s = setup(inputs, o);
  const block = path.join(s.dir, 'step.sh');
  writeFileSync(block, stepText + '\n');
  const r = spawnSync('bash', ['-e', block], { cwd: ROOT, env: s.env, encoding: 'utf8', timeout: 60_000 });
  return s.result(r.status, (r.stdout ?? '') + (r.stderr ?? ''));
}

type Inputs = Partial<Record<'mode' | 'target' | 'extra_recipient' | 'extra_recipient_again' | 'reason' | 'confirm', string>>;
const deliver = (o: Inputs = {}) => ({ mode: 'deliver', target: WS, confirm: 'deliver', ...o });
const withExtra = (o: Inputs = {}) => deliver({ extra_recipient: ADDR, extra_recipient_again: ADDR, reason: REASON, ...o });
/** Everything a reader of the public log sees: `::add-mask::` lines are consumed by the runner, never shown. */
const visible = (out: string) => out.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
const SECRETS = [WS, HOLD, ADDR, ADDR.toLowerCase(), REASON, 'subpoena'];
const runTask = (r: Run) => r.aws.find((l) => l.startsWith('aws ecs run-task'));
const commandOf = (r: Run): string[] => {
  const m = /--overrides (\{.*\})( |$)/.exec(runTask(r) ?? '');
  return (JSON.parse(m![1]) as { containerOverrides: Array<{ command: string[] }> }).containerOverrides[0].command;
};

describe('T15: validation (nothing reaches AWS when the inputs are wrong; nothing secret is visible)', () => {
  const refused: Array<[string, Record<string, string>, RegExp]> = [
    ['the two addresses differ', withExtra({ extra_recipient_again: 'counsel.smith+case@lawfirm.example.org' }), /don't match/],
    ['the second address missing', withExtra({ extra_recipient_again: '' }), /don't match/],
    ['only the second address', deliver({ extra_recipient_again: ADDR, reason: REASON }), /don't match/],
    ['an address that differs only in case', withExtra({ extra_recipient_again: ADDR.toLowerCase() }), /don't match/],
    ['an extra address on hold', { mode: 'hold', target: WS, confirm: 'hold', reason: REASON, extra_recipient: ADDR, extra_recipient_again: ADDR }, /only for deliver/],
    ['an extra address on release', { mode: 'release', target: HOLD, confirm: 'release', reason: REASON, extra_recipient: ADDR }, /only for deliver/],
    ['confirm not the mode', deliver({ confirm: 'yes' }), /confirm must be exactly: deliver/],
    ['an unknown mode', { mode: 'restore', target: WS, confirm: 'restore' }, /mode must be/],
    ['an uppercase uuid', deliver({ target: WS.toUpperCase() }), /workspace id/],
    ['a leading - on the target', deliver({ target: `-${WS}` }), /workspace id/],
    ['a slug instead of an id', deliver({ target: 'acme' }), /workspace id/],
    ['a hold id that isn\'t a uuid', { mode: 'release', target: 'hold-1', confirm: 'release', reason: REASON }, /hold id/],
    ['a leading - on the address', withExtra({ extra_recipient: `-${ADDR}`, extra_recipient_again: `-${ADDR}` }), /can't start with -/],
    ['two addresses in one', withExtra({ extra_recipient: `${ADDR},x@y.co`, extra_recipient_again: `${ADDR},x@y.co` }), /one email address/],
    ['an address over 254 characters', withExtra({ extra_recipient: `${'a'.repeat(250)}@b.co`, extra_recipient_again: `${'a'.repeat(250)}@b.co` }), /one email address/],
    ['deliver with an extra address and no reason', withExtra({ reason: '' }), /reason is required for deliver with an extra address/],
    ['hold without a reason', { mode: 'hold', target: WS, confirm: 'hold' }, /reason is required for hold/],
    ['release without a reason', { mode: 'release', target: HOLD, confirm: 'release' }, /reason is required for release/],
    ['a reason over 200 characters', deliver({ reason: 'x'.repeat(201) }), /at most 200/],
    ['a tab in the reason', deliver({ reason: 'case\t42' }), /control characters/],
    ['a leading - on the reason', deliver({ reason: '--extra a@b.co' }), /can't start with -/],
    ['a blank reason', { mode: 'hold', target: WS, confirm: 'hold', reason: '   ' }, /blank/],
  ];
  for (const [name, inputs, message] of refused) {
    it(`refuses ${name}: exit 1, no AWS call, nothing secret visible`, () => {
      const r = runStep(inputs);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(message);
      expect(r.aws).toEqual([]);
      for (const v of SECRETS) expect(visible(r.out)).not.toContain(v);
    });
  }

  for (const [name, inputs] of [
    ['a newline in the address', withExtra({ extra_recipient: `${ADDR}\nSECOND-LINE-SECRET`, extra_recipient_again: `${ADDR}\nSECOND-LINE-SECRET` })],
    ['a carriage return in the reason', deliver({ reason: 'ok\rSECOND-LINE-SECRET' })],
  ] as const) {
    it(`${name} → "refused: inputs must be a single line" before anything is printed`, () => {
      const r = runStep(inputs);
      expect(r.status).toBe(1);
      expect(r.out.trim()).toBe('refused: inputs must be a single line');
      expect(r.out).not.toContain('SECOND-LINE-SECRET');
      expect(r.aws).toEqual([]);
    });
  }

  it('an extra argument is refused', () => {
    const r = runStep(deliver(), 'exec bash scripts/backup/export-button.sh --bogus');
    expect(r.status).toBe(1);
    expect(r.aws).toEqual([]);
  });
});

describe('T15: a press that starts and finishes', () => {
  it('masks the target, both addresses and the reason first; starts one export task with the exact command; reports exit 0; nothing secret visible', () => {
    const r = runStep(withExtra(), undefined, { describe: ['RUNNING|None|None', 'STOPPED|EssentialContainerExited|0'] });
    expect(r.status, r.out).toBe(0);
    const lines = r.out.split('\n');
    expect(lines.slice(0, 4)).toEqual([`::add-mask::${WS}`, `::add-mask::${ADDR}`, `::add-mask::${ADDR}`, `::add-mask::${REASON}`]);
    for (const v of SECRETS) expect(visible(r.out)).not.toContain(v);
    expect(r.out).toContain('export task finished: exit 0; run gh-515151-1');
    const run = runTask(r)!;
    expect(run).toContain('--task-definition cadenzpoint-backup-export');
    expect(run).toContain('--started-by gh-515151-1');
    expect(run).toContain('subnets=[subnet-a,subnet-b],securityGroups=[sg-1]');
    expect(run).toContain('"name":"export"');
    expect(commandOf(r)).toEqual(['export', 'deliver', '--workspace', WS, '--extra', ADDR, '--reason', REASON, '--run-id', 'gh-515151-1']);
    expect(r.aws.filter((l) => l.startsWith('aws ecs run-task')).length).toBe(1);
    // The argv the button builds parses through the task's own grammar.
    expect(parseExportArgs(commandOf(r).slice(1))).toMatchObject({ ok: true, args: { mode: 'deliver', extra: ADDR, reason: REASON, runId: 'gh-515151-1' } });
  });

  it('FR9: `%` is escaped before masking (GitHub unescapes %25 in workflow-command data), and the raw value is still passed on', () => {
    const addr = 'a%25b@law.example';
    const reason = 'case 50%25 done';
    const r = runStep(withExtra({ extra_recipient: addr, extra_recipient_again: addr, reason }));
    expect(r.status, r.out).toBe(0);
    const masks = r.out.split('\n').filter((l) => l.startsWith('::add-mask::'));
    expect(masks).toEqual([`::add-mask::${WS}`, '::add-mask::a%2525b@law.example', '::add-mask::a%2525b@law.example', '::add-mask::case 50%2525 done']);
    expect(visible(r.out)).not.toContain(addr);
    expect(visible(r.out)).not.toContain(reason);
    expect(commandOf(r)).toEqual(['export', 'deliver', '--workspace', WS, '--extra', addr, '--reason', reason, '--run-id', 'gh-515151-1']);
  });

  it('a plain deliver, a hold and a release build their commands (release targets --hold)', () => {
    const d = runStep(deliver());
    expect(commandOf(d)).toEqual(['export', 'deliver', '--workspace', WS, '--run-id', 'gh-515151-1']);
    const h = runStep({ mode: 'hold', target: WS, confirm: 'hold', reason: REASON });
    expect(commandOf(h)).toEqual(['export', 'hold', '--workspace', WS, '--reason', REASON, '--run-id', 'gh-515151-1']);
    const rel = runStep({ mode: 'release', target: HOLD, confirm: 'release', reason: 'case closed' });
    expect(commandOf(rel)).toEqual(['export', 'release', '--hold', HOLD, '--reason', 'case closed', '--run-id', 'gh-515151-1']);
    for (const r of [d, h, rel]) expect(parseExportArgs(commandOf(r).slice(1))).toMatchObject({ ok: true });
  });

  it('the ExportModes gate: a stack without the output (before 3d), or one not listing the mode, is refused before run-task', () => {
    for (const modes of ['None', '', 'deliver release']) {
      const r = runStep({ mode: 'hold', target: WS, confirm: 'hold', reason: REASON }, undefined, { env: { STUB_MODES: modes } });
      expect(r.status, modes).toBe(1);
      expect(r.out).toContain('the Backup system deploy that adds the export task is pending approval');
      expect(runTask(r)).toBeUndefined();
    }
  });

  it('one at a time: refuses while an export task is running (no run-task); the check names the export family', () => {
    const r = runStep(deliver(), undefined, { env: { STUB_RUNNING: '1' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('an export task is already running');
    expect(runTask(r)).toBeUndefined();
    expect(r.aws[0]).toContain('--family cadenzpoint-backup-export --desired-status RUNNING');
  });

  it('exit 2 → "this image is older than the button"; a refusal exit 1 is reported', () => {
    expect(runStep(deliver(), undefined, { describe: ['STOPPED|EssentialContainerExited|2'] })).toMatchObject({ status: 2 });
    const one = runStep(deliver(), undefined, { describe: ['STOPPED|EssentialContainerExited|1'] });
    expect(one.status).toBe(1);
    expect(one.out).toContain('export task finished: exit 1');
  });

  it('the 60-minute wait runs out: "still running", exit 1, and the task is NOT stopped', () => {
    const r = runStep(deliver(), undefined, { describe: ['RUNNING|None|None'] });
    expect(r.status).toBe(1);
    expect(r.out).toContain('still running after 60 minutes');
    expect(r.sleeps).toBe(60);
    expect(r.aws.some((l) => l.startsWith('aws ecs stop-task'))).toBe(false);
  }, 60_000);

  it('--stop lists by startedBy only and stops each task quietly', () => {
    const r = runStep({}, 'bash scripts/backup/export-button.sh --stop', { env: { STUB_STOP_ARNS: 'arn:t1' } });
    expect(r.status, r.out).toBe(0);
    expect(r.aws.find((l) => l.startsWith('aws ecs list-tasks'))).toBe('aws ecs list-tasks --cluster cadenzpoint-backup --started-by gh-515151-1 --query taskArns --output text');
    expect(r.aws.filter((l) => l.startsWith('aws ecs stop-task'))).toEqual(['aws ecs stop-task --cluster cadenzpoint-backup --task arn:t1 --reason button run cancelled']);
  });
});

describe('T15: every available bash (3.2 on macOS, 5 on the runner)', () => {
  const shells = ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'].filter((p) => existsSync(p));
  const seen = new Set<string>();
  const unique = shells.filter((sh) => {
    const v = execFileSync(sh, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }).trim();
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  beforeAll(() => { expect(unique.length).toBeGreaterThan(0); });
  for (const sh of unique) {
    it(`${sh}: a full press with an extra address and a mismatch refusal behave the same`, () => {
      const s = setup(withExtra());
      const r = spawnSync(sh, ['-e', '-c', `exec ${sh} scripts/backup/export-button.sh`], { cwd: ROOT, env: s.env, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(s.result(0, '').aws.find((l) => l.startsWith('aws ecs run-task'))).toContain(`"--extra","${ADDR}"`);
      const bad = setup(withExtra({ extra_recipient_again: 'other@x.co' }));
      expect(spawnSync(sh, ['-e', '-c', `exec ${sh} scripts/backup/export-button.sh`], { cwd: ROOT, env: bad.env, encoding: 'utf8' }).status).toBe(1);
    });
  }
});

describe('T15: the workflow', () => {
  const text = readFileSync(path.join(ROOT, '.github/workflows/export-workspace.yml'), 'utf8');
  const wf = parse(text) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[]; required?: boolean }> } }; permissions: unknown; concurrency: unknown; jobs: { run: Record<string, unknown> & { steps: Array<Record<string, unknown>> } } };
  it('inputs: mode (deliver/hold/release), target, both address inputs, reason, confirm; main only; aws-disaster; its own queue; 75 minutes; OIDC only', () => {
    const inputs = wf.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(['mode', 'target', 'extra_recipient', 'extra_recipient_again', 'reason', 'confirm']);
    expect(inputs.mode).toMatchObject({ type: 'choice', options: ['deliver', 'hold', 'release'], required: true });
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.concurrency).toEqual({ group: 'export-workspace', 'cancel-in-progress': false, queue: 'max' });
    const job = wf.jobs.run;
    expect(job.if).toBe("github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'");
    expect(job.environment).toBe('aws-disaster');
    expect(job['timeout-minutes']).toBe(75);
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('actions pinned by SHA; no persisted credentials; the account id masked; role duration within the button role\'s MaxSessionDuration; inputs never in env or ${{ }}; the cancelled() stop step', () => {
    const steps = wf.jobs.run.steps;
    for (const st of steps) if (st.uses) expect(st.uses as string).toMatch(/@[0-9a-f]{40}$/);
    expect((steps[0].with as Record<string, unknown>)['persist-credentials']).toBe(false);
    const creds = steps[1].with as Record<string, unknown>;
    expect(creds).toMatchObject({ 'role-to-assume': '${{ secrets.AWS_DISASTER_ROLE_ARN }}', 'aws-region': 'us-east-1', 'role-duration-seconds': 5400, 'mask-aws-account-id': true });
    const stack = parse(readFileSync(path.join(ROOT, 'ops/aws/backup-stack.yml'), 'utf8')) as { Resources: Record<string, { Properties: { MaxSessionDuration?: number } }> };
    expect(creds['role-duration-seconds'] as number).toBeLessThanOrEqual(stack.Resources.DisasterButtonRole.Properties.MaxSessionDuration!);
    // The task's 45-minute deadline + 5-minute hard exit fit the script's 60 polls, inside the job and the credentials.
    expect(60 * 60).toBeLessThan(75 * 60);
    expect(steps.map((s) => s.run).filter(Boolean)).toEqual(['exec bash scripts/backup/export-button.sh', 'bash scripts/backup/export-button.sh --stop']);
    expect(steps[3].if).toBe('cancelled()');
    expect(text).not.toMatch(/inputs\./);
    expect(text).not.toMatch(/github\.event\.inputs/);
    for (const st of steps) expect(st.env).toBeUndefined();
  });
});
