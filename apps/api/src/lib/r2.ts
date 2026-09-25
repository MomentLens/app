import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// A presigned GET URL lives one hour, and a presigned PUT URL 15 minutes (arch §3, D-105).
const GET_URL_SECONDS = 3600;
const PUT_URL_SECONDS = 900;

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

// Signs a PUT of one object key with this content type. The caller has already decided the
// requester may upload it, and built the key in lib/keys.ts (root invariant 12).
export type PresignPut = (key: string, contentType: string) => Promise<string>;

// Sends R2 a HEAD for one key. True when the object is there, false on a 404, and a rejection for
// anything else, which says nothing about the object.
export type ObjectExists = (key: string) => Promise<boolean>;

export interface R2 {
  presignGet: PresignGet;
  presignPut: PresignPut;
  objectExists: ObjectExists;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return status === 404;
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
    // By default the SDK puts a CRC32 of the request body in a presigned PUT URL. The body is
    // empty when it signs, so R2 would compare that checksum with the real upload and refuse it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    presignGet: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: settings.bucket, Key: key }), {
        expiresIn: GET_URL_SECONDS,
      }),
    // Content-Type goes in the signature, so the upload must be sent with exactly this type and
    // R2 stores the object as it. Unsigned, a client could store an HTML page under a .jpg key.
    presignPut: (key, contentType) =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: settings.bucket, Key: key, ContentType: contentType }),
        { expiresIn: PUT_URL_SECONDS, signableHeaders: new Set(['content-type']) },
      ),
    objectExists: async (key) => {
      try {
        await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
        return true;
      } catch (error) {
        if (isNotFound(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}
