/**
 * The audit's AWS seams (feature-plan-database-backups.md §6.6, §11; impact analysis G9.4). Production wires the SDK
 * clients below (each with a 30-second request timeout, §6.6 step 9); tests fake `AuditClients` and `KeyProbeClient`.
 */
import { S3Client, GetBucketVersioningCommand, ListMultipartUploadsCommand, GetBucketPolicyCommand, GetBucketLifecycleConfigurationCommand, GetBucketEncryptionCommand } from '@aws-sdk/client-s3';
import { KMSClient, DescribeKeyCommand, GetKeyPolicyCommand, DecryptCommand, ReEncryptCommand } from '@aws-sdk/client-kms';
import { SNSClient, ListSubscriptionsByTopicCommand, GetSubscriptionAttributesCommand, GetTopicAttributesCommand, PublishCommand } from '@aws-sdk/client-sns';
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { EventBridgeClient, DescribeRuleCommand, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { CloudTrailClient, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { IAMClient, GetRoleCommand, ListRolePoliciesCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam';
import type { KeyProbeClient } from './probes';

export interface LifecycleRuleInfo {
  id: string | null;
  status: string | null;
  prefix: string | null;
  expirationDays: number | null;
  abortDays: number | null;
  other: boolean; // transitions, noncurrent-version or tag rules present
}

export interface AlarmInfo {
  actionsEnabled: boolean;
  alarmActions: string[];
  metricName: string | null;
  namespace: string | null;
  threshold: number | null;
  comparison: string | null;
  treatMissingData: string | null;
  dimensions: Record<string, string>;
}

/** A bucket's default encryption (GetBucketEncryption, the first rule), or null when none is set. */
export interface EncryptionInfo {
  algorithm: string | null;
  keyId: string | null;
  bucketKeyEnabled: boolean;
  rules: number;
}

export interface AuditClients {
  /** feature-plan-cloud-export.md §6.2 (3d): the exports bucket (encryption is checked for it only) and its key. */
  exports: {
    policy(): Promise<string | null>;
    lifecycle(): Promise<LifecycleRuleInfo[] | null>;
    encryption(): Promise<EncryptionInfo | null>;
  };
  exportKey: {
    state(): Promise<string>;
    policy(): Promise<string | null>;
  };
  bucket: {
    versioning(): Promise<string>;
    multipartUploads(): Promise<Array<{ key: string; initiated: Date }>>;
    policy(): Promise<string | null>;
    lifecycle(): Promise<LifecycleRuleInfo[] | null>;
  };
  key: {
    state(): Promise<string>;
    policy(): Promise<string | null>;
  };
  topic: {
    subscriptions(): Promise<Array<{ arn: string; protocol: string }>>;
    filterPolicy(subscriptionArn: string): Promise<string | null>;
    policy(): Promise<string | null>;
  };
  rules: {
    describe(name: string): Promise<{ state: string; eventPattern: string | null } | null>;
    targets(name: string): Promise<string[]>;
  };
  trail: { isLogging(): Promise<boolean> };
  alarm: { describe(name: string): Promise<AlarmInfo | null> };
  iam: {
    trust(role: string): Promise<string | null>;
    inlinePolicyNames(role: string): Promise<string[]>;
    inlinePolicy(role: string, name: string): Promise<string | null>;
    attachedPolicies(role: string): Promise<string[]>;
  };
}

const TIMEOUT = { requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 } };

const errName = (e: unknown) => (e as { name?: string })?.name;

/** The real clients. `names` are the fixed resource names from expected-policies.ts. */
function policyOf(s3: S3Client, bucket: string) {
  return async () => {
    try {
      return (await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy ?? null;
    } catch (e) {
      if (errName(e) === 'NoSuchBucketPolicy') return null;
      throw e;
    }
  };
}

function lifecycleOf(s3: S3Client, bucket: string) {
  return async (): Promise<LifecycleRuleInfo[] | null> => {
    try {
      const r = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      return (r.Rules ?? []).map((x) => ({
        id: x.ID ?? null,
        status: x.Status ?? null,
        prefix: x.Filter?.Prefix ?? x.Prefix ?? null,
        expirationDays: x.Expiration?.Days ?? null,
        abortDays: x.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
        other: Boolean(x.Transitions?.length || x.NoncurrentVersionExpiration || x.NoncurrentVersionTransitions?.length || x.Filter?.Tag || x.Filter?.And
          || x.Expiration?.Date || x.Expiration?.ExpiredObjectDeleteMarker),
      }));
    } catch (e) {
      if (errName(e) === 'NoSuchLifecycleConfiguration') return null;
      throw e;
    }
  };
}

export function realAuditClients(o: { region: string; bucket: string; keyArn: string; exportBucket: string; exportKeyArn: string; topicArn: string; trailName: string }): AuditClients {
  const s3 = new S3Client({ region: o.region, ...TIMEOUT });
  const kms = new KMSClient({ region: o.region, ...TIMEOUT });
  const sns = new SNSClient({ region: o.region, ...TIMEOUT });
  const events = new EventBridgeClient({ region: o.region, ...TIMEOUT });
  const trail = new CloudTrailClient({ region: o.region, ...TIMEOUT });
  const cw = new CloudWatchClient({ region: o.region, ...TIMEOUT });
  const iam = new IAMClient({ region: o.region, ...TIMEOUT });
  return {
    bucket: {
      versioning: async () => (await s3.send(new GetBucketVersioningCommand({ Bucket: o.bucket }))).Status ?? '',
      multipartUploads: async () => {
        const out: Array<{ key: string; initiated: Date }> = [];
        let keyMarker: string | undefined;
        let idMarker: string | undefined;
        do {
          const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: o.bucket, KeyMarker: keyMarker, UploadIdMarker: idMarker }));
          for (const u of page.Uploads ?? []) if (u.Key && u.Initiated) out.push({ key: u.Key, initiated: u.Initiated });
          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
        } while (keyMarker);
        return out;
      },
      policy: policyOf(s3, o.bucket),
      lifecycle: lifecycleOf(s3, o.bucket),
    },
    key: {
      state: async () => (await kms.send(new DescribeKeyCommand({ KeyId: o.keyArn }))).KeyMetadata?.KeyState ?? 'unknown',
      policy: async () => (await kms.send(new GetKeyPolicyCommand({ KeyId: o.keyArn, PolicyName: 'default' }))).Policy ?? null,
    },
    exports: {
      policy: policyOf(s3, o.exportBucket),
      lifecycle: lifecycleOf(s3, o.exportBucket),
      encryption: async () => {
        try {
          const rules = (await s3.send(new GetBucketEncryptionCommand({ Bucket: o.exportBucket }))).ServerSideEncryptionConfiguration?.Rules ?? [];
          const r = rules[0];
          return {
            algorithm: r?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
            keyId: r?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ?? null,
            bucketKeyEnabled: Boolean(r?.BucketKeyEnabled),
            rules: rules.length,
          };
        } catch (e) {
          if (errName(e) === 'ServerSideEncryptionConfigurationNotFoundError') return null;
          throw e;
        }
      },
    },
    exportKey: {
      state: async () => (await kms.send(new DescribeKeyCommand({ KeyId: o.exportKeyArn }))).KeyMetadata?.KeyState ?? 'unknown',
      policy: async () => (await kms.send(new GetKeyPolicyCommand({ KeyId: o.exportKeyArn, PolicyName: 'default' }))).Policy ?? null,
    },
    topic: {
      subscriptions: async () => {
        const out: Array<{ arn: string; protocol: string }> = [];
        let token: string | undefined;
        do {
          const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: o.topicArn, NextToken: token }));
          for (const s of page.Subscriptions ?? []) out.push({ arn: s.SubscriptionArn ?? '', protocol: s.Protocol ?? '' });
          token = page.NextToken;
        } while (token);
        return out;
      },
      filterPolicy: async (arn) => (await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }))).Attributes?.FilterPolicy ?? null,
      policy: async () => (await sns.send(new GetTopicAttributesCommand({ TopicArn: o.topicArn }))).Attributes?.Policy ?? null,
    },
    rules: {
      describe: async (name) => {
        try {
          const r = await events.send(new DescribeRuleCommand({ Name: name }));
          return { state: r.State ?? 'unknown', eventPattern: r.EventPattern ?? null };
        } catch (e) {
          if (errName(e) === 'ResourceNotFoundException') return null;
          throw e;
        }
      },
      targets: async (name) => (await events.send(new ListTargetsByRuleCommand({ Rule: name }))).Targets?.map((t) => t.Arn ?? '') ?? [],
    },
    trail: { isLogging: async () => Boolean((await trail.send(new GetTrailStatusCommand({ Name: o.trailName }))).IsLogging) },
    alarm: {
      describe: async (name) => {
        const a = (await cw.send(new DescribeAlarmsCommand({ AlarmNames: [name] }))).MetricAlarms?.[0];
        if (!a) return null;
        return {
          actionsEnabled: Boolean(a.ActionsEnabled), alarmActions: a.AlarmActions ?? [], metricName: a.MetricName ?? null,
          namespace: a.Namespace ?? null, threshold: a.Threshold ?? null, comparison: a.ComparisonOperator ?? null,
          treatMissingData: a.TreatMissingData ?? null,
          dimensions: Object.fromEntries((a.Dimensions ?? []).map((d) => [d.Name ?? '', d.Value ?? ''])),
        };
      },
    },
    iam: {
      trust: async (role) => {
        try {
          const doc = (await iam.send(new GetRoleCommand({ RoleName: role }))).Role?.AssumeRolePolicyDocument;
          return doc ? decodeURIComponent(doc) : null;
        } catch (e) {
          if (errName(e) === 'NoSuchEntityException') return null;
          throw e;
        }
      },
      inlinePolicyNames: async (role) => (await iam.send(new ListRolePoliciesCommand({ RoleName: role }))).PolicyNames ?? [],
      inlinePolicy: async (role, name) => {
        const doc = (await iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: name }))).PolicyDocument;
        return doc ? decodeURIComponent(doc) : null;
      },
      attachedPolicies: async (role) => (await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role }))).AttachedPolicies?.map((p) => p.PolicyArn ?? '') ?? [],
    },
  };
}

