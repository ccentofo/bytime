import { describe, it, expect } from 'vitest';

/**
 * feature-plan-database-backups.md §11 S20 (the audit's protection-drift check) and S16 (probe classification), with fake
 * AWS clients rendered from expected-policies.ts. No AWS.
 */
import { protectionDrift } from '../../../scripts/backup/audit';
import { normalize, statementDrift, NAMES, SCHEDULER_ROLE, taskRoleName, EXPORT_DOWNLOAD_ROLE, EXPORT_TASK_ROLE } from '../../../scripts/backup/lib/expected-policies';
import { auditProbes, backupProbes, classifyHead, classifyKms, classifyS3, probesOk, restoreTestProbes } from '../../../scripts/backup/lib/probes';
import { deniedKeyClient, FakeBucket, fakeAuditClients, headForbidden, kmsDenied, s3Denied, TEST_EXPORT_KEY_ARN, TEST_KEY_ARN } from '../helpers/backup-fakes';

describe('S20: protection drift', () => {
  it('all equal → no drift', async () => {
    const { clients } = fakeAuditClients();
    expect(await protectionDrift(clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN)).toEqual({ drift: [], errors: [] });
  });

  const cases: Array<[string, (s: ReturnType<typeof fakeAuditClients>) => void, string]> = [
    ['a topic policy without events.amazonaws.com', ({ state, exp, doc }) => { state.topicPolicy = doc(exp.topicPolicy.filter((x) => x.Sid !== 'AllowEventBridgePublish')); }, 'topic-policy:AllowEventBridgePublish'],
    ['a changed task-role policy', ({ state, exp, doc }) => { const r = taskRoleName('backup'); state.roles[r].policies[NAMES.inlinePolicy] = doc(exp.roles[r].policy.map((x) => (x.Sid === 'PutBackups' ? { ...x, Action: ['s3:PutObject', 's3:GetObject'] } : x))); }, `role:${taskRoleName('backup')}:policy:PutBackups`],
    ['a changed trust', ({ state, exp, doc }) => { state.roles[SCHEDULER_ROLE].trust = doc(exp.roles[SCHEDULER_ROLE].trust.map((x) => ({ ...x, Condition: {} }))); }, `role:${SCHEDULER_ROLE}:trust:TrustScheduler`],
    ['an attached managed policy', ({ state }) => { state.roles[taskRoleName('audit')].attached = ['arn:aws:iam::aws:policy/AmazonS3FullAccess']; }, `role:${taskRoleName('audit')}:attached`],
    ['an extra inline policy', ({ state }) => { state.roles[taskRoleName('audit')].policies.sneaky = '{}'; }, `role:${taskRoleName('audit')}:extra-policy:sneaky`],
    ['a changed rule pattern', ({ state }) => { state.rules[NAMES.protectionsRule]!.eventPattern = JSON.stringify({ 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: ['DisableKey'] } }); }, `rule:${NAMES.protectionsRule}:pattern`],
    ['an extra rule target', ({ state, exp }) => { state.targets[NAMES.rolesRule] = [exp.topicArn, 'arn:aws:sqs:us-east-1:111122223333:elsewhere']; }, `rule:${NAMES.rolesRule}:targets`],
    ['a disabled rule', ({ state }) => { state.rules[NAMES.rolesRule]!.state = 'DISABLED'; }, `rule:${NAMES.rolesRule}:state`],
    ['a trail not logging', ({ state }) => { state.logging = false; }, 'trail:not-logging'],
    ['a subscription with a filter policy', ({ state }) => { state.filterPolicy = '{"never":["x"]}'; }, 'subscription:filter-policy'],
    ['a missing DLQ alarm', ({ state }) => { state.alarm = null; }, 'alarm:missing'],
    ['a missing bucket-policy Sid', ({ state, exp, doc }) => { state.bucketPolicy = doc(exp.bucketPolicy.filter((x) => x.Sid !== 'DenyDeletes')); }, 'bucket-policy:DenyDeletes'],
    ['a missing key-policy Sid', ({ state, exp, doc }) => { state.keyPolicy = doc(exp.keyPolicy.filter((x) => x.Sid !== 'DenyShortDeletionWindow')); }, 'key-policy:DenyShortDeletionWindow'],
    ['a statement with its Sid kept but its ArnNotEquals exemption widened', ({ state, exp, doc }) => {
      state.bucketPolicy = doc(exp.bucketPolicy.map((x) => (x.Sid === 'DenyReadsExceptRestoreRoles' ? { ...x, Condition: { ArnNotEquals: { 'aws:PrincipalArn': [exp.roleArn(taskRoleName('restore-test')), exp.roleArn(taskRoleName('disaster')), 'arn:aws:iam::111122223333:user/intruder'] } } } : x)));
    }, 'bucket-policy:DenyReadsExceptRestoreRoles'],
    ['a missing lifecycle rule', ({ state }) => { state.lifecycle = null; }, 'lifecycle'],
    ['a lifecycle rule at 90 days', ({ state }) => { state.lifecycle = [{ ...state.lifecycle![0], expirationDays: 90 }]; }, 'lifecycle'],
    ['a bucket policy removed', ({ state }) => { state.bucketPolicy = null; }, 'bucket-policy:missing'],
    ['an extra (widening) bucket statement', ({ state, exp, doc }) => { state.bucketPolicy = doc([...exp.bucketPolicy, { Sid: 'AllowEveryone', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }]); }, 'bucket-policy:AllowEveryone'],
    // feature-plan-cloud-export.md §6.2 (T13, the audit half): both buckets, both keys, key state, exports-only encryption.
    ['the export key pending deletion', ({ state }) => { state.exportKeyState = 'PendingDeletion'; }, 'export-key-state:PendingDeletion'],
    ['the export key disabled', ({ state }) => { state.exportKeyState = 'Disabled'; }, 'export-key-state:Disabled'],
    ['an exports bucket policy removed', ({ state }) => { state.exportBucketPolicy = null; }, 'exports-bucket-policy:missing'],
    ['the hold-read deny removed', ({ state, exp, doc }) => { state.exportBucketPolicy = doc(exp.exportBucketPolicy.filter((x) => x.Sid !== 'DenyHoldReadsExceptExportTask')); }, 'exports-bucket-policy:DenyHoldReadsExceptExportTask'],
    ['the download role exempted from the write deny', ({ state, exp, doc }) => {
      state.exportBucketPolicy = doc(exp.exportBucketPolicy.map((x) => (x.Sid === 'DenyWritesExceptExportTask' ? { ...x, Condition: { ArnNotEquals: { 'aws:PrincipalArn': [exp.roleArn(EXPORT_TASK_ROLE), exp.roleArn(EXPORT_DOWNLOAD_ROLE)] } } } : x)));
    }, 'exports-bucket-policy:DenyWritesExceptExportTask'],
    ['an exports lifecycle with only one rule (the backup bucket\'s shape)', ({ state }) => { state.exportLifecycle = [state.exportLifecycle![0]]; }, 'exports-lifecycle'],
    ['a hold/ expiry rule added', ({ state }) => { state.exportLifecycle = [...state.exportLifecycle!, { id: 'expire-hold', status: 'Enabled', prefix: 'hold/', expirationDays: 30, abortDays: null, other: false }]; }, 'exports-lifecycle'],
    ['delivery/ expiring at 30 days', ({ state }) => { state.exportLifecycle = state.exportLifecycle!.map((r) => (r.id === 'expire-delivery' ? { ...r, expirationDays: 30 } : r)); }, 'exports-lifecycle'],
    ['the exports lifecycle removed', ({ state }) => { state.exportLifecycle = null; }, 'exports-lifecycle'],
    // G6: an extra kind on a matching rule (an Expiration.Date on the whole-bucket abort-mpu rule reads back as `other`).
    ['an Expiration.Date added to abort-mpu', ({ state }) => { state.exportLifecycle = state.exportLifecycle!.map((r) => (r.id === 'abort-mpu' ? { ...r, other: true } : r)); }, 'exports-lifecycle'],
    ['the exports bucket on S3-managed keys', ({ state }) => { state.exportEncryption = { algorithm: 'AES256', keyId: null, bucketKeyEnabled: false, rules: 1 }; }, 'exports-encryption'],
    ['the exports bucket on another KMS key', ({ state }) => { state.exportEncryption = { ...state.exportEncryption!, keyId: TEST_KEY_ARN }; }, 'exports-encryption'],
    ['the exports bucket without the bucket key', ({ state }) => { state.exportEncryption = { ...state.exportEncryption!, bucketKeyEnabled: false }; }, 'exports-encryption'],
    ['no default encryption on the exports bucket', ({ state }) => { state.exportEncryption = null; }, 'exports-encryption:missing'],
    ['an export key policy without the GenerateDataKey deny', ({ state, exp, doc }) => { state.exportKeyPolicy = doc(exp.exportKeyPolicy.filter((x) => x.Sid !== 'DenyGenerateDataKeyExceptExportTask')); }, 'export-key-policy:DenyGenerateDataKeyExceptExportTask'],
    ['the download role\'s trust widened to preview deployments', ({ state, exp, doc }) => {
      state.roles[EXPORT_DOWNLOAD_ROLE].trust = doc(exp.roles[EXPORT_DOWNLOAD_ROLE].trust.map((x) => ({ ...x, Condition: { StringLike: { 'x:sub': 'owner:*' } } })));
    }, `role:${EXPORT_DOWNLOAD_ROLE}:trust:TrustVercelProduction`],
  ];
  it.each(cases)('%s → recorded', async (_name, mutate, expected) => {
    const f = fakeAuditClients();
    mutate(f);
    const r = await protectionDrift(f.clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN);
    expect(r.drift).toContain(expected);
    expect(r.errors).toEqual([]);
  });

  it('scalar versus one-item array, key order, numbers versus strings → equal', () => {
    const e = [{ Sid: 'A', Effect: 'Deny', Action: ['kms:Decrypt'], Resource: '*', Condition: { NumericLessThan: { 'kms:ScheduleKeyDeletionPendingWindowInDays': '30' } } }];
    const a = [{ Resource: '*', Condition: { NumericLessThan: { 'kms:ScheduleKeyDeletionPendingWindowInDays': 30 } }, Action: 'kms:Decrypt', Effect: 'Deny', Sid: 'A' }];
    expect(statementDrift('x', e, a)).toEqual([]);
    expect(normalize({ b: [true], a: 1 })).toEqual({ a: '1', b: 'true' });
  });

  it('3d: the backup bucket\'s lifecycle is never compared with the exports bucket\'s rules (each bucket its own array)', async () => {
    const f = fakeAuditClients();
    f.state.lifecycle = f.state.exportLifecycle;
    expect((await protectionDrift(f.clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN)).drift).toEqual(['lifecycle']);
  });

  it('3d: key state in protectionDrift is the export key\'s only: a failing export-key describe is one error naming it; the backup key\'s state never appears here (kms_key_state records it)', async () => {
    const f = fakeAuditClients();
    f.state.throwOn.add('export-key-state');
    const r = await protectionDrift(f.clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN);
    expect(r.drift).toEqual([]);
    expect(r.errors).toEqual(['drift:export-key-state label=s3-error']);
    const g = fakeAuditClients();
    g.state.throwOn.add('key-state');
    g.state.keyState = 'PendingDeletion';
    const s = await protectionDrift(g.clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN);
    expect(s).toEqual({ drift: [], errors: [] });
  });

  it('a check that throws records an error, not drift', async () => {
    const f = fakeAuditClients();
    f.state.throwOn.add('key-policy');
    const r = await protectionDrift(f.clients, TEST_KEY_ARN, TEST_EXPORT_KEY_ARN);
    expect(r.drift).toEqual([]);
    expect(r.errors).toEqual(['drift:key-policy label=s3-error']);
  });
});

