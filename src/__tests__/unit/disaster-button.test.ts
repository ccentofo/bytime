import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDisasterArgs, taskRunId } from '../../../scripts/backup/disaster';

/**
 * feature-plan-disaster-restore.md §11 D2: scripts/backup/disaster-button.sh run as GitHub runs a `run:` step (`bash -e`
 * on a file holding the step's text), with a stub `aws` and `sleep` first on PATH and a workflow_dispatch event file.
 * The real jq. Each available bash runs it (3.2 on macOS; 5 on the CI runner). Plus parseDisasterArgs, the one grammar.
 */

const ROOT = path.resolve(__dirname, '../../..');
const A = '0a1b2c3d-1111-4222-8333-444455556666';
const B = '9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff';

const STUB_AWS = `#!/bin/bash
echo "aws $*" >> "$STUB_DIR/aws.log"
case "$1 $2" in
  "ecs list-tasks")
    case " $* " in
      *" --started-by "*) echo "\${STUB_STOP_ARNS-arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/t1}" ;;
      *) echo "\${STUB_RUNNING:-0}" ;;
    esac ;;
  "cloudformation describe-stacks")
    case "$*" in *TaskSubnets*) echo "subnet-a,subnet-b" ;; *) echo "sg-1" ;; esac ;;
  "ecs run-task")
    printf '%s\\t%s\\t%s\\n' "\${STUB_TASK-arn:aws:ecs:us-east-1:1:task/cadenzpoint-backup/t1}" "\${STUB_FAILURES:-0}" "\${STUB_REASON:-None}" ;;
  "ecs describe-tasks")
    n=$(cat "$STUB_DIR/describe.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/describe.n"
    line=$(sed -n "\${n}p" "$STUB_DIR/describe.txt" 2>/dev/null)
    [ -z "$line" ] && line=$(tail -n 1 "$STUB_DIR/describe.txt")
    if [ "$line" = FAIL ]; then echo "An error occurred (ThrottlingException)" >&2; exit 255; fi
    printf '%s\\n' "$line" | tr '|' '\\t' ;;
  "ecs stop-task") echo '{"task":{"taskArn":"x"}}' ;;
  *) echo "unexpected aws call" >&2; exit 3 ;;
esac
`;
const STUB_SLEEP = '#!/bin/bash\necho "sleep $*" >> "$STUB_DIR/sleep.log"\n[ -n "$STUB_SLEEP" ] && /bin/sleep "$STUB_SLEEP"\nexit 0\n';

interface Run { status: number | null; out: string; aws: string[]; sleeps: number }

function setup(inputs: Record<string, string>, o: { describe?: string[]; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dr-btn-'));
  writeFileSync(path.join(dir, 'aws'), STUB_AWS);
  writeFileSync(path.join(dir, 'sleep'), STUB_SLEEP);
  chmodSync(path.join(dir, 'aws'), 0o755);
  chmodSync(path.join(dir, 'sleep'), 0o755);
  writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ inputs }));
  writeFileSync(path.join(dir, 'describe.txt'), (o.describe ?? ['STOPPED|EssentialContainerExited|0']).join('\n') + '\n');
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? '/tmp', STUB_DIR: dir,
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: '2', ...o.env,
  } as unknown as NodeJS.ProcessEnv;
  const result = (status: number | null, out: string): Run => ({
    status, out,
    aws: existsSync(path.join(dir, 'aws.log')) ? readFileSync(path.join(dir, 'aws.log'), 'utf8').trim().split('\n') : [],
    sleeps: existsSync(path.join(dir, 'sleep.log')) ? readFileSync(path.join(dir, 'sleep.log'), 'utf8').trim().split('\n').length : 0,
  });
  return { dir, env, result };
}

/** The workflow step, run like GitHub: `bash -e <file>` where the file holds the step's `run:` text. */
function runStep(inputs: Record<string, string>, stepText = 'exec bash scripts/backup/disaster-button.sh', o: Parameters<typeof setup>[1] = {}): Run {
  const s = setup(inputs, o);
  const block = path.join(s.dir, 'step.sh');
  writeFileSync(block, stepText + '\n');
  const r = spawnSync('bash', ['-e', block], { cwd: ROOT, env: s.env, encoding: 'utf8', timeout: 60_000 });
  return s.result(r.status, (r.stdout ?? '') + (r.stderr ?? ''));
}

