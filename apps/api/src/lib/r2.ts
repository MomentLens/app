import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// A presigned GET URL lives one hour (arch §3).
const GET_URL_SECONDS = 3600;

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  // momentlens-dev or momentlens-stable, matching the Supabase project (arch §3)
  bucket: string;
}

// Signs a GET for one object key. It checks nothing about who asked; the caller has already
// decided the requester may have this file (root invariant 3).
export type PresignGet = (key: string) => Promise<string>;

export interface R2 {
  presignGet: PresignGet;
}

// The API's one R2 client. Signing is local, with no request to R2, so a presigned URL says
// nothing about whether the object exists. Both buckets are private, so a URL without a
// signature is refused, which is why nothing here ever returns one (D-57).
export function createR2(settings: R2Settings): R2 {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  });

  return {
    presignGet: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: settings.bucket, Key: key }), {
        expiresIn: GET_URL_SECONDS,
      }),
  };
}
