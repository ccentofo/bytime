import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * feature-plan-database-backups.md §11 U6: static checks on the CloudFormation templates, the Dockerfile, the deploy
 * workflow, the bundle's inputs (esbuild metafile) against the deploy list, changed.sh, and the src/ boundary. Plus the
 * single-source rule: every protection document in the template equals scripts/backup/lib/expected-policies.ts.
 */
import {
  ALL_ROLES, expectedDocuments, normalize, PROTECTION_EVENTS, ROLE_EVENTS, statementDrift, NAMES, taskRoleName, execRoleName, SCHEDULER_ROLE, type Statement,
} from '../../../scripts/backup/lib/expected-policies';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
type Node = Record<string, unknown>;
const ACCT = '111122223333';
const KEY_ARN = `arn:aws:kms:us-east-1:${ACCT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;

const stackText = read('ops/aws/backup-stack.yml');
const bootText = read('ops/aws/bootstrap.yml');
const stack = parse(stackText) as { Parameters: Node; Resources: Record<string, { Type: string; Properties: Node; DeletionPolicy?: string; UpdateReplacePolicy?: string; DependsOn?: string[] }> };
const boot = parse(bootText) as typeof stack;
const exp = expectedDocuments({ accountId: ACCT, keyArn: KEY_ARN });

/** Substitute the intrinsics used in policy documents: Fn::Sub with pseudo-parameters, Ref AWS::AccountId, the key ARN. */
function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === 'object') {
    const o = v as Node;
    if ('Fn::Sub' in o && typeof o['Fn::Sub'] === 'string') return (o['Fn::Sub'] as string).replace(/\$\{AWS::AccountId\}/g, ACCT).replace(/\$\{AWS::Region\}/g, 'us-east-1');
    if ('Ref' in o && o.Ref === 'AWS::AccountId') return ACCT;
    if ('Fn::GetAtt' in o && JSON.stringify(o['Fn::GetAtt']) === JSON.stringify(['BackupKey', 'Arn'])) return KEY_ARN;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
}
const ofType = (t: typeof stack, type: string) => Object.entries(t.Resources).filter(([, r]) => r.Type === type);
const roleByName = (t: typeof stack, name: string) => ofType(t, 'AWS::IAM::Role').find(([, r]) => r.Properties.RoleName === name)?.[1];
const policyOf = (role: { Properties: Node }) => resolve(((role.Properties.Policies as Node[])[0].PolicyDocument as Node).Statement) as Statement[];
const trustOf = (role: { Properties: Node }) => resolve((role.Properties.AssumeRolePolicyDocument as Node).Statement) as Statement[];
const actionsOf = (st: Statement[]) => st.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Action].flat() as string[]);

describe('U6: templates parse, long-form only', () => {
  it('no `!` short-form tags; both parse with a plain YAML parser', () => {
    for (const t of [stackText, bootText]) expect(t).not.toMatch(/(^|[\s:[,-])!(Sub|Ref|GetAtt|Select|GetAZs|Join|If|Equals|Base64|ImportValue|Split|FindInMap)\b/m);
    expect(Object.keys(stack.Resources).length).toBeGreaterThan(30);
    expect(Object.keys(boot.Resources).length).toBeGreaterThan(5);
  });
});

describe('U6: parameters (FR1)', () => {
  it('the main stack declares exactly ImageUri and AlertEmail, and deploy.sh passes both on every deploy; tuning values are constants', () => {
    expect(Object.keys(stack.Parameters).sort()).toEqual(['AlertEmail', 'ImageUri']);
    const deploy = read('scripts/backup/deploy.sh');
    expect(deploy).toMatch(/--parameter-overrides "ImageUri=\$REPOSITORY_URI@\$digest" "AlertEmail=\$ALERT_EMAIL"/);
    const env = (logical: string) => Object.fromEntries(((stack.Resources[logical].Properties.ContainerDefinitions as Node[])[0].Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
    expect(env('BackupTaskDefinition')).toMatchObject({ BACKUP_CONCURRENCY: '3', BACKUP_TARGET_DEADLINE_MINUTES: '30' });
    expect(env('RestoreTestTaskDefinition')).toMatchObject({ RESTORE_TEST_CONCURRENCY: '2', RESTORE_TEST_TARGET_DEADLINE_MINUTES: '120' });
    expect(stack.Resources.BackupTaskDefinition.Properties).toMatchObject({ Cpu: '2048', Memory: '4096' });
    expect(((stack.Resources.MonthlyBudget.Properties.Budget as Node).BudgetLimit as Node).Amount).toBe(10);
  });
});

describe('U6: the protection documents equal expected-policies.ts (the audit\'s single source)', () => {
  it('bucket, key and topic policies', () => {
    const bp = ofType(stack, 'AWS::S3::BucketPolicy')[0][1];
    expect(statementDrift('bucket', exp.bucketPolicy, resolve((bp.Properties.PolicyDocument as Node).Statement))).toEqual([]);
    const key = stack.Resources.BackupKey;
    expect(statementDrift('key', exp.keyPolicy, resolve((key.Properties.KeyPolicy as Node).Statement))).toEqual([]);
    const tp = ofType(stack, 'AWS::SNS::TopicPolicy')[0][1];
    expect(statementDrift('topic', exp.topicPolicy, resolve((tp.Properties.PolicyDocument as Node).Statement))).toEqual([]);
  });

  it('every backup role: trust and inline policy; nothing attached; one policy named as expected', () => {
    const roles = ofType(stack, 'AWS::IAM::Role').map(([, r]) => r.Properties.RoleName as string).sort();
    expect(roles).toEqual([...ALL_ROLES].sort());
    for (const name of ALL_ROLES) {
      const r = roleByName(stack, name)!;
      expect(r.Properties.Path, name).toBe('/cadenzpoint-backup/');
      expect(r.Properties.ManagedPolicyArns, name).toBeUndefined();
      expect((r.Properties.Policies as Node[]).map((p) => p.PolicyName)).toEqual([NAMES.inlinePolicy]);
      expect(statementDrift(`${name}:trust`, exp.roles[name].trust, trustOf(r))).toEqual([]);
      expect(statementDrift(`${name}:policy`, exp.roles[name].policy, policyOf(r))).toEqual([]);
    }
  });

  it('both rule patterns', () => {
    for (const [, r] of ofType(stack, 'AWS::Events::Rule')) {
      const name = r.Properties.Name as string;
      expect(JSON.stringify(normalize(resolve(r.Properties.EventPattern))), name).toBe(JSON.stringify(normalize(exp.rulePatterns[name])));
    }
    expect(ofType(stack, 'AWS::Events::Rule').map(([, r]) => r.Properties.Name).sort()).toEqual([NAMES.protectionsRule, NAMES.rolesRule, NAMES.disasterStartedRule, NAMES.disasterRunTaskRule].sort());
  });
});

describe('U6: the backup can only add; the audit can only look', () => {
  it('the backup and audit task roles have no GetObject, DeleteObject*, Decrypt or ReEncrypt*', () => {
    for (const f of ['backup', 'audit'] as const) {
      const acts = actionsOf(policyOf(roleByName(stack, taskRoleName(f))!));
      for (const bad of ['s3:GetObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 'kms:Decrypt', 'kms:ReEncryptFrom', 'kms:ReEncryptTo', 'kms:ReEncrypt*', 's3:*', 'kms:*']) {
        expect(acts, `${f} ${bad}`).not.toContain(bad);
      }
      expect(acts.some((a) => /\*/.test(a))).toBe(false);
    }
  });

  it('the key policy: Decrypt/ReEncrypt denied except the restore roles (restore test, disaster); window < 30 denied; PutKeyPolicy except CfnExecRole', () => {
    const st = resolve((stack.Resources.BackupKey.Properties.KeyPolicy as Node).Statement) as Statement[];
    const d = st.find((s) => s.Sid === 'DenyDecryptExceptRestoreRoles')!;
    expect(d).toMatchObject({ Effect: 'Deny', Action: ['kms:Decrypt', 'kms:ReEncrypt*'] });
    expect((d.Condition as Node).ArnNotEquals).toEqual({ 'aws:PrincipalArn': [`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-restore-test-task`, `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-disaster-task`] });
    expect(st.find((s) => s.Sid === 'DenyShortDeletionWindow')!.Condition).toEqual({ NumericLessThan: { 'kms:ScheduleKeyDeletionPendingWindowInDays': '30' } });
    const p = st.find((s) => s.Sid === 'DenyKeyPolicyChangesExceptDeploy')!;
    expect((p.Condition as Node).ArnNotEquals).toEqual({ 'aws:PrincipalArn': `arn:aws:iam::${ACCT}:role/cadenzpoint-bootstrap/cadenzpoint-backup-cfn` });
  });

  it('the bucket policy denies versioning, Object Lock, deletes, Gets (except restore), PUT without If-None-Match, policy/lifecycle changes (except CfnExecRole)', () => {
    const st = resolve((ofType(stack, 'AWS::S3::BucketPolicy')[0][1].Properties.PolicyDocument as Node).Statement) as Statement[];
    const deny = (sid: string) => st.find((s) => s.Sid === sid && s.Effect === 'Deny' && s.Principal === '*');
    expect(deny('DenyVersioningAndObjectLock')!.Action).toEqual(['s3:PutBucketVersioning', 's3:PutBucketObjectLockConfiguration']);
    expect(deny('DenyDeletes')!.Action).toBe('s3:DeleteObject*');
    expect(deny('DenyReadsExceptRestoreRoles')!.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-restore-test-task`, `arn:aws:iam::${ACCT}:role/cadenzpoint-backup/cadenzpoint-backup-disaster-task`] } });
    expect(deny('DenyPutWithoutIfNoneMatch')!.Condition).toEqual({ Null: { 's3:if-none-match': 'true' }, Bool: { 's3:ObjectCreationOperation': 'true' } });
    expect(deny('DenyPolicyAndLifecycleChangesExceptDeploy')!.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': `arn:aws:iam::${ACCT}:role/cadenzpoint-bootstrap/cadenzpoint-backup-cfn` } });
    expect(deny('DenyInsecureTransport')).toBeTruthy();
    // Every deny ARN of a backup role carries the /cadenzpoint-backup/ path.
    expect(JSON.stringify(st)).not.toMatch(/:role\/cadenzpoint-backup-restore/);
  });

  it('the bucket: no versioning, the 25-day rule on v1/, abort after 1 day; RetainExceptOnCreate on the bucket and the key', () => {
    const b = stack.Resources.BackupBucket;
    expect(b.Properties.VersioningConfiguration).toBeUndefined();
    expect((b.Properties.LifecycleConfiguration as Node).Rules).toEqual([{ Id: 'expire-v1', Status: 'Enabled', Prefix: 'v1/', ExpirationInDays: 25, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }]);
    for (const r of [stack.Resources.BackupBucket, stack.Resources.BackupKey]) {
      expect(r.DeletionPolicy).toBe('RetainExceptOnCreate');
      expect(r.UpdateReplacePolicy).toBe('Retain');
    }
    expect(stack.Resources.BackupKey.Properties.PendingWindowInDays).toBe(30);
    expect(stack.Resources.BackupKey.Properties.EnableKeyRotation).toBe(true);
  });

  it('the trail and its bucket live in bootstrap.yml (Retain, generated name), never the main stack', () => {
    expect(ofType(stack, 'AWS::CloudTrail::Trail')).toEqual([]);
    const trail = ofType(boot, 'AWS::CloudTrail::Trail')[0][1];
    expect(trail.Properties).toMatchObject({ TrailName: 'cadenzpoint-account-trail', IsMultiRegionTrail: true, IsLogging: true, EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }] });
    expect(trail.DependsOn).toBe('TrailBucketPolicy');
    expect(boot.Resources.TrailBucket.DeletionPolicy).toBe('Retain');
    expect(boot.Resources.TrailBucket.Properties.BucketName).toBeUndefined();
  });

  it('no NAT gateway; no Container Insights; egress 443 and 5432 only, no ingress', () => {
    expect(ofType(stack, 'AWS::EC2::NatGateway')).toEqual([]);
    expect(stack.Resources.Cluster.Properties.ClusterSettings).toEqual([{ Name: 'containerInsights', Value: 'disabled' }]);
    const sg = stack.Resources.TaskSecurityGroup.Properties;
    expect(sg.SecurityGroupIngress).toBeUndefined();
    expect((sg.SecurityGroupEgress as Node[]).map((e) => e.FromPort)).toEqual([443, 5432]);
  });
});

