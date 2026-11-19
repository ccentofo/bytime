import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { expectedDocuments, NAMES, ALL_ROLES, DISASTER_BUTTON_ROLE, DISASTER_OIDC_SUBJECT, PROTECTION_EVENTS, taskRoleName, execRoleName, SCHEDULER_ROLE, type Statement } from '../../../scripts/backup/lib/expected-policies';
import { parseDisasterArgs } from '../../../scripts/backup/disaster';

/**
 * feature-plan-disaster-restore.md §11 D7: static checks on the disaster additions to the backup stack, the button
 * workflow and deploy-prod.yml (U6 already checks that every role, rule and protection document equals
 * expected-policies.ts, which this item extends).
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
type Node = Record<string, unknown>;
const ACCT = '111122223333';
const KEY_ARN = `arn:aws:kms:us-east-1:${ACCT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
const stack = parse(read('ops/aws/backup-stack.yml')) as { Resources: Record<string, { Type: string; Properties: Node; DependsOn?: string[] }>; Outputs: Record<string, Node> };
const boot = parse(read('ops/aws/bootstrap.yml')) as typeof stack;
const EXPORT_KEY_ARN = `arn:aws:kms:us-east-1:${ACCT}:key/5678efab-12ab-34cd-56ef-1234567890ab`;
const exp = expectedDocuments({ accountId: ACCT, keyArn: KEY_ARN, exportKeyArn: EXPORT_KEY_ARN });

function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === 'object') {
    const o = v as Node;
    if ('Fn::Sub' in o && typeof o['Fn::Sub'] === 'string') return (o['Fn::Sub'] as string).replace(/\$\{AWS::AccountId\}/g, ACCT);
    if ('Ref' in o && o.Ref === 'AWS::AccountId') return ACCT;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
}
const ofType = (type: string) => Object.entries(stack.Resources).filter(([, r]) => r.Type === type);
const role = (name: string) => ofType('AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === name)![1];
const policyOf = (name: string) => resolve(((role(name).Properties.Policies as Node[])[0].PolicyDocument as Node).Statement) as Statement[];
const sid = (st: Statement[], id: string) => st.find((s) => s.Sid === id)!;
const actions = (st: Statement[]) => st.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Action].flat() as string[]);

const wfText = read('.github/workflows/disaster-restore.yml');
const wf = parse(wfText) as { on: Node; permissions: Node; concurrency: Node; jobs: { run: Node & { steps: Node[] } } };

describe('D7: the roles', () => {
  it('the button role: GitHub OIDC trust on the aws-disaster environment only; MaxSessionDuration ≥ the workflow\'s role-duration-seconds', () => {
    const r = role(DISASTER_BUTTON_ROLE).Properties;
    const trust = resolve((r.AssumeRolePolicyDocument as Node).Statement) as Statement[];
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity', Principal: { Federated: `arn:aws:iam::${ACCT}:oidc-provider/token.actions.githubusercontent.com` } });
    expect(trust[0].Condition).toEqual({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': DISASTER_OIDC_SUBJECT } });
    expect(DISASTER_OIDC_SUBJECT).toBe('repo:ccentofo/bytime:environment:aws-disaster');
    const creds = wf.jobs.run.steps.find((s) => (s.uses as string | undefined)?.startsWith('aws-actions/configure-aws-credentials@'))!.with as Node;
    expect(r.MaxSessionDuration).toBe(21600);
    expect(Number(r.MaxSessionDuration)).toBeGreaterThanOrEqual(Number(creds['role-duration-seconds']));
    expect(creds['role-duration-seconds']).toBe(21600);
    // The bootstrap's OIDC provider is the one the trust names.
    expect((boot.Resources.GitHubOidcProvider.Properties as Node).Url).toBe('https://token.actions.githubusercontent.com');
  });

  it('the button role starts only the disaster and (3d) export families in the backup cluster; ListTasks on * with ecs:cluster; Describe/Stop on task/; PassRole only those families\' roles to ecs-tasks', () => {
    const st = policyOf(DISASTER_BUTTON_ROLE);
    const cluster = { ArnEquals: { 'ecs:cluster': `arn:aws:ecs:us-east-1:${ACCT}:cluster/cadenzpoint-backup` } };
    // feature-plan-cloud-export.md §6.2: the same button role starts the export family (never the sweep or backup families).
    expect(sid(st, 'RunDisasterTask')).toMatchObject({ Action: 'ecs:RunTask', Resource: [`arn:aws:ecs:us-east-1:${ACCT}:task-definition/cadenzpoint-backup-disaster:*`, `arn:aws:ecs:us-east-1:${ACCT}:task-definition/cadenzpoint-backup-export:*`], Condition: cluster });
    expect(sid(st, 'ListTasks')).toMatchObject({ Action: 'ecs:ListTasks', Resource: '*', Condition: cluster });
    expect(sid(st, 'DescribeAndStopTasks')).toMatchObject({ Action: ['ecs:DescribeTasks', 'ecs:StopTask'], Resource: `arn:aws:ecs:us-east-1:${ACCT}:task/cadenzpoint-backup/*` });
    expect(sid(st, 'PassDisasterRoles')).toMatchObject({
      Action: 'iam:PassRole', Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      Resource: [`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-disaster-task`, `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-disaster-exec`,
        `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-export-task`, `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-export-exec`],
    });
    expect(sid(st, 'ReadStackOutputs').Resource).toBe(`arn:aws:cloudformation:us-east-1:${ACCT}:stack/cadenzpoint-backup/*`);
    expect(actions(st).sort()).toEqual(['cloudformation:DescribeStacks', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:RunTask', 'ecs:StopTask', 'ecs:TagResource', 'iam:PassRole'].sort());
  });

  it('the disaster task role: reads backups, decrypts with the purpose condition, reads the backup and disaster log groups (3c-2 §6.2), lists its own family, emails; no SSM write, no S3 write, no wildcards in actions', () => {
    const st = policyOf(taskRoleName('disaster'));
    const acts = actions(st);
    expect(acts.sort()).toEqual(['ecs:DescribeTasks', 'ecs:ListTasks', 'kms:Decrypt', 'logs:FilterLogEvents', 's3:GetObject', 's3:ListBucket', 'sns:Publish'].sort());
    expect(acts.some((a) => /^ssm:|^s3:Put|^s3:Delete|\*/.test(a))).toBe(false);
    expect(sid(st, 'DecryptBackups').Condition).toEqual({ StringEquals: { 'kms:EncryptionContext:purpose': 'cadenzpoint-backup' } });
    expect(sid(st, 'ReadBackupLines').Resource).toEqual([`arn:aws:logs:us-east-1:${ACCT}:log-group:/cadenzpoint/backup/backup:*`, `arn:aws:logs:us-east-1:${ACCT}:log-group:/cadenzpoint/backup/disaster:*`]);
    expect(sid(st, 'ListOwnFamily')).toMatchObject({ Resource: '*', Condition: { ArnEquals: { 'ecs:cluster': `arn:aws:ecs:us-east-1:${ACCT}:cluster/cadenzpoint-backup` } } });
  });

  it('the disaster execution role reads exactly its eight SSM parameters (3c-2 §6.2 adds the backup id and the restore-test URL)', () => {
    const ps = sid(policyOf(execRoleName('disaster')), 'ReadParameters').Resource as string[];
    expect(ps.map((p) => p.split(':parameter')[1]).sort()).toEqual([
      '/cadenzpoint/backup/control-plane-backup-id', '/cadenzpoint/backup/control-plane-project-id', '/cadenzpoint/backup/control-plane-url',
      '/cadenzpoint/backup/encryption-key', '/cadenzpoint/backup/neon-api-key', '/cadenzpoint/backup/neon-org-id',
      '/cadenzpoint/backup/restore-test-project-id', '/cadenzpoint/backup/restore-test-url',
    ]);
  });

  it('the bucket and key deny lists exempt the disaster task role too (and nothing else new)', () => {
    const want = [`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-restore-test-task`, `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-disaster-task`];
    expect(((sid(exp.bucketPolicy, 'DenyReadsExceptRestoreRoles').Condition as Node).ArnNotEquals as Node)['aws:PrincipalArn']).toEqual(want);
    expect(((sid(exp.keyPolicy, 'DenyDecryptExceptRestoreRoles').Condition as Node).ArnNotEquals as Node)['aws:PrincipalArn']).toEqual(want);
  });

  it('the Scheduler role may run every scheduled family and pass every role those task definitions use', () => {
    const st = policyOf(SCHEDULER_ROLE);
    const runs = sid(st, 'RunTasks').Resource as string[];
    const passes = sid(st, 'PassTaskRoles').Resource as string[];
    for (const [, s] of ofType('AWS::Scheduler::Schedule')) {
      const tdName = ((s.Properties.Target as Node).EcsParameters as Node).TaskDefinitionArn as { Ref: string };
      const td = stack.Resources[tdName.Ref].Properties;
      expect(runs).toContain(`arn:aws:ecs:us-east-1:${ACCT}:task-definition/${td.Family}:*`);
      for (const k of ['ExecutionRoleArn', 'TaskRoleArn']) {
        const logical = ((td[k] as Node)['Fn::GetAtt'] as string[])[0];
        expect(passes).toContain(`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/${stack.Resources[logical].Properties.RoleName}`);
      }
    }
  });

  it('every new resource name fits a CfnExecRole pattern (roles under /cadenzpoint-backup/, log groups /cadenzpoint/backup/*, rules and schedules cadenzpoint-backup-*)', () => {
    for (const name of [DISASTER_BUTTON_ROLE, taskRoleName('disaster'), execRoleName('disaster')]) {
      expect(role(name).Properties.Path).toBe('/cadenzpoint-backup/');
      expect(ALL_ROLES).toContain(name);
    }
    expect((stack.Resources.DisasterLogGroup.Properties as Node)).toEqual({ LogGroupName: '/cadenzpoint/backup/disaster', RetentionInDays: 365 });
    for (const [, r] of ofType('AWS::Events::Rule')) expect(r.Properties.Name as string).toMatch(/^cadenzpoint-backup-/);
    for (const [, r] of ofType('AWS::Scheduler::Schedule')) expect(r.Properties.Name as string).toMatch(/^cadenzpoint-backup-/);
    const cfn = resolve(((boot.Resources.CfnExecRole.Properties.Policies as Node[])[0].PolicyDocument as Node).Statement) as Statement[];
    expect(sid(cfn, 'LogGroups').Resource).toBe(`arn:aws:logs:us-east-1:${ACCT}:log-group:/cadenzpoint/backup/*`);
    expect(sid(cfn, 'Schedules').Resource).toBe(`arn:aws:scheduler:us-east-1:${ACCT}:schedule/default/cadenzpoint-backup-*`);
    expect(sid(cfn, 'AlertRules').Resource).toBe(`arn:aws:events:us-east-1:${ACCT}:rule/cadenzpoint-backup-*`);
  });
});

