/**
 * The single source of the backup stack's protection documents (feature-plan-database-backups.md §6.1, §6.6 step 5b).
 * The daily audit compares what AWS returns with these; U6 checks they equal the CloudFormation template's statements with
 * `Fn::Sub` substituted, so a template change and this file can't drift apart unseen.
 *
 * Everything is rendered from the account id and the KMS key ARN (BACKUP_KMS_KEY_ARN; the account id is taken from it).
 * Every statement has a `Sid`; a difference (missing, extra or changed) is reported by Sid.
 */

export const REGION = 'us-east-1';
export const NAMES = {
  stack: 'cadenzpoint-backup',
  bucketPrefix: 'cadenzpoint-backups-',
  keyAlias: 'alias/cadenzpoint-backup',
  topic: 'cadenzpoint-backup-alerts',
  protectionsRule: 'cadenzpoint-backup-protections',
  rolesRule: 'cadenzpoint-backup-roles',
  disasterStartedRule: 'cadenzpoint-backup-disaster-started',
  disasterRunTaskRule: 'cadenzpoint-backup-disaster-runtask',
  trail: 'cadenzpoint-account-trail',
  dlq: 'cadenzpoint-backup-scheduler-dlq',
  dlqAlarm: 'cadenzpoint-backup-dlq',
  repository: 'cadenzpoint-backup',
  cluster: 'cadenzpoint-backup',
  rolePath: '/cadenzpoint-backup/',
  bootstrapPath: '/cadenzpoint-bootstrap/',
  cfnExecRole: 'cadenzpoint-backup-cfn',
  deployRole: 'cadenzpoint-backup-deploy',
  inlinePolicy: 'cadenzpoint-backup-policy',
  lifecycleRule: 'expire-v1',
} as const;

export const FAMILIES = ['backup', 'audit', 'restore-test', 'disaster'] as const;
export type Family = (typeof FAMILIES)[number];

export const PARAMETERS = {
  controlPlaneUrl: '/cadenzpoint/backup/control-plane-url',
  encryptionKey: '/cadenzpoint/backup/encryption-key',
  restoreTestUrl: '/cadenzpoint/backup/restore-test-url',
  // feature-plan-disaster-restore.md §6.2 (the founder creates them, §12 step 3).
  neonApiKey: '/cadenzpoint/backup/neon-api-key',
  neonOrgId: '/cadenzpoint/backup/neon-org-id',
  restoreTestProjectId: '/cadenzpoint/backup/restore-test-project-id',
  controlPlaneProjectId: '/cadenzpoint/backup/control-plane-project-id',
  // feature-plan-control-plane-disaster.md §6.0: the per-environment backup id (`prod` or `staging`).
  controlPlaneBackupId: '/cadenzpoint/backup/control-plane-backup-id',
} as const;

const FAMILY_PARAMETERS: Record<Family, string[]> = {
  backup: [PARAMETERS.controlPlaneUrl, PARAMETERS.encryptionKey, PARAMETERS.controlPlaneBackupId],
  'restore-test': [PARAMETERS.controlPlaneUrl, PARAMETERS.restoreTestUrl, PARAMETERS.controlPlaneBackupId],
  audit: [PARAMETERS.controlPlaneUrl, PARAMETERS.restoreTestUrl],
  disaster: [PARAMETERS.controlPlaneUrl, PARAMETERS.encryptionKey, PARAMETERS.neonApiKey, PARAMETERS.neonOrgId, PARAMETERS.restoreTestProjectId, PARAMETERS.controlPlaneProjectId, PARAMETERS.controlPlaneBackupId, PARAMETERS.restoreTestUrl],
};

export const taskFamily = (f: Family) => `cadenzpoint-backup-${f}`;
export const taskRoleName = (f: Family) => `cadenzpoint-backup-${f}-task`;
export const execRoleName = (f: Family) => `cadenzpoint-backup-${f}-exec`;
export const SCHEDULER_ROLE = 'cadenzpoint-backup-scheduler';
/** feature-plan-disaster-restore.md §6.2: the button's role (GitHub OIDC, environment aws-disaster). */
export const DISASTER_BUTTON_ROLE = 'cadenzpoint-backup-disaster-button';
export const DISASTER_OIDC_SUBJECT = 'repo:ccentofo/bytime:environment:aws-disaster';
export const logGroup = (f: Family) => `/cadenzpoint/backup/${f}`;
export const ALL_ROLES = [...FAMILIES.map(taskRoleName), ...FAMILIES.map(execRoleName), SCHEDULER_ROLE, DISASTER_BUTTON_ROLE];

