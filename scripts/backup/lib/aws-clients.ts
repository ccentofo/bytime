/**
 * The audit's AWS seams (feature-plan-database-backups.md §6.6, §11; impact analysis G9.4). Production wires the SDK
 * clients below (each with a 30-second request timeout, §6.6 step 9); tests fake `AuditClients` and `KeyProbeClient`.
 */
import { S3Client, GetBucketVersioningCommand, ListMultipartUploadsCommand, GetBucketPolicyCommand, GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { KMSClient, DescribeKeyCommand, GetKeyPolicyCommand, DecryptCommand, ReEncryptCommand } from '@aws-sdk/client-kms';
import { SNSClient, ListSubscriptionsByTopicCommand, GetSubscriptionAttributesCommand, GetTopicAttributesCommand } from '@aws-sdk/client-sns';
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

export interface AuditClients {
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
export function realAuditClients(o: { region: string; bucket: string; keyArn: string; topicArn: string; trailName: string }): AuditClients {
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
      policy: async () => {
        try {
          return (await s3.send(new GetBucketPolicyCommand({ Bucket: o.bucket }))).Policy ?? null;
        } catch (e) {
          if (errName(e) === 'NoSuchBucketPolicy') return null;
          throw e;
        }
      },
      lifecycle: async () => {
        try {
          const r = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: o.bucket }));
          return (r.Rules ?? []).map((x) => ({
            id: x.ID ?? null,
            status: x.Status ?? null,
            prefix: x.Filter?.Prefix ?? x.Prefix ?? null,
            expirationDays: x.Expiration?.Days ?? null,
            abortDays: x.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
            other: Boolean(x.Transitions?.length || x.NoncurrentVersionExpiration || x.NoncurrentVersionTransitions?.length || x.Filter?.Tag || x.Filter?.And),
          }));
        } catch (e) {
          if (errName(e) === 'NoSuchLifecycleConfiguration') return null;
          throw e;
        }
      },
    },
    key: {
      state: async () => (await kms.send(new DescribeKeyCommand({ KeyId: o.keyArn }))).KeyMetadata?.KeyState ?? 'unknown',
      policy: async () => (await kms.send(new GetKeyPolicyCommand({ KeyId: o.keyArn, PolicyName: 'default' }))).Policy ?? null,
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