describe('S16: permission probes', () => {
  it('HEAD 403 / AccessDenied / AccessDeniedException → denied; success → ALLOWED; anything else → error:<code>', () => {
    expect(classifyHead(headForbidden())).toBe('denied');
    expect(classifyHead({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe('error:404');
    expect(classifyS3(s3Denied())).toBe('denied');
    expect(classifyS3({ name: 'SlowDown' })).toBe('error:SlowDown');
    expect(classifyKms(kmsDenied())).toBe('denied');
    expect(classifyKms({ name: 'InvalidCiphertextException' })).toBe('error:InvalidCiphertextException');
  });

  it('backup role: all refused → ok, with the data key stored for the audit; skipped when nothing was written', async () => {
    const bucket = new FakeBucket();
    bucket.objects.set('v1/x/k.dump.enc', { bytes: Buffer.from('x'), lastModified: new Date() });
    const key = deniedKeyClient();
    const d = await backupProbes(bucket, key, { runId: 'ecs-1', writtenKey: 'v1/x/k.dump.enc', edk: { edk: 'AAAA', context: { purpose: 'cadenzpoint-backup' } } });
    expect(d).toMatchObject({ head_own_object: 'denied', delete_object: 'denied', kms_decrypt: 'denied', kms_reencrypt: 'denied', put_without_if_none_match: 'denied', edk: 'AAAA' });
    expect(probesOk(d)).toBe(true);
    expect(key.calls).toEqual(['decrypt', 'reEncrypt']);
    const none = await backupProbes(bucket, key, { runId: 'ecs-2', writtenKey: null, edk: null });
    expect(none).toMatchObject({ head_own_object: 'skipped', kms_decrypt: 'skipped', kms_reencrypt: 'skipped' });
    expect(probesOk(none)).toBe(true);
  });

  it('one allowed → ok = false and ALLOWED; another error → error:<code>, ok = false', async () => {
    const bucket = new FakeBucket();
    bucket.probe.delete = () => {}; // the delete succeeded: invariant 2 broken
    const allowed = await backupProbes(bucket, deniedKeyClient(), { runId: 'ecs-3', writtenKey: null, edk: null });
    expect(allowed.delete_object).toBe('ALLOWED');
    expect(probesOk(allowed)).toBe(false);
    const b2 = new FakeBucket();
    b2.probe.putUnconditional = () => { throw Object.assign(new Error('x'), { name: 'InternalError' }); };
    const err = await backupProbes(b2, deniedKeyClient(), { runId: 'ecs-4', writtenKey: null, edk: null });
    expect(err.put_without_if_none_match).toBe('error:InternalError');
    expect(probesOk(err)).toBe(false);
  });

  it('audit with no stored data key → skipped, ok; the HEAD probe uses the newest key (G7)', async () => {
    const bucket = new FakeBucket();
    const d = await auditProbes(bucket, deniedKeyClient(), { newestKey: null, storedEdk: null });
    expect(d).toEqual({ head_newest_object: 'skipped', kms_decrypt: 'skipped', delete_object: 'denied' });
    expect(probesOk(d)).toBe(true);
    bucket.objects.set('v1/new', { bytes: Buffer.from('x'), lastModified: new Date() });
    expect((await auditProbes(bucket, deniedKeyClient(), { newestKey: 'v1/new', storedEdk: null })).head_newest_object).toBe('denied');
  });

  it('restore-test role: delete and conditional PUT refused → ok', async () => {
    const d = await restoreTestProbes(new FakeBucket(), { runId: 'ecs-5' });
    expect(d).toEqual({ delete_object: 'denied', put_object: 'denied' });
    expect(probesOk(d)).toBe(true);
  });
});