const ok = (o: Partial<Record<'mode' | 'targets' | 'override' | 'confirm', string>> = {}) => ({ mode: 'workspace', targets: A, override: 'none', confirm: 'workspace', ...o });
/** Everything a reader of the public log sees: `::add-mask::` lines are consumed by the runner, never shown. */
const visible = (out: string) => out.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');

describe('D2: disaster-button.sh validation (nothing reaches AWS when the inputs are wrong)', () => {
  const refused: Array<[string, Record<string, string>]> = [
    ['an unknown mode', ok({ mode: 'restore', confirm: 'restore' })],
    ['a wrong confirm', ok({ confirm: 'yes' })],
    ['the override without its typed confirmation', ok({ override: 'unreachable-4h' })],
    ['an uppercase uuid', ok({ targets: A.toUpperCase() })],
    ['a leading -', ok({ targets: `-${A}` })],
    ['a slug instead of an id', ok({ targets: 'acme' })],
    ['spaces around ids', ok({ targets: `${A}, ${B}` })],
    ['51 ids', ok({ targets: Array.from({ length: 51 }, () => A).join(',') })],
    ['all-lost with rehearse', ok({ mode: 'rehearse', confirm: 'rehearse', targets: 'all-lost' })],
    ['all-lost with the override', ok({ targets: 'all-lost', override: 'unreachable-4h', confirm: 'workspace unreachable-4h' })],
    ['rehearse with two ids', ok({ mode: 'rehearse', confirm: 'rehearse', targets: `${A},${B}` })],
    ['canary with workspace', ok({ override: 'canary' })],
    ['unreachable-4h with rehearse', ok({ mode: 'rehearse', confirm: 'workspace unreachable-4h', override: 'unreachable-4h' })],
    ['auto from the button', ok({ mode: 'rehearse', confirm: 'rehearse', targets: 'auto' })],
  ];
  for (const [name, inputs] of refused) {
    it(`refuses ${name}: exit 1, no AWS call, no target in the visible log`, () => {
      const r = runStep(inputs);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain('refused:');
      expect(r.aws).toEqual([]);
      for (const id of [A, B, A.toUpperCase()]) expect(visible(r.out)).not.toContain(id);
    });
  }

  it('an extra argument is refused', () => {
    const r = runStep(ok(), 'exec bash scripts/backup/disaster-button.sh --bogus');
    expect(r.status).toBe(1);
    expect(r.aws).toEqual([]);
  });
});