/** The §6.1 protections rule: matched by eventName alone (plus the CloudTrail detail type), from any caller. */
export const PROTECTION_EVENTS = [
  'ScheduleKeyDeletion', 'DisableKey', 'PutKeyPolicy', 'CreateGrant',
  'StopLogging', 'DeleteTrail', 'UpdateTrail', 'PutEventSelectors',
  'PutBucketPolicy', 'DeleteBucketPolicy', 'PutBucketLifecycle', 'DeleteBucketLifecycle', 'PutBucketVersioning',
  'DisableRule', 'DeleteRule', 'PutRule', 'PutTargets', 'RemoveTargets',
  'Unsubscribe', 'Subscribe', 'DeleteTopic', 'SetTopicAttributes', 'SetSubscriptionAttributes',
  'DeleteAlarms', 'DisableAlarmActions', 'PutMetricAlarm',
  'DeleteQueue', 'SetQueueAttributes',
  // feature-plan-disaster-restore.md §6.2: by event name only (a requestParameters filter would stop the others matching).
  'PutParameter', 'DeleteParameter', 'DeleteParameters',
] as const;
/** The separate roles rule: IAM role-policy events on roles whose name starts `cadenzpoint-backup-`. */
export const ROLE_EVENTS = ['UpdateAssumeRolePolicy', 'PutRolePolicy', 'DeleteRolePolicy', 'AttachRolePolicy', 'DetachRolePolicy'] as const;

export function accountIdFromKeyArn(keyArn: string): string {
  const m = /^arn:aws:kms:[a-z0-9-]+:(\d{12}):key\//.exec(keyArn);
  if (!m) throw new Error('BACKUP_KMS_KEY_ARN is not a key ARN');
  return m[1];
}

type Doc = Record<string, unknown>;
export interface Statement extends Doc {
  Sid: string;
}

export interface ExpectedDocuments {
  accountId: string;
  bucket: string;
  bucketArn: string;
  keyArn: string;
  topicArn: string;
  trailArn: string;
  dlqArn: string;
  alarmArn: string;
  roleArn: (name: string) => string;
  cfnExecRoleArn: string;
  bucketPolicy: Statement[];
  keyPolicy: Statement[];
  topicPolicy: Statement[];
  rulePatterns: Record<string, Doc>;
  roles: Record<string, { trust: Statement[]; policy: Statement[] }>;
}