describe('D7: the task definition, the schedule, the outputs', () => {
  const td = stack.Resources.DisasterTaskDefinition.Properties;
  const c = (td.ContainerDefinitions as Node[])[0];
  it('container `disaster`, command disaster, 2 vCPU / 4 GiB, StopTimeout 120, the disaster log group; NEON_HISTORY_RETENTION_SECONDS unset', () => {
    expect(td).toMatchObject({ Family: 'cadenzpoint-backup-disaster', Cpu: '2048', Memory: '4096' });
    expect(c).toMatchObject({ Name: 'disaster', Command: ['disaster'], StopTimeout: 120 });
    expect(((c.LogConfiguration as Node).Options as Node)['awslogs-group']).toEqual({ Ref: 'DisasterLogGroup' });
    const env = Object.fromEntries((c.Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({ NEON_REGION_ID: 'aws-us-east-1', DISASTER_DEADLINE_MINUTES: '330', BACKUP_LOG_GROUP: '/cadenzpoint/backup/backup', BACKUP_PG_RESTORE_BIN: '/usr/lib/postgresql/16/bin/pg_restore', DISASTER_LOG_GROUP: '/cadenzpoint/backup/disaster' });
    expect(env.NEON_HISTORY_RETENTION_SECONDS).toBeUndefined();
    expect((c.Secrets as Array<{ Name: string }>).map((x) => x.Name).sort()).toEqual(['BACKUP_CONTROL_PLANE_ID', 'CONTROL_PLANE_DATABASE_URL', 'CONTROL_PLANE_PROJECT_ID', 'ENCRYPTION_KEY', 'NEON_API_KEY', 'NEON_ORG_ID', 'RESTORE_TEST_DATABASE_URL', 'RESTORE_TEST_PROJECT_ID']);
  });

  it('the monthly schedule rehearses only: its command parses through the real argv parser as rehearse/auto; 15:17 UTC on the 1st', () => {
    const s = ofType('AWS::Scheduler::Schedule').find(([, x]) => x.Properties.Name === 'cadenzpoint-backup-disaster-rehearse')![1].Properties;
    expect(s.ScheduleExpression).toBe('cron(17 15 1 * ? *)');
    const input = JSON.parse((s.Target as Node).Input as string) as { containerOverrides: Array<{ name: string; command: string[] }> };
    expect(input.containerOverrides[0].name).toBe('disaster');
    const [cmd, ...rest] = input.containerOverrides[0].command;
    expect(cmd).toBe('disaster');
    expect(parseDisasterArgs(rest)).toMatchObject({ ok: true, args: { mode: 'rehearse', targets: 'auto', override: 'none' } });
  });

  it('the button reads the outputs it needs; the button script names the same container and family', () => {
    expect(Object.keys(stack.Outputs)).toEqual(expect.arrayContaining(['DisasterButtonRoleArn', 'ClusterName', 'TaskSubnets', 'TaskSecurityGroup']));
    const sh = read('scripts/backup/disaster-button.sh');
    expect(sh).toMatch(/^CONTAINER=disaster$/m);
    expect(sh).toMatch(/^FAMILY=cadenzpoint-backup-disaster$/m);
    expect(sh).toMatch(/^CLUSTER=cadenzpoint-backup$/m);
    const code = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/set -x|aws ecs wait|trap [^\n]* EXIT/);
    expect(code).toMatch(/trap '[^']*' INT/);
    expect(code).toMatch(/trap '[^']*' TERM/);
  });
});

describe('D7: the alerting rules', () => {
  const pattern = (name: string) => resolve(ofType('AWS::Events::Rule').find(([, r]) => r.Properties.Name === name)![1].Properties.EventPattern) as Node;
  function matches(p: unknown, e: unknown): boolean {
    if (Array.isArray(p)) return p.some((x) => (x && typeof x === 'object' && 'prefix' in (x as Node) ? typeof e === 'string' && e.startsWith((x as Node).prefix as string) : x === e));
    if (p && typeof p === 'object') return Object.entries(p as Node).every(([k, sub]) => e !== null && typeof e === 'object' && k in (e as Node) && matches(sub, (e as Node)[k]));
    return false;
  }
  const tdArn = `arn:aws:ecs:us-east-1:${ACCT}:task-definition/cadenzpoint-backup-disaster:7`;

  it('the start rule: every disaster task PENDING/PROVISIONING/STOPPED event, whatever started it; never another family', () => {
    const p = pattern(NAMES.disasterStartedRule);
    const ev = (lastStatus: string, taskDefinitionArn = tdArn) => ({ source: 'aws.ecs', 'detail-type': 'ECS Task State Change', detail: { taskDefinitionArn, lastStatus } });
    for (const s of ['PENDING', 'PROVISIONING', 'STOPPED']) expect(matches(p, ev(s)), s).toBe(true);
    expect(matches(p, ev('RUNNING'))).toBe(false);
    expect(matches(p, ev('PENDING', `arn:aws:ecs:us-east-1:${ACCT}:task-definition/cadenzpoint-backup-backup:3`))).toBe(false);
    expect(JSON.stringify(p)).not.toMatch(/startedBy|userIdentity/);
  });

  it('the RunTask rule matches the family or its ARN (two prefixes in one array, D6), from any caller', () => {
    const p = pattern(NAMES.disasterRunTaskRule);
    const ev = (taskDefinition: string) => ({ 'detail-type': 'AWS API Call via CloudTrail', detail: { eventName: 'RunTask', requestParameters: { taskDefinition }, userIdentity: { arn: 'x' } } });
    for (const t of ['cadenzpoint-backup-disaster', 'cadenzpoint-backup-disaster:7', tdArn]) expect(matches(p, ev(t)), t).toBe(true);
    expect(matches(p, ev('cadenzpoint-backup-backup'))).toBe(false);
    expect(JSON.stringify(p)).not.toContain('$or');
  });

  it('the protections rule gains the SSM events by name only, with no requestParameters key', () => {
    const p = pattern(NAMES.protectionsRule) as { detail: Node };
    expect(Object.keys(p.detail)).toEqual(['eventName']);
    expect(PROTECTION_EVENTS).toEqual(expect.arrayContaining(['PutParameter', 'DeleteParameter', 'DeleteParameters']));
  });

  it('the audit inspects and expects all six rules (3d adds the two export rules)', () => {
    const insp = sid(policyOf(taskRoleName('audit')), 'InspectRules').Resource as string[];
    for (const n of [NAMES.protectionsRule, NAMES.rolesRule, NAMES.disasterStartedRule, NAMES.disasterRunTaskRule, NAMES.exportStartedRule, NAMES.exportRunTaskRule]) {
      expect(insp).toContain(`arn:aws:events:us-east-1:${ACCT}:rule/${n}`);
      expect(Object.keys(exp.rulePatterns)).toContain(n);
    }
    const auditEnv = Object.fromEntries(((stack.Resources.AuditTaskDefinition.Properties.ContainerDefinitions as Node[])[0].Environment as Array<{ Name: string; Value: string }>).map((e) => [e.Name, e.Value]));
    expect(auditEnv.ALERT_RULE_NAMES.split(',').sort()).toEqual(Object.keys(exp.rulePatterns).sort());
  });
});

describe('D7: the button workflow', () => {
  it('main-only, gated, in aws-disaster, id-token only on the job, queued never cancelled, 360 minutes, SHA pins, no persisted credentials', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    const job = wf.jobs.run;
    expect(job.if).toBe("github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'");
    expect(job.environment).toBe('aws-disaster');
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(job['timeout-minutes']).toBe(360);
    expect(wf.concurrency).toEqual({ group: 'disaster-restore', 'cancel-in-progress': false, queue: 'max' });
    for (const s of job.steps) if (s.uses) expect(s.uses as string).toMatch(/@[0-9a-f]{40}$/);
    expect((job.steps[0].with as Node)['persist-credentials']).toBe(false);
    const creds = job.steps[1].with as Node;
    expect(creds).toMatchObject({ 'role-to-assume': '${{ secrets.AWS_DISASTER_ROLE_ARN }}', 'aws-region': 'us-east-1', 'mask-aws-account-id': true });
  });

  it('`inputs.` appears only under on: (never in env, run or with); no step env at all', () => {
    expect(JSON.stringify(wf.jobs)).not.toMatch(/inputs\.|github\.event\.inputs/);
    for (const s of wf.jobs.run.steps) expect(s.env).toBeUndefined();
    expect(Object.keys((wf.on.workflow_dispatch as Node).inputs as Node)).toEqual(['mode', 'targets', 'override', 'confirm']);
  });

  it('the run step execs the script (so a cancel signals it directly); the cancelled() step stops the task', () => {
    const steps = wf.jobs.run.steps;
    expect(steps.find((s) => s.id === 'run')!.run).toBe('exec bash scripts/backup/disaster-button.sh');
    const stop = steps[steps.length - 1];
    expect(stop).toEqual({ if: 'cancelled()', run: 'bash scripts/backup/disaster-button.sh --stop' });
  });
});