describe('D2: a press that starts and finishes', () => {
  it('masks every target first, starts one task with the run id, removes duplicates, waits, reports exit 0; no target text in the visible log', () => {
    const r = runStep(ok({ targets: `${A},${B},${A}` }), undefined, { describe: ['RUNNING|None|None', 'STOPPED|EssentialContainerExited|0'] });
    expect(r.status, r.out).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe(`::add-mask::${A},${B},${A}`);
    expect(lines.slice(1, 4)).toEqual([`::add-mask::${A}`, `::add-mask::${B}`, `::add-mask::${A}`]);
    for (const id of [A, B]) expect(visible(r.out)).not.toContain(id);
    expect(r.out).toContain('disaster task finished: exit 0; run gh-424242-2; results emailed and in the digest');
    const run = r.aws.find((l) => l.startsWith('aws ecs run-task'))!;
    expect(run).toContain('--started-by gh-424242-2');
    expect(run).toContain('--task-definition cadenzpoint-backup-disaster');
    expect(run).toContain('assignPublicIp=ENABLED');
    expect(run).toContain('subnets=[subnet-a,subnet-b],securityGroups=[sg-1]');
    expect(run).toContain(`"command":["disaster","workspace","--targets","${A},${B}","--override","none","--run-id","gh-424242-2"]`);
    expect(run).toContain('"name":"disaster"');
    expect(r.aws.filter((l) => l.startsWith('aws ecs run-task')).length).toBe(1);
    expect(r.aws.some((l) => l.includes(' wait '))).toBe(false); // no `aws ecs wait`
  });

  it('the override press passes unreachable-4h with its typed confirmation', () => {
    const r = runStep(ok({ override: 'unreachable-4h', confirm: 'workspace unreachable-4h' }));
    expect(r.status, r.out).toBe(0);
    expect(r.aws.find((l) => l.startsWith('aws ecs run-task'))).toContain('"--override","unreachable-4h"');
  });

  it('a rehearse with the canary', () => {
    const r = runStep(ok({ mode: 'rehearse', confirm: 'rehearse', override: 'canary' }));
    expect(r.status, r.out).toBe(0);
    expect(r.aws.find((l) => l.startsWith('aws ecs run-task'))).toContain(`"command":["disaster","rehearse","--targets","${A}","--override","canary"`);
  });

  it('refuses while a disaster task is running (no run-task)', () => {
    const r = runStep(ok(), undefined, { env: { STUB_RUNNING: '1' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('a disaster task is already running');
    expect(r.aws.some((l) => l.startsWith('aws ecs run-task'))).toBe(false);
    expect(r.aws[0]).toContain('--family cadenzpoint-backup-disaster --desired-status RUNNING');
  });

  it('a run-task failure → "the task didn\'t start", exit 1', () => {
    const r = runStep(ok(), undefined, { env: { STUB_TASK: 'None', STUB_FAILURES: '1', STUB_REASON: 'RESOURCE:MEMORY' } });
    expect(r.status).toBe(1);
    expect(r.out).toContain("the task didn't start: RESOURCE:MEMORY");
  });

  it('the describe loop survives a failed call', () => {
    const r = runStep(ok(), undefined, { describe: ['FAIL', 'FAIL', 'RUNNING|None|None', 'STOPPED|EssentialContainerExited|1'] });
    expect(r.status).toBe(1);
    expect(r.out).toContain('disaster task finished: exit 1');
    expect(r.aws.filter((l) => l.startsWith('aws ecs describe-tasks')).length).toBe(4);
  });

  it('a null exit code → "the task didn\'t start: <stopCode>", exit 1', () => {
    const r = runStep(ok(), undefined, { describe: ['STOPPED|TaskFailedToStart|None'] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("the task didn't start: TaskFailedToStart");
  });

  it('exit 2 → "this image is older than the button"', () => {
    const r = runStep(ok(), undefined, { describe: ['STOPPED|EssentialContainerExited|2'] });
    expect(r.status).toBe(2);
    expect(r.out).toContain('this image is older than the button: approve the pending Backup system deploy, then press again');
  });

  it('the 340-minute wait runs out: "still running", exit 1, and the task is NOT stopped (no EXIT trap)', () => {
    const r = runStep(ok(), undefined, { describe: ['RUNNING|None|None'] });
    expect(r.status).toBe(1);
    expect(r.out).toContain('still running after 340 minutes');
    expect(r.sleeps).toBe(340);
    expect(r.aws.some((l) => l.startsWith('aws ecs stop-task'))).toBe(false);
  }, 120_000);
});

describe('D2: stopping', () => {
  it('--stop lists by startedBy only (no other filter) and stops each task quietly', () => {
    const r = runStep({}, 'bash scripts/backup/disaster-button.sh --stop', { env: { STUB_STOP_ARNS: 'arn:t1\tarn:t2' } });
    expect(r.status, r.out).toBe(0);
    const list = r.aws.find((l) => l.startsWith('aws ecs list-tasks'))!;
    expect(list).toBe('aws ecs list-tasks --cluster cadenzpoint-backup --started-by gh-424242-2 --query taskArns --output text');
    expect(r.aws.filter((l) => l.startsWith('aws ecs stop-task'))).toEqual([
      'aws ecs stop-task --cluster cadenzpoint-backup --task arn:t1 --reason button run cancelled',
      'aws ecs stop-task --cluster cadenzpoint-backup --task arn:t2 --reason button run cancelled',
    ]);
    expect(r.out).not.toContain('taskArn'); // stop-task output goes to /dev/null
  });

  it('--stop retries the listing 3 times (a just-started task may not be listed yet)', () => {
    const r = runStep({}, 'bash scripts/backup/disaster-button.sh --stop', { env: { STUB_STOP_ARNS: '' } });
    expect(r.status).toBe(0);
    expect(r.aws.filter((l) => l.startsWith('aws ecs list-tasks')).length).toBe(3);
    expect(r.out).toContain('no running disaster task from this run');
  });

  it('SIGINT to the step (GitHub\'s cancel) stops the task through the INT trap', async () => {
    const s = setup(ok(), { describe: ['RUNNING|None|None'], env: { STUB_SLEEP: '0.2' } });
    const block = path.join(s.dir, 'step.sh');
    writeFileSync(block, 'exec bash scripts/backup/disaster-button.sh\n');
    const child = spawn('bash', ['-e', block], { cwd: ROOT, env: s.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    for (let i = 0; i < 100 && !out.includes('disaster task started'); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGINT'); // `exec` made the script the step's entry process
    const code = await exited;
    expect(code).toBe(130);
    expect(out).toContain('cancel received: stopping the task');
    expect(s.result(code, out).aws.some((l) => l.startsWith('aws ecs stop-task'))).toBe(true);
  }, 30_000);
});

describe('D2: every available bash (3.2 on macOS, 5 on the runner)', () => {
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
    it(`${sh}: a full press and a refusal behave the same`, () => {
      const s = setup(ok({ targets: `${A},${A}` }));
      const r = spawnSync(sh, ['-e', '-c', `exec ${sh} scripts/backup/disaster-button.sh`], { cwd: ROOT, env: s.env, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(s.result(0, '').aws.find((l) => l.startsWith('aws ecs run-task'))).toContain(`"--targets","${A}","--override"`);
      const bad = setup(ok({ confirm: 'nope' }));
      expect(spawnSync(sh, ['-e', '-c', `exec ${sh} scripts/backup/disaster-button.sh`], { cwd: ROOT, env: bad.env, encoding: 'utf8' }).status).toBe(1);
    });
  }
});

describe('D2: parseDisasterArgs (the one argv grammar)', () => {
  const now = new Date('2026-12-01T15:17:00Z');
  it('workspace takes ids (deduplicated) or all-lost, override none/unreachable-4h; rehearse one id or auto, override none/canary', () => {
    expect(parseDisasterArgs(['workspace', '--targets', `${A},${B},${A}`, '--run-id', 'gh-1-1'], now)).toEqual({ ok: true, args: { mode: 'workspace', targets: [A, B], override: 'none', runId: 'gh-1-1' } });
    expect(parseDisasterArgs(['workspace', '--targets', 'all-lost'], now)).toMatchObject({ ok: true, args: { targets: 'all-lost' } });
    expect(parseDisasterArgs(['workspace', '--targets', A, '--override', 'unreachable-4h'], now)).toMatchObject({ ok: true, args: { override: 'unreachable-4h' } });
    expect(parseDisasterArgs(['rehearse', '--targets', 'auto'], now)).toEqual({ ok: true, args: { mode: 'rehearse', targets: 'auto', override: 'none', runId: 'task-20261201T151700Z' } });
    expect(parseDisasterArgs(['rehearse', '--targets', A, '--override', 'canary'], now)).toMatchObject({ ok: true, args: { override: 'canary' } });
  });
  it('auto and canary only with rehearse; all-lost only with workspace and no override; strict uuids; one id for rehearse', () => {
    for (const argv of [
      ['workspace', '--targets', 'auto'], ['workspace', '--targets', A, '--override', 'canary'], ['rehearse', '--targets', 'all-lost'],
      ['workspace', '--targets', 'all-lost', '--override', 'unreachable-4h'], ['workspace', '--targets', A.toUpperCase()],
      ['rehearse', '--targets', `${A},${B}`], ['rehearse', '--targets', A, '--override', 'unreachable-4h'], ['workspace'], ['bogus', '--targets', A],
      ['workspace', '--targets', A, '--run-id', 'bad id!'], ['workspace', 'extra', '--targets', A],
    ]) expect(parseDisasterArgs(argv, now), argv.join(' ')).toMatchObject({ ok: false, exitCode: 1 });
  });
  it('an unknown flag → exit 2 (reserved: "image older than the button")', () => {
    expect(parseDisasterArgs(['workspace', '--targets', A, '--new-flag', 'x'], now)).toMatchObject({ ok: false, exitCode: 2 });
  });
  it('a generated run id when none is passed', () => {
    expect(taskRunId(now)).toBe('task-20261201T151700Z');
  });
});