export function expectedDocuments(o: { accountId: string; keyArn: string }): ExpectedDocuments {
  const a = o.accountId;
  const bucket = `${NAMES.bucketPrefix}${a}`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objects = `${bucketArn}/*`;
  const backups = `${bucketArn}/v1/*`;
  const roleArn = (name: string) => `arn:aws:iam::${a}:role/cadenzpoint-backup/${name}`;
  const cfnExecRoleArn = `arn:aws:iam::${a}:role/cadenzpoint-bootstrap/${NAMES.cfnExecRole}`;
  const restoreRole = roleArn(taskRoleName('restore-test'));
  const restoreRoles = [restoreRole, roleArn(taskRoleName('disaster'))];
  const clusterArn = `arn:aws:ecs:${REGION}:${a}:cluster/${NAMES.cluster}`;
  const disasterFamilyArn = `arn:aws:ecs:${REGION}:${a}:task-definition/${taskFamily('disaster')}`;
  const topicArn = `arn:aws:sns:${REGION}:${a}:${NAMES.topic}`;
  const trailArn = `arn:aws:cloudtrail:${REGION}:${a}:trail/${NAMES.trail}`;
  const dlqArn = `arn:aws:sqs:${REGION}:${a}:${NAMES.dlq}`;
  const alarmArn = `arn:aws:cloudwatch:${REGION}:${a}:alarm:${NAMES.dlqAlarm}`;
  const ruleArn = (n: string) => `arn:aws:events:${REGION}:${a}:rule/${n}`;
  const repoArn = `arn:aws:ecr:${REGION}:${a}:repository/${NAMES.repository}`;
  const paramArn = (p: string) => `arn:aws:ssm:${REGION}:${a}:parameter${p}`;
  const purpose = { StringEquals: { 'kms:EncryptionContext:purpose': 'cadenzpoint-backup' } };

  const bucketPolicy: Statement[] = [
    { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [bucketArn, objects], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    { Sid: 'DenyPutWithoutIfNoneMatch', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: objects, Condition: { Null: { 's3:if-none-match': 'true' }, Bool: { 's3:ObjectCreationOperation': 'true' } } },
    { Sid: 'DenyVersioningAndObjectLock', Effect: 'Deny', Principal: '*', Action: ['s3:PutBucketVersioning', 's3:PutBucketObjectLockConfiguration'], Resource: bucketArn },
    { Sid: 'DenyDeletes', Effect: 'Deny', Principal: '*', Action: 's3:DeleteObject*', Resource: objects },
    { Sid: 'DenyReadsExceptRestoreRoles', Effect: 'Deny', Principal: '*', Action: 's3:GetObject*', Resource: objects, Condition: { ArnNotEquals: { 'aws:PrincipalArn': restoreRoles } } },
    { Sid: 'DenyPolicyAndLifecycleChangesExceptDeploy', Effect: 'Deny', Principal: '*', Action: ['s3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutLifecycleConfiguration'], Resource: bucketArn, Condition: { ArnNotEquals: { 'aws:PrincipalArn': cfnExecRoleArn } } },
  ];

  const keyPolicy: Statement[] = [
    { Sid: 'AccountRootAdministers', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${a}:root` }, Action: 'kms:*', Resource: '*' },
    { Sid: 'DenyDecryptExceptRestoreRoles', Effect: 'Deny', Principal: { AWS: '*' }, Action: ['kms:Decrypt', 'kms:ReEncrypt*'], Resource: '*', Condition: { ArnNotEquals: { 'aws:PrincipalArn': restoreRoles } } },
    { Sid: 'DenyShortDeletionWindow', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'kms:ScheduleKeyDeletion', Resource: '*', Condition: { NumericLessThan: { 'kms:ScheduleKeyDeletionPendingWindowInDays': '30' } } },
    { Sid: 'DenyKeyPolicyChangesExceptDeploy', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'kms:PutKeyPolicy', Resource: '*', Condition: { ArnNotEquals: { 'aws:PrincipalArn': cfnExecRoleArn } } },
  ];

  const topicPolicy: Statement[] = [
    { Sid: 'AllowEventBridgePublish', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Resource: topicArn, Condition: { StringEquals: { 'aws:SourceAccount': a } } },
    { Sid: 'AllowCloudWatchPublish', Effect: 'Allow', Principal: { Service: 'cloudwatch.amazonaws.com' }, Action: 'sns:Publish', Resource: topicArn, Condition: { StringEquals: { 'aws:SourceAccount': a } } },
  ];

  const rulePatterns: Record<string, Doc> = {
    [NAMES.protectionsRule]: { 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: [...PROTECTION_EVENTS] } },
    [NAMES.rolesRule]: { 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: [...ROLE_EVENTS], requestParameters: { roleName: [{ prefix: 'cadenzpoint-backup-' }] } } },
    [NAMES.disasterStartedRule]: {
      source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'],
      detail: { taskDefinitionArn: [{ prefix: `${disasterFamilyArn}:` }], lastStatus: ['PENDING', 'PROVISIONING', 'STOPPED'] },
    },
    [NAMES.disasterRunTaskRule]: {
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { eventName: ['RunTask'], requestParameters: { taskDefinition: [{ prefix: taskFamily('disaster') }, { prefix: disasterFamilyArn }] } },
    },
  };

  const ecsTrust: Statement[] = [{
    Sid: 'TrustEcsTasks', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: { StringEquals: { 'aws:SourceAccount': a }, ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${REGION}:${a}:*` } },
  }];
  const execPolicy = (f: Family): Statement[] => [
    { Sid: 'PullAuth', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
    { Sid: 'PullImage', Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: repoArn },
    { Sid: 'WriteLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${REGION}:${a}:log-group:${logGroup(f)}:*` },
    { Sid: 'ReadParameters', Effect: 'Allow', Action: 'ssm:GetParameters', Resource: FAMILY_PARAMETERS[f].map(paramArn) },
  ];
  const roles: ExpectedDocuments['roles'] = {
    [taskRoleName('backup')]: {
      trust: ecsTrust,
      policy: [
        { Sid: 'PutBackups', Effect: 'Allow', Action: 's3:PutObject', Resource: backups },
        { Sid: 'AbortUploads', Effect: 'Allow', Action: 's3:AbortMultipartUpload', Resource: backups },
        { Sid: 'GenerateDataKeys', Effect: 'Allow', Action: 'kms:GenerateDataKey', Resource: o.keyArn, Condition: purpose },
      ],
    },
    [taskRoleName('restore-test')]: {
      trust: ecsTrust,
      policy: [
        { Sid: 'ReadBackups', Effect: 'Allow', Action: 's3:GetObject', Resource: backups },
        { Sid: 'ListBackups', Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': 'v1/*' } } },
        { Sid: 'DecryptBackups', Effect: 'Allow', Action: 'kms:Decrypt', Resource: o.keyArn, Condition: purpose },
      ],
    },
    [taskRoleName('audit')]: {
      trust: ecsTrust,
      policy: [
        { Sid: 'ListBackups', Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': 'v1/*' } } },
        { Sid: 'InspectBucket', Effect: 'Allow', Action: ['s3:GetBucketPolicy', 's3:GetBucketVersioning', 's3:GetLifecycleConfiguration', 's3:ListBucketMultipartUploads'], Resource: bucketArn },
        { Sid: 'InspectKey', Effect: 'Allow', Action: ['kms:DescribeKey', 'kms:GetKeyPolicy'], Resource: o.keyArn },
        { Sid: 'InspectRules', Effect: 'Allow', Action: ['events:DescribeRule', 'events:ListTargetsByRule'], Resource: [ruleArn(NAMES.protectionsRule), ruleArn(NAMES.rolesRule), ruleArn(NAMES.disasterStartedRule), ruleArn(NAMES.disasterRunTaskRule)] },
        { Sid: 'InspectTopic', Effect: 'Allow', Action: ['sns:GetTopicAttributes', 'sns:ListSubscriptionsByTopic'], Resource: topicArn },
        { Sid: 'InspectSubscriptions', Effect: 'Allow', Action: 'sns:GetSubscriptionAttributes', Resource: `${topicArn}:*` },
        { Sid: 'InspectTrail', Effect: 'Allow', Action: 'cloudtrail:GetTrailStatus', Resource: trailArn },
        { Sid: 'InspectAlarm', Effect: 'Allow', Action: 'cloudwatch:DescribeAlarms', Resource: alarmArn },
        { Sid: 'InspectRoles', Effect: 'Allow', Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies'], Resource: `arn:aws:iam::${a}:role/cadenzpoint-backup/*` },
      ],
    },
    [taskRoleName('disaster')]: {
      trust: ecsTrust,
      policy: [
        { Sid: 'ReadBackups', Effect: 'Allow', Action: 's3:GetObject', Resource: backups },
        { Sid: 'ListBackups', Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': 'v1/*' } } },
        { Sid: 'DecryptBackups', Effect: 'Allow', Action: 'kms:Decrypt', Resource: o.keyArn, Condition: purpose },
        { Sid: 'ReadBackupLines', Effect: 'Allow', Action: 'logs:FilterLogEvents', Resource: [`arn:aws:logs:${REGION}:${a}:log-group:${logGroup('backup')}:*`, `arn:aws:logs:${REGION}:${a}:log-group:${logGroup('disaster')}:*`] },
        { Sid: 'ListOwnFamily', Effect: 'Allow', Action: 'ecs:ListTasks', Resource: '*', Condition: { ArnEquals: { 'ecs:cluster': clusterArn } } },
        { Sid: 'DescribeTasks', Effect: 'Allow', Action: 'ecs:DescribeTasks', Resource: `arn:aws:ecs:${REGION}:${a}:task/${NAMES.cluster}/*` },
        { Sid: 'EmailFounder', Effect: 'Allow', Action: 'sns:Publish', Resource: topicArn },
      ],
    },
    [DISASTER_BUTTON_ROLE]: {
      trust: [{
        Sid: 'TrustGitHubDisasterEnvironment', Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${a}:oidc-provider/token.actions.githubusercontent.com` }, Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': DISASTER_OIDC_SUBJECT } },
      }],
      policy: [
        { Sid: 'RunDisasterTask', Effect: 'Allow', Action: 'ecs:RunTask', Resource: `${disasterFamilyArn}:*`, Condition: { ArnEquals: { 'ecs:cluster': clusterArn } } },
        { Sid: 'ListTasks', Effect: 'Allow', Action: 'ecs:ListTasks', Resource: '*', Condition: { ArnEquals: { 'ecs:cluster': clusterArn } } },
        { Sid: 'DescribeAndStopTasks', Effect: 'Allow', Action: ['ecs:DescribeTasks', 'ecs:StopTask'], Resource: `arn:aws:ecs:${REGION}:${a}:task/${NAMES.cluster}/*` },
        { Sid: 'PassDisasterRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: [roleArn(taskRoleName('disaster')), roleArn(execRoleName('disaster'))], Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
        { Sid: 'TagTasks', Effect: 'Allow', Action: 'ecs:TagResource', Resource: '*', Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } } },
        { Sid: 'ReadStackOutputs', Effect: 'Allow', Action: 'cloudformation:DescribeStacks', Resource: `arn:aws:cloudformation:${REGION}:${a}:stack/${NAMES.stack}/*` },
      ],
    },
    [SCHEDULER_ROLE]: {
      trust: [{ Sid: 'TrustScheduler', Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': a } } }],
      policy: [
        { Sid: 'RunTasks', Effect: 'Allow', Action: 'ecs:RunTask', Resource: FAMILIES.map((f) => `arn:aws:ecs:${REGION}:${a}:task-definition/${taskFamily(f)}:*`) },
        { Sid: 'PassTaskRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: [...FAMILIES.map(taskRoleName), ...FAMILIES.map(execRoleName)].map(roleArn), Condition: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
        { Sid: 'TagTasks', Effect: 'Allow', Action: 'ecs:TagResource', Resource: '*', Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } } },
        { Sid: 'SendToDeadLetterQueue', Effect: 'Allow', Action: 'sqs:SendMessage', Resource: dlqArn },
      ],
    },
  };
  for (const f of FAMILIES) roles[execRoleName(f)] = { trust: ecsTrust, policy: execPolicy(f) };

  return { accountId: a, bucket, bucketArn, keyArn: o.keyArn, topicArn, trailArn, dlqArn, alarmArn, roleArn, cfnExecRoleArn, bucketPolicy, keyPolicy, topicPolicy, rulePatterns, roles };
}

/**
 * Normalisation for comparison: keys sorted, arrays normalised and sorted, a one-item array becomes its scalar, booleans
 * and numbers become strings. (AWS may return `"Action": "x"` for `["x"]`, or `30` for `"30"`.)
 */
export function normalize(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(normalize).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    return items.length === 1 ? items[0] : items;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Doc).sort().map((k) => [k, normalize((v as Doc)[k])]));
  }
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return v;
}

/** The Sids that differ between two statement lists (missing, extra or changed), prefixed with `label:`. */
export function statementDrift(label: string, expected: Statement[], actual: unknown): string[] {
  const list = (Array.isArray(actual) ? actual : actual ? [actual] : []) as Doc[];
  const bySid = new Map<string, string>();
  const out: string[] = [];
  for (const s of list) {
    const sid = typeof s.Sid === 'string' ? s.Sid : '(no Sid)';
    if (bySid.has(sid)) out.push(`${label}:${sid}`);
    bySid.set(sid, JSON.stringify(normalize(s)));
  }
  for (const e of expected) {
    const got = bySid.get(e.Sid);
    if (got === undefined || got !== JSON.stringify(normalize(e))) out.push(`${label}:${e.Sid}`);
    bySid.delete(e.Sid);
  }
  for (const extra of bySid.keys()) out.push(`${label}:${extra}`);
  return [...new Set(out)];
}

/** Statements from a policy document string (or null when absent / unparseable). */
export function statementsOf(doc: string | null | undefined): unknown {
  if (!doc) return null;
  try {
    return (JSON.parse(doc) as { Statement?: unknown }).Statement ?? null;
  } catch {
    return null;
  }
}