/** The KMS calls the probes make (expected to be refused). */
export function realKeyProbeClient(region: string, keyArn: string): KeyProbeClient {
  const kms = new KMSClient({ region, ...TIMEOUT });
  return {
    decrypt: async (blob, context) => { await kms.send(new DecryptCommand({ CiphertextBlob: blob, EncryptionContext: context, KeyId: keyArn })); },
    reEncrypt: async (blob, context) => {
      await kms.send(new ReEncryptCommand({ CiphertextBlob: blob, SourceEncryptionContext: context, DestinationKeyId: keyArn, DestinationEncryptionContext: context, SourceKeyId: keyArn }));
    },
  };
}

// ---- the disaster task (feature-plan-disaster-restore.md §6.4 "Who started it", "Start", "End") ---------------------

export interface EcsTaskInfo {
  taskArn: string;
  startedBy: string | null;
  createdAt: Date | null;
}

/** The task's view of ECS: itself (from the container metadata endpoint) and the running tasks of its family. */
export interface DisasterEcs {
  self(): Promise<EcsTaskInfo>;
  /** Running tasks of the disaster family, with createdAt (DescribeTasks). */
  running(): Promise<EcsTaskInfo[]>;
}

export function realDisasterEcs(o: { region: string; metadataUri: string; family: string; fetchImpl?: typeof fetch }): DisasterEcs {
  const ecs = new ECSClient({ region: o.region, ...TIMEOUT });
  const doFetch = o.fetchImpl ?? fetch;
  let meta: { cluster: string; taskArn: string } | null = null;
  const metadata = async () => {
    if (meta) return meta;
    const res = await doFetch(`${o.metadataUri}/task`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`task metadata: HTTP ${res.status}`);
    const j = (await res.json()) as { Cluster?: string; TaskARN?: string };
    if (!j.Cluster || !j.TaskARN) throw new Error('task metadata: no Cluster/TaskARN');
    meta = { cluster: j.Cluster, taskArn: j.TaskARN };
    return meta;
  };
  const describe = async (cluster: string, arns: string[]): Promise<EcsTaskInfo[]> => {
    const out: EcsTaskInfo[] = [];
    for (let i = 0; i < arns.length; i += 100) {
      const r = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns.slice(i, i + 100) }));
      for (const t of r.tasks ?? []) out.push({ taskArn: t.taskArn ?? '', startedBy: t.startedBy ?? null, createdAt: t.createdAt ?? null });
    }
    return out;
  };
  return {
    async self() {
      const m = await metadata();
      const [t] = await describe(m.cluster, [m.taskArn]);
      if (!t) throw new Error('DescribeTasks returned no task for this task');
      return t;
    },
    async running() {
      const m = await metadata();
      const arns: string[] = [];
      let nextToken: string | undefined;
      do {
        const r = await ecs.send(new ListTasksCommand({ cluster: m.cluster, family: o.family, desiredStatus: 'RUNNING', nextToken }));
        arns.push(...(r.taskArns ?? []));
        nextToken = r.nextToken;
      } while (nextToken);
      return arns.length ? describe(m.cluster, arns) : [];
    },
  };
}

/** The founder's email: one message to the alert topic (private). */
export type Publisher = (subject: string, message: string) => Promise<void>;

export function realPublisher(o: { region: string; topicArn: string }): Publisher {
  const sns = new SNSClient({ region: o.region, ...TIMEOUT });
  return async (subject, message) => {
    await sns.send(new PublishCommand({ TopicArn: o.topicArn, Subject: subject.slice(0, 99), Message: message.slice(0, 200_000) }));
  };
}