describe('U6: schedules, tasks, alerting', () => {
  const schedules = ofType(stack, 'AWS::Scheduler::Schedule');
  it('every schedule pins a revision (Ref to the task definition), UTC, FlexibleTimeWindow OFF, a retry policy, the DLQ, created last', () => {
    expect(schedules.length).toBe(7); // 3c-2 §6.2 item 3 adds the control-plane rehearsal
    const others = Object.entries(stack.Resources).filter(([, r]) => r.Type !== 'AWS::Scheduler::Schedule').map(([k]) => k).sort();
    for (const [name, s] of schedules) {
      const p = s.Properties;
      const t = p.Target as Node;
      expect((t.EcsParameters as Node).TaskDefinitionArn, name).toEqual({ Ref: expect.stringMatching(/TaskDefinition$/) });
      expect(p.ScheduleExpressionTimezone).toBe('UTC');
      expect(p.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(t.RetryPolicy).toEqual({ MaximumRetryAttempts: 10, MaximumEventAgeInSeconds: 3600 });
      expect(t.DeadLetterConfig).toEqual({ Arn: { 'Fn::GetAtt': ['SchedulerDeadLetterQueue', 'Arn'] } });
      expect(((t.EcsParameters as Node).NetworkConfiguration as Node).AwsvpcConfiguration).toMatchObject({ AssignPublicIp: 'ENABLED' });
      // DependsOn plus the schedule's own Ref/GetAtt references cover every other resource (cfn-lint W3005: no repeats).
      const refs = new Set([...JSON.stringify(s.Properties).matchAll(/"(?:Ref|Fn::GetAtt)":\[?"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
      expect([...new Set([...(s.DependsOn ?? []), ...refs])].filter((r) => others.includes(r)).sort(), name).toEqual(others);
      expect((s.DependsOn ?? []).filter((d) => refs.has(d)), name).toEqual([]);
    }
    const byName = Object.fromEntries(schedules.map(([, s]) => [s.Properties.Name as string, s.Properties]));
    expect(byName['cadenzpoint-backup-daily'].ScheduleExpression).toBe('cron(17 6 * * ? *)');
    expect(byName['cadenzpoint-backup-audit-daily'].ScheduleExpression).toBe('cron(17 11 * * ? *)');
    expect(byName['cadenzpoint-backup-restore-test-weekly'].ScheduleExpression).toBe('cron(17 8 ? * MON *)');
    expect(byName['cadenzpoint-backup-restore-test-catchup'].ScheduleExpression).toBe('cron(17 8 ? * SUN,TUE-SAT *)');
    expect(JSON.parse((byName['cadenzpoint-backup-catchup'].Target as Node).Input as string)).toEqual({ containerOverrides: [{ name: 'backup', command: ['backup', '--if-missing-today'] }] });
    expect(JSON.parse((byName['cadenzpoint-backup-restore-test-catchup'].Target as Node).Input as string)).toEqual({ containerOverrides: [{ name: 'restore-test', command: ['restore-test', '--if-missed'] }] });
  });

  it('task definitions: the key ARN (never the alias) from Fn::GetAtt BackupKey.Arn (G6); init process; StopTimeout 120; secrets from the fixed SSM names', () => {
    for (const [name, td] of ofType(stack, 'AWS::ECS::TaskDefinition')) {
      const c = (td.Properties.ContainerDefinitions as Node[])[0];
      const env = Object.fromEntries((c.Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
      expect(env.BACKUP_KMS_KEY_ARN, name).toEqual({ 'Fn::GetAtt': ['BackupKey', 'Arn'] });
      expect(env.AWS_REGION).toBe('us-east-1');
      expect(c.LinuxParameters).toEqual({ InitProcessEnabled: true });
      expect(c.StopTimeout).toBe(120);
      expect((c.Secrets as Node[]).every((s) => JSON.stringify(s.ValueFrom).includes(':parameter/cadenzpoint/backup/'))).toBe(true);
      expect(td.Properties.RequiresCompatibilities).toEqual(['FARGATE']);
    }
  });

  it('the topic policy allows events and cloudwatch; the DLQ alarm has its fixed name and notBreaching', () => {
    const principals = (resolve((ofType(stack, 'AWS::SNS::TopicPolicy')[0][1].Properties.PolicyDocument as Node).Statement) as Statement[]).map((s) => (s.Principal as Node).Service);
    expect(principals.sort()).toEqual(['cloudwatch.amazonaws.com', 'events.amazonaws.com']);
    expect(stack.Resources.DlqAlarm.Properties).toMatchObject({ AlarmName: 'cadenzpoint-backup-dlq', TreatMissingData: 'notBreaching', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', ActionsEnabled: true });
    expect(stack.Resources.MonthlyBudget.Properties).toMatchObject({ Budget: { CostTypes: { IncludeCredit: false } } });
  });

  /** A small EventBridge pattern matcher: arrays of values or {prefix}, nested objects; missing fields never match. */
  function matches(pattern: unknown, event: unknown): boolean {
    if (Array.isArray(pattern)) return pattern.some((p) => (p && typeof p === 'object' && 'prefix' in (p as Node) ? typeof event === 'string' && event.startsWith((p as Node).prefix as string) : p === event));
    if (pattern && typeof pattern === 'object') return Object.entries(pattern as Node).every(([k, sub]) => event !== null && typeof event === 'object' && k in (event as Node) && matches(sub, (event as Node)[k]));
    return false;
  }
  const rules = () => Object.fromEntries(ofType(stack, 'AWS::Events::Rule').map(([, r]) => [r.Properties.Name as string, r.Properties.EventPattern]));
  const ct = (eventName: string, requestParameters: Node = {}, userIdentity: Node = { type: 'Root' }) => ({ 'detail-type': 'AWS API Call via CloudTrail', detail: { eventName, requestParameters, userIdentity } });

  it('the rules list exactly the §6.1 events, with no caller condition; only the roles rule has the roleName prefix; sample events', () => {
    const r = rules();
    const prot = r[NAMES.protectionsRule] as { detail: { eventName: string[] } };
    const role = r[NAMES.rolesRule] as { detail: { eventName: string[]; requestParameters: Node } };
    expect(prot.detail.eventName).toEqual([...PROTECTION_EVENTS]);
    expect(role.detail.eventName).toEqual([...ROLE_EVENTS]);
    expect(JSON.stringify(r)).not.toMatch(/userIdentity|sessionIssuer|anything-but/);
    expect(Object.keys(prot.detail)).toEqual(['eventName']);
    expect(role.detail.requestParameters).toEqual({ roleName: [{ prefix: 'cadenzpoint-backup-' }] });
    expect(matches(prot, ct('DisableKey', { keyId: 'k' }))).toBe(true);
    expect(matches(prot, ct('PutBucketPolicy', { bucketName: 'b' }, { type: 'IAMUser', arn: 'arn:aws:iam::1:user/x' }))).toBe(true);
    expect(matches(prot, ct('GetObject'))).toBe(false);
    expect(matches(role, ct('PutRolePolicy', { roleName: 'cadenzpoint-backup-x' }))).toBe(true);
    expect(matches(role, ct('PutRolePolicy', { roleName: 'other-role' }))).toBe(false);
    expect(matches(prot, ct('PutRolePolicy', { roleName: 'other-role' }))).toBe(false);
  });
});

describe('U6: the bootstrap stack', () => {
  it('DeployRole: the exact stack ARN and the exact legacy OIDC subject (StringEquals); fixed names outside /cadenzpoint-backup/', () => {
    const d = boot.Resources.DeployRole.Properties;
    expect(d).toMatchObject({ RoleName: NAMES.deployRole, Path: NAMES.bootstrapPath, MaxSessionDuration: 3600 });
    const trust = (d.AssumeRolePolicyDocument as Node).Statement as Statement[];
    expect(trust[0].Condition).toEqual({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:ccentofo/bytime:environment:aws-backups' } });
    const policy = resolve(((d.Policies as Node[])[0].PolicyDocument as Node).Statement) as Statement[];
    const deploy = policy.find((s) => s.Sid === 'DeployTheBackupStackOnly')!;
    expect(deploy.Resource).toContain(`arn:aws:cloudformation:us-east-1:${ACCT}:stack/cadenzpoint-backup/*`);
    expect(JSON.stringify(policy)).not.toMatch(/stack\/\*|stack\/cadenzpoint-backup-bootstrap/);
    expect(boot.Resources.CfnExecRole.Properties).toMatchObject({ RoleName: NAMES.cfnExecRole, Path: NAMES.bootstrapPath });
  });

  it('CfnExecRole: manages /cadenzpoint-backup/ roles only; the ECS service-linked role; its ARN is the one the main stack exempts', () => {
    const st = resolve(((boot.Resources.CfnExecRole.Properties.Policies as Node[])[0].PolicyDocument as Node).Statement) as Statement[];
    expect(st.find((s) => s.Sid === 'BackupRolesOnly')!.Resource).toBe(`arn:aws:iam::${ACCT}:role/cadenzpoint-backup/*`);
    const keyActs = st.find((s) => s.Sid === 'ManageTheBackupKey')!.Action as string[];
    expect(keyActs).toEqual(expect.arrayContaining(['kms:PutKeyPolicy', 'kms:ScheduleKeyDeletion'])); // FR10: KMS's lockout check needs PutKeyPolicy
    expect(st.find((s) => s.Sid === 'EcsServiceLinkedRole')).toMatchObject({ Action: 'iam:CreateServiceLinkedRole', Condition: { StringEquals: { 'iam:AWSServiceName': 'ecs.amazonaws.com' } } });
    expect(JSON.stringify(st)).not.toMatch(/cadenzpoint-bootstrap/);
    expect(exp.cfnExecRoleArn).toBe(`arn:aws:iam::${ACCT}:role${NAMES.bootstrapPath}${NAMES.cfnExecRole}`);
  });

  it('the execution roles have the ECR pull actions; the audit role has the drift Get/Describe actions; task trusts carry account and region', () => {
    for (const f of ['backup', 'audit', 'restore-test'] as const) {
      expect(actionsOf(policyOf(roleByName(stack, execRoleName(f))!))).toEqual(expect.arrayContaining(['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']));
      const trust = trustOf(roleByName(stack, taskRoleName(f))!)[0];
      expect(trust.Condition).toEqual({ StringEquals: { 'aws:SourceAccount': ACCT }, ArnLike: { 'aws:SourceArn': `arn:aws:ecs:us-east-1:${ACCT}:*` } });
    }
    expect(actionsOf(policyOf(roleByName(stack, taskRoleName('audit'))!))).toEqual(expect.arrayContaining([
      's3:GetBucketPolicy', 's3:GetLifecycleConfiguration', 'kms:GetKeyPolicy', 'events:DescribeRule', 'events:ListTargetsByRule', 'cloudtrail:GetTrailStatus',
      'cloudwatch:DescribeAlarms', 'sns:GetTopicAttributes', 'sns:GetSubscriptionAttributes', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies']));
    expect(trustOf(roleByName(stack, SCHEDULER_ROLE)!)[0].Condition).toEqual({ StringEquals: { 'aws:SourceAccount': ACCT } });
  });
});

describe('U6: the deploy workflow', () => {
  const wfText = read('.github/workflows/backup-deploy.yml');
  const wf = parse(wfText) as { on: Node; concurrency: Node; jobs: Record<string, Node & { steps: Node[]; permissions: Node }> };
  it('pins every action by SHA; build has no id-token/environment and reads deployments; deploy has id-token and aws-backups', () => {
    for (const job of Object.values(wf.jobs)) for (const st of job.steps) if (st.uses) expect(st.uses as string).toMatch(/@[0-9a-f]{40}$/);
    expect(wf.jobs.build.permissions).toEqual({ contents: 'read', deployments: 'read' });
    expect(wf.jobs.build.environment).toBeUndefined();
    expect(wf.jobs.deploy.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(wf.jobs.deploy.environment).toBe('aws-backups');
    for (const j of ['build', 'deploy']) expect(wf.jobs[j].if as string).toContain("github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'");
    expect(wf.concurrency).toEqual({ group: 'backup-deploy', 'cancel-in-progress': false, queue: 'max' });
    expect((wf.on.push as Node).paths).toBeUndefined();
  });

  it('account-identifying values come from secrets, never vars; no credentials persisted; account id masked; no npm in deploy; no inputs.* in run', () => {
    const deployText = JSON.stringify(wf.jobs.deploy);
    for (const s of ['AWS_DEPLOY_ROLE_ARN', 'AWS_BACKUP_REPOSITORY_URI', 'AWS_ARTIFACTS_BUCKET', 'BACKUP_ALERT_EMAIL', 'AWS_CFN_EXEC_ROLE_ARN']) {
      expect(deployText).toContain(`secrets.${s}`);
      expect(wfText).not.toContain(`vars.${s}`);
    }
    for (const job of Object.values(wf.jobs)) for (const st of job.steps) {
      if ((st.uses as string | undefined)?.startsWith('actions/checkout@')) expect((st.with as Node)['persist-credentials']).toBe(false);
      if (st.run) expect(st.run as string).not.toMatch(/inputs\./);
    }
    expect(JSON.stringify(wf.jobs.deploy.steps.find((s) => (s.uses as string | undefined)?.startsWith('aws-actions/configure-aws-credentials@'))?.with)).toContain('"mask-aws-account-id":true');
    expect(deployText).not.toMatch(/\bnpm\b|\bnode\b/);
  });
});

describe('U6: the Dockerfile and the bundle inputs', () => {
  const docker = read('Dockerfile.backup');
  const deployList = read('scripts/backup/deploy-paths.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const listed = (f: string) => deployList.some((p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : f === p));

  it('the builder runs `npm ci --ignore-scripts` (never --omit=dev), the shared bundle command, and copies tsconfig.backup.json; base images by digest', () => {
    expect(docker).toMatch(/RUN npm ci --ignore-scripts\b/);
    expect(docker).not.toMatch(/--omit[= ]dev|--production\b|NODE_ENV=production/);
    expect(docker).toMatch(/RUN npm run backup:bundle/);
    expect(docker).toMatch(/COPY tsconfig\.backup\.json/);
    expect(docker).toMatch(/^COPY package\.json package-lock\.json \.npmrc \.\/$/m); // the repo's npm settings (legacy-peer-deps)
    expect(read('.dockerignore').split('\n').map((l) => l.trim())).not.toContain('.npmrc');
    expect(docker.match(/^FROM .*$/gm)!.every((l) => /@sha256:[0-9a-f]{64}/.test(l))).toBe(true);
    expect(docker).toMatch(/postgresql-client-16/);
    // The PGDG key is vendored: no download (no curl), apt retries on every update/install.
    expect(docker).not.toMatch(/\bcurl\b/);
    expect(docker).toMatch(/^COPY ops\/aws\/pgdg-ACCC4CF8\.asc \/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc$/m);
    const aptCalls = docker.match(/apt-get (?:-o \S+ )?(?:update|install)\b/g)!;
    expect(aptCalls.length).toBe(4);
    expect(aptCalls.every((c) => c.includes('-o Acquire::Retries=5'))).toBe(true);
    expect(docker).toMatch(/\[signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc\]/);
    expect(docker).toMatch(/USER node/);
    expect(read('package.json')).toContain('"backup:bundle": "node scripts/backup/bundle.mjs"');
  });

  let inputs: string[] = [];
  let bundleText = '';
  beforeAll(async () => {
    const { build } = await import('esbuild');
    const { BUNDLE_OPTIONS, bundleDefines } = await import('../../../scripts/backup/bundle.mjs');
    const r = await build({ ...(BUNDLE_OPTIONS as import('esbuild').BuildOptions), define: bundleDefines(ROOT), absWorkingDir: ROOT, write: false, metafile: true, logLevel: 'silent' });
    inputs = Object.keys(r.metafile!.inputs);
    bundleText = r.outputFiles![0].text;
  }, 120_000);

  /** feature-plan-cloud-export.md §10: the plugin's virtual `{ version }` module is not a file, so not on the deploy list. */
  const VIRTUAL = 'app-version:';

  it('every non-node_modules input of the esbuild bundle matches the deploy list; the src/ inputs are exactly the named modules (3c adds db-name, lifecycle-config; 3c-2 adds slug-rules; 3d adds the export closure)', () => {
    const own = inputs.filter((i) => !i.startsWith('node_modules/') && !i.startsWith(VIRTUAL));
    expect(own.length).toBeGreaterThan(10);
    expect(own.filter((i) => !listed(i))).toEqual([]);
    expect(own.filter((i) => i.startsWith('src/')).sort()).toEqual([
      'src/db/schema.ts', 'src/lib/calendar-date.ts', 'src/lib/csv/escape.ts', 'src/lib/db/pg-url.ts', 'src/lib/encryption.ts',
      'src/lib/export/allowlists.ts', 'src/lib/export/manifest.ts', 'src/lib/export/workspace-export.ts', 'src/lib/provenance.ts',
      'src/lib/tenant/backup-locks.ts', 'src/lib/tenant/db-name.ts', 'src/lib/tenant/direct-url.ts', 'src/lib/tenant/lifecycle-config.ts',
      'src/lib/tenant/slug-rules.ts',
    ]);
    // Never the export page's AWS code (feature-plan-cloud-export.md §10: not download-url.ts).
    expect(inputs.some((i) => i.includes('download-url'))).toBe(false);
    for (const f of ['tsconfig.backup.json', '.npmrc', 'ops/aws/pgdg-ACCC4CF8.asc', 'Dockerfile.backup', 'ops/aws/backup-stack.yml', '.github/workflows/backup-deploy.yml', 'drizzle/meta/_journal.json']) expect(listed(f), f).toBe(true);
    expect(listed('ops/aws/bootstrap.yml')).toBe(false);
    expect(listed('package.json')).toBe(false);
  });

  it('T22 (3d): package.json is never a bundle input (the plugin serves only its version); the bundled APP_VERSION is package.json\'s; the journal length is defined at build time', () => {
    expect(inputs).not.toContain('package.json');
    expect(inputs.filter((i) => i.endsWith('package.json') && !i.startsWith('node_modules/') && !i.startsWith(VIRTUAL))).toEqual([]);
    expect(inputs).toContain(`${VIRTUAL}package.json`);
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const m = /app-version:package\.json\s*\n\s*var (\w+) = \{ version: "([^"]+)" \};/.exec(bundleText);
    expect(m?.[2]).toBe(version);
    expect(bundleText).not.toMatch(/\{\s*version:\s*"[^"]+",\s*private/); // never the whole package.json
    expect(bundleText).not.toContain('__TENANT_JOURNAL_LENGTH__');
    const journal = (JSON.parse(read('drizzle/meta/_journal.json')) as { entries: unknown[] }).entries.length;
    expect(__TENANT_JOURNAL_LENGTH__).toBe(journal); // the vitest define equals the journal too
    // The Dockerfile copies the journal (read at build time) and the tsconfig resolves `@/` (the export closure's imports).
    const builder = docker.split(/^FROM /m)[1];
    expect(builder).toMatch(/^COPY drizzle\/meta\/_journal\.json drizzle\/meta\/_journal\.json$/m);
    expect(builder.indexOf('COPY drizzle/meta/_journal.json')).toBeLessThan(builder.indexOf('RUN npm run backup:bundle'));
    expect((JSON.parse(read('tsconfig.backup.json')) as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths).toEqual({ '@/*': ['./src/*'] });
  });

  it('D2 (3c-2): every src/ input of the bundle has an exact `COPY <path> <path>` line in the builder stage, and tsconfig.backup.json includes it', () => {
    const builder = read('Dockerfile.backup').split(/^FROM /m)[1];
    const copies = new Set(builder.split('\n').filter((l) => l.startsWith('COPY ')).map((l) => l.trim()));
    const include = (JSON.parse(read('tsconfig.backup.json')) as { include: string[] }).include;
    const src = inputs.filter((i) => i.startsWith('src/'));
    expect(src.length).toBeGreaterThan(0);
    for (const f of src) {
      expect(copies.has(`COPY ${f} ${f}`), `Dockerfile.backup: COPY ${f} ${f}`).toBe(true);
      expect(include, `tsconfig.backup.json include: ${f}`).toContain(f);
    }
  });
});

/** The OpenPGP v4 fingerprint of an armored key's primary key: SHA-1 over 0x99, the 2-byte length, the key packet body. */
function primaryFingerprint(armored: string): string {
  const lines = armored.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'));
  const end = lines.findIndex((l) => l.startsWith('-----END PGP PUBLIC KEY BLOCK-----'));
  let i = start + 1;
  while (i < end && lines[i].trim() !== '') i++; // armor headers end at the blank line
  const buf = Buffer.from(lines.slice(i + 1, end).filter((l) => !l.startsWith('=')).join(''), 'base64');
  const ctb = buf[0];
  if (!(ctb & 0x80)) throw new Error('not an OpenPGP packet');
  let tag: number; let len: number; let off: number;
  if (ctb & 0x40) {
    tag = ctb & 0x3f;
    const o = buf[1];
    if (o < 192) { len = o; off = 2; } else if (o < 224) { len = ((o - 192) << 8) + buf[2] + 192; off = 3; } else if (o === 255) { len = buf.readUInt32BE(2); off = 6; } else throw new Error('partial length');
  } else {
    tag = (ctb >> 2) & 0x0f;
    const lt = ctb & 3;
    if (lt === 0) { len = buf[1]; off = 2; } else if (lt === 1) { len = buf.readUInt16BE(1); off = 3; } else if (lt === 2) { len = buf.readUInt32BE(1); off = 5; } else throw new Error('indeterminate length');
  }
  if (tag !== 6) throw new Error(`first packet is tag ${tag}, not a public key`);
  const body = buf.subarray(off, off + len);
  if (body[0] !== 4) throw new Error('not a v4 key');
  const hex = createHash('sha1').update(Buffer.from([0x99, len >> 8, len & 0xff])).update(body).digest('hex').toUpperCase();
  return hex.match(/.{4}/g)!.join(' ');
}

describe('U6: the vendored PGDG signing key', () => {
  it('ops/aws/pgdg-ACCC4CF8.asc is the PostgreSQL apt key (fingerprint B97B…4CF8): a swapped file fails CI', () => {
    const key = read('ops/aws/pgdg-ACCC4CF8.asc');
    expect(primaryFingerprint(key)).toBe('B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8');
    expect(createHash('sha256').update(key).digest('hex')).toBe('0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76');
    expect(read('.dockerignore').split('\n').map((l) => l.trim())).not.toContain('ops/aws/pgdg-ACCC4CF8.asc');
  });

  it('ci.yml installs the PG 16 tools from the vendored key: no curl of postgresql.org anywhere; apt retries', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/curl[^\n]*postgresql\.org/);
    expect(ci).toContain('sudo install -m 644 ops/aws/pgdg-ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc');
    const apt = ci.match(/apt-get (?:-o \S+ )?(?:update|install)\b/g)!;
    expect(apt.length).toBeGreaterThanOrEqual(2);
    expect(apt.every((c) => c.includes('-o Acquire::Retries=5'))).toBe(true);
  });
});

describe('U6: src/ never imports the AWS SDK', () => {
  it('no src/ file imports @aws-sdk/* or @aws-crypto/*', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const f = path.join(d, n);
      if (n === 'node_modules' || n === '__tests__') return [];
      return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
    });
    const offenders = walk(path.join(ROOT, 'src')).filter((f) => /from ['"]@aws-(sdk|crypto)\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('U6: changed.sh (a stub `gh`, a throwaway git repo)', () => {
  let repo: string;
  let stubDir: string;
  const commits: Record<string, string> = {};
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const commit = (label: string, file: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), `${label}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', label);
    commits[label] = git('rev-parse', 'HEAD');
    return commits[label];
  };

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'cpbk-repo-'));
    stubDir = mkdtempSync(path.join(tmpdir(), 'cpbk-gh-'));
    git('init', '-q');
    mkdirSync(path.join(repo, 'scripts/backup'), { recursive: true });
    copyFileSync(path.join(ROOT, 'scripts/backup/changed.sh'), path.join(repo, 'scripts/backup/changed.sh'));
    copyFileSync(path.join(ROOT, 'scripts/backup/deploy-paths.txt'), path.join(repo, 'scripts/backup/deploy-paths.txt'));
    chmodSync(path.join(repo, 'scripts/backup/changed.sh'), 0o755);
    commit('base', 'README.md');
    // The stub answers `gh api …deployments?…` with STUB_DEPLOYMENTS ("id sha" lines) and `…/deployments/<id>/statuses…`
    // with STUB_STATE_<id> (default "other"); STUB_FAIL=1 makes every call fail.
    writeFileSync(path.join(stubDir, 'gh'), `#!/bin/bash
[ "\${STUB_FAIL:-}" = "1" ] && exit 1
case "$2" in
  */statuses*) id="\${2#*/deployments/}"; id="\${id%%/*}"; v="STUB_STATE_$id"; echo "\${!v:-other}" ;;
  *deployments*) printf '%s\\n' "\${STUB_DEPLOYMENTS:-}" ;;
esac
`);
    chmodSync(path.join(stubDir, 'gh'), 0o755);
  });

  const run = (event: string, sha: string, env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', ['scripts/backup/changed.sh', event, sha], { cwd: repo, encoding: 'utf8', env: { PATH: `${stubDir}:${process.env.PATH}`, HOME: process.env.HOME ?? '', ...env } as unknown as NodeJS.ProcessEnv });
    return r.stdout.trim();
  };
  const deployedAt = (sha: string, extra: Record<string, string> = {}) => ({ STUB_DEPLOYMENTS: `101 ${sha}`, STUB_STATE_101: 'success', ...extra });

  it('true for a change to each deploy-list entry; false for an unrelated file', () => {
    const base = commits.base;
    const samples = ['scripts/backup/lib/x.ts', 'src/lib/encryption.ts', 'src/lib/tenant/direct-url.ts', 'src/lib/tenant/backup-locks.ts', 'ops/aws/backup-stack.yml', 'Dockerfile.backup', '.dockerignore', 'tsconfig.backup.json', '.npmrc', 'ops/aws/pgdg-ACCC4CF8.asc', '.github/workflows/backup-deploy.yml'];
    let prev = base;
    for (const f of samples) {
      const c = commit(`touch ${f}`, f);
      expect(run('push', c, deployedAt(prev)), f).toBe('changed=true');
      prev = c;
    }
    const app = commit('app only', 'src/app/page.tsx');
    expect(run('push', app, deployedAt(prev))).toBe('changed=false');
    const pkg = commit('package bump', 'package.json');
    expect(run('push', pkg, deployedAt(app))).toBe('changed=false');
  });

  it('true on workflow_dispatch; true with no successful deploy; true when the API fails', () => {
    const head = git('rev-parse', 'HEAD');
    expect(run('workflow_dispatch', head, deployedAt(head))).toBe('changed=true');
    expect(run('push', head, { STUB_DEPLOYMENTS: '' })).toBe('changed=true');
    expect(run('push', head, { STUB_DEPLOYMENTS: `7 ${head}`, STUB_STATE_7: 'other' })).toBe('changed=true');
    expect(run('push', head, { ...deployedAt(head), STUB_FAIL: '1' })).toBe('changed=true');
  });

  it('true for an app-only push that follows a backup change whose deploy failed (diff against the last SUCCESSFUL deploy)', () => {
    const good = commit('deployed ok', 'docs/a.md');
    const backupChange = commit('backup change', 'scripts/backup/lib/y.ts');
    const appOnly = commit('app only 2', 'src/app/other.tsx');
    // Newest first: the failed deploy of the backup change, then the successful one before it.
    expect(run('push', appOnly, { STUB_DEPLOYMENTS: `202 ${backupChange}\n201 ${good}`, STUB_STATE_202: 'other', STUB_STATE_201: 'success' })).toBe('changed=true');
  });

  it('false for a re-run of a commit older than the last deployed one; false when nothing changed', () => {
    const older = commit('older backup change', 'scripts/backup/lib/z.ts');
    const newer = commit('newer backup change', 'scripts/backup/lib/w.ts');
    expect(run('push', older, deployedAt(newer))).toBe('changed=false');
    expect(run('push', newer, deployedAt(newer))).toBe('changed=false');
  });

  it('true when git diff itself fails (the deployed commit is unknown here)', () => {
    const head = git('rev-parse', 'HEAD');
    expect(run('push', head, deployedAt('0123456789abcdef0123456789abcdef01234567'))).toBe('changed=true');
  });
});