describe('D7: deploy-prod.yml pins', () => {
  it('every action by SHA; the Vercel CLI by exact version with explicit npm retries (npm ignores .npmrc in global mode)', () => {
    const d = parse(read('.github/workflows/deploy-prod.yml')) as { jobs: { deploy: { steps: Node[] } } };
    for (const s of d.jobs.deploy.steps) if (s.uses) expect(s.uses as string).toMatch(/@[0-9a-f]{40}$/);
    const install = d.jobs.deploy.steps.find((s) => s.name === 'Install Vercel CLI')!.run as string;
    expect(install).toMatch(/^npm i -g vercel@\d+\.\d+\.\d+ --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000$/);
  });

  it('the image copies the two new src/ files the bundle imports', () => {
    const docker = read('Dockerfile.backup');
    expect(docker).toContain('COPY src/lib/tenant/db-name.ts src/lib/tenant/db-name.ts');
    expect(docker).toContain('COPY src/lib/tenant/lifecycle-config.ts src/lib/tenant/lifecycle-config.ts');
  });
});

describe('runbook A support (RESTORE.md A.3, A.9)', () => {
  it('`tenant:admin show` prints the workspace id (the button takes ids, not slugs)', () => {
    expect(read('scripts/tenant-admin.ts')).toMatch(/console\.log\(`  id: +\$\{t\.id\}`\)/);
  });
  it('the CloudShell command starts the disaster family with a cloudshell- startedBy and a run id the task accepts', () => {
    const restore = read('RESTORE.md');
    const cmd = /```bash\n\s*(STAMP=[^\n]+)\n/.exec(restore)![1];
    expect(cmd).toContain('--task-definition cadenzpoint-backup-disaster');
    expect(cmd).toContain('--started-by "cloudshell-$STAMP"');
    expect(cmd).toContain('\\"--run-id\\",\\"cloudshell-$STAMP\\"');
    expect(parseDisasterArgs(['workspace', '--targets', '0a1b2c3d-1111-4222-8333-444455556666', '--override', 'none', '--run-id', 'cloudshell-20261117T204036'])).toMatchObject({ ok: true });
  });
});

describe('fix round 1: runbook and setup lines (FR13, FR15)', () => {
  it('RESTORE.md: "deploys with Skip lost workspaces ticked", the every-release line, and every result the code can report', () => {
    const r = read('RESTORE.md');
    expect((r.match(/\*\*Skip lost workspaces\*\* ticked/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(r).toContain('13. **Every release while a workspace is skipped or awaiting a rebuild:** tick **Skip lost workspaces** on Deploy to\n    Production each time');
    for (const result of ['linked', 'original-exists', 'recoverable', 'observed', 'reachable', 'not-lost', 'reachable-now', 'original-back', 'network-unproven',
      'credentials', 'database-missing', 'deletion-due', 'no-backup', 'retryable', 'changed-meanwhile', 'not-started', 'not-finished', 'proof-failed', 'facts',
      'restore-failed', 'create', 'guard', 'error', 'cleanup-failed']) expect(r, result).toContain(`\`${result}\``);
  });
  it('PRODUCTION-DEPLOY.md: Phase 14 tells every release to tick Skip lost workspaces; both setups have the same-organisation check', () => {
    const p = read('PRODUCTION-DEPLOY.md');
    expect(p).toContain('tick **Skip lost workspaces** on every release');
    expect(p).toContain('**Same organisation check:**');
    expect(read('FOUNDER-ACCOUNTS-SETUP.md')).toContain('**Same organisation check:**');
  });
  it('every result string the workspace and rehearse modes produce is in the runbook\'s list', () => {
    const r = read('RESTORE.md');
    const code = read('scripts/backup/disaster-workspace.ts') + read('scripts/backup/disaster-rehearse.ts');
    const produced = new Set([...code.matchAll(/out\('([a-z-]+)'/g), ...code.matchAll(/result: '([a-z-]+)'/g)].map((m) => m[1]));
    for (const p of produced) if (p !== 'rehearsed') expect(r, p).toContain(`\`${p}\``);
  });
});
