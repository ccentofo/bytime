import 'server-only';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';

/**
 * The download page's only AWS code (feature-plan-cloud-export.md §6.6; U6 allows `@aws-sdk` in this one `src/` file).
 * A 5-minute presigned GET of one delivery copy, signed with the export download role's credentials, which Vercel's OIDC
 * token buys through STS (no stored key). The role may only `GetObject` under `delivery/`; the key's decrypt is limited
 * to S3 in us-east-1 with the bucket's encryption context.
 *
 * - The region is hard-coded us-east-1, for S3 and for STS (`clientConfig`): the Vercel provider drops the S3 client's
 *   config when it calls STS (impact analysis §3.2, D5). No `audience` option: the trust's `aud` is Vercel's default.
 * - Both env values are checked BEFORE the provider is built, so local dev and tests never reach @vercel/oidc's CLI
 *   token refresh (D11).
 * - A presigned URL can stop working before 5 minutes if the cached role session ends first; a download already in
 *   progress continues (S3 checks expiry at request time).
 */

export const EXPORT_REGION = 'us-east-1';
export const PRESIGN_SECONDS = 300;

export type PresignResult = { ok: true; url: string } | { ok: false; reason: 'misconfigured' | 'error'; errorName?: string };

let cached: { roleArn: string; client: S3Client } | null = null;

function clientFor(roleArn: string): S3Client {
  if (cached?.roleArn !== roleArn) {
    cached = {
      roleArn,
      client: new S3Client({
        region: EXPORT_REGION,
        credentials: awsCredentialsProvider({ roleArn, clientConfig: { region: EXPORT_REGION } }),
      }),
    };
  }
  return cached.client;
}

/** A 5-minute attachment-disposition URL for one object, or why there isn't one (never throws; never logs the URL). */
export async function presignDeliveryUrl(key: string, filename: string, env: Record<string, string | undefined> = process.env): Promise<PresignResult> {
  const roleArn = env.EXPORT_DOWNLOAD_ROLE_ARN?.trim();
  const bucket = env.EXPORT_BUCKET?.trim();
  if (!roleArn || !bucket) return { ok: false, reason: 'misconfigured' };
  try {
    const url = await getSignedUrl(
      clientFor(roleArn),
      new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"` }),
      { expiresIn: PRESIGN_SECONDS },
    );
    return { ok: true, url };
  } catch (err) {
    return { ok: false, reason: 'error', errorName: err instanceof Error ? err.name : 'unknown' };
  }
}

/** Tests only: drop the cached client. */
export function __resetDownloadClientForTests(): void {
  cached = null;
}
