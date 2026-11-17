import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * feature-plan-database-backups.md §11 S22: scripts/backup/deploy.sh with stub `aws` and `docker` on PATH. Each stack
 * state takes its documented path; a retained bucket (403) stops; an absent one (404) proceeds; an existing image tag is
 * reused (no push). Nothing prints the account id or the email.
 */
const ROOT = path.resolve(__dirname, '../../..');
let stubs: string;

beforeAll(() => {
  stubs = mkdtempSync(path.join(tmpdir(), 'cpbk-aws-'));
  // aws: answers from STUB_* env; logs every call (args) to $STUB_LOG; remembers a pushed image in $STUB_STATE.
  writeFileSync(path.join(stubs, 'aws'), `#!/bin/bash
echo "aws $*" >> "$STUB_LOG"
case "$1 $2" in
  "cloudformation describe-stacks")
    if [ -f "$STUB_STATE.deployed" ]; then echo UPDATE_COMPLETE; exit 0; fi
    if [ "$STUB_STACK" = "NONE" ]; then echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id cadenzpoint-backup does not exist" >&2; exit 254; fi
    if [ "$STUB_STACK" = "ERROR" ]; then echo "An error occurred (AccessDenied) for arn:aws:iam::111122223333:role/x" >&2; exit 254; fi
    echo "$STUB_STACK" ;;
  "sts get-caller-identity") echo 111122223333 ;;
  "s3api head-bucket")
    case "$STUB_BUCKET" in
      404) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
      403) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
      *) echo "Could not connect to the endpoint URL" >&2; exit 255 ;;
    esac ;;
  "ecr describe-images")
    if [ "$STUB_IMAGE" = "exists" ] || [ -f "$STUB_STATE.pushed" ]; then echo "sha256:$(printf 'a%.0s' $(seq 1 64))"; exit 0; fi
    echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2; exit 254 ;;
  "cloudformation deploy") touch "$STUB_STATE.deployed" ;;
  *) ;;
esac
exit 0
`);
  writeFileSync(path.join(stubs, 'docker'), `#!/bin/bash
echo "docker $*" >> "$STUB_LOG"
[ "$1" = "push" ] && touch "$STUB_STATE.pushed"
exit 0
`);
  chmodSync(path.join(stubs, 'aws'), 0o755);
  chmodSync(path.join(stubs, 'docker'), 0o755);
});

function run(env: Record<string, string>) {
  const work = mkdtempSync(path.join(tmpdir(), 'cpbk-deploy-'));
  const log = path.join(work, 'calls.log');
  const state = path.join(work, 'state');
  writeFileSync(log, '');
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/backup/deploy.sh')], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:/usr/bin:/bin`, HOME: work, STUB_LOG: log, STUB_STATE: state, STUB_BUCKET: '404', STUB_IMAGE: 'missing',
      REPOSITORY_URI: '111122223333.dkr.ecr.us-east-1.amazonaws.com/cadenzpoint-backup', ARTIFACTS_BUCKET: 'artifacts-x', ALERT_EMAIL: 'founder@example.com',
      CFN_EXEC_ROLE_ARN: 'arn:aws:iam::111122223333:role/cadenzpoint-bootstrap/cadenzpoint-backup-cfn', GITHUB_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  const calls = readFileSync(log, 'utf8');
  const pushed = existsSync(`${state}.pushed`);
  rmSync(work, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls, pushed };
}

describe('S22: deploy.sh', () => {
  it('no stack, bucket absent (404) → pushes the image, validates, deploys, reports the status; never prints the account id or email', () => {
    const r = run({ STUB_STACK: 'NONE' });
    expect(r.code).toBe(0);
    expect(r.pushed).toBe(true);
    expect(r.calls).toMatch(/cloudformation validate-template --template-url https:\/\/artifacts-x\.s3\.us-east-1\.amazonaws\.com\/templates\/abcdef0123456789abcdef0123456789abcdef01\/backup-stack\.yml/);
    expect(r.calls).toMatch(/cloudformation deploy --stack-name cadenzpoint-backup .*--role-arn arn:aws:iam::111122223333:role\/cadenzpoint-bootstrap\/cadenzpoint-backup-cfn .*ImageUri=111122223333\.dkr\.ecr\.us-east-1\.amazonaws\.com\/cadenzpoint-backup@sha256:a{64} .*--capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset/);
    expect(r.stdout).toContain('deployed abcdef0: UPDATE_COMPLETE');
    const printed = r.stdout.replace(/::add-mask::[^\n]*/g, '') + r.stderr;
    expect(printed).not.toContain('111122223333');
    expect(printed).not.toContain('founder@example.com');
    expect(r.stdout).toContain('::add-mask::founder@example.com');
  });

  it('REVIEW_IN_PROGRESS (a failed first change set) → proceeds like a new stack', () => {
    const r = run({ STUB_STACK: 'REVIEW_IN_PROGRESS' });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('cloudformation deploy');
  });

  it('ROLLBACK_COMPLETE → stops with "delete the empty stack, then re-run"', () => {
    const r = run({ STUB_STACK: 'ROLLBACK_COMPLETE' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('The first create failed and rolled back. In the AWS console, delete the stack `cadenzpoint-backup` (it holds nothing), then re-run this workflow.');
    expect(r.calls).not.toContain('cloudformation deploy');
  });

  it('UPDATE_ROLLBACK_FAILED → continue-update-rollback, then stops', () => {
    const r = run({ STUB_STACK: 'UPDATE_ROLLBACK_FAILED' });
    expect(r.code).toBe(1);
    expect(r.calls).toMatch(/cloudformation continue-update-rollback --stack-name cadenzpoint-backup --role-arn /);
    expect(r.calls).not.toContain('cloudformation deploy');
  });

  it('ROLLBACK_FAILED and DELETE_FAILED → the runbook line; any *_IN_PROGRESS → "another operation is running"', () => {
    expect(run({ STUB_STACK: 'ROLLBACK_FAILED' }).stderr).toContain("'Stack stuck in ROLLBACK_FAILED'");
    expect(run({ STUB_STACK: 'DELETE_FAILED' }).stderr).toContain("'Stack stuck in DELETE_FAILED'");
    const r = run({ STUB_STACK: 'UPDATE_IN_PROGRESS' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Another stack operation is running (UPDATE_IN_PROGRESS)');
  });

  it('no stack but the retained bucket exists (403) → stops with the re-create runbook; an unexpected head-bucket error stops too', () => {
    const r = run({ STUB_STACK: 'NONE', STUB_BUCKET: '403' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Follow the runbook 'Re-create the backup stack'");
    expect(r.calls).not.toContain('cloudformation deploy');
    expect(run({ STUB_STACK: 'NONE', STUB_BUCKET: 'other' }).code).toBe(1);
  });

  it('an existing image tag is reused (a re-run for the same commit): no push', () => {
    const r = run({ STUB_STACK: 'UPDATE_COMPLETE', STUB_IMAGE: 'exists' });
    expect(r.code).toBe(0);
    expect(r.pushed).toBe(false);
    expect(r.calls).not.toMatch(/docker push/);
    expect(r.stdout).toContain('already pushed; reusing it');
  });

  it('a describe-stacks error other than "does not exist" stops without echoing it', () => {
    const r = run({ STUB_STACK: 'ERROR' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Could not read the stack state');
    expect(r.stderr).not.toContain('111122223333');
  });
});
