// The R2 client's PUT presigner and HEAD check, used by the cover endpoints (arch §3, D-110).
// Signing is local, so the URLs are inspected as signed. The HEAD is stubbed at the SDK's send.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { createR2 } from '../../src/lib/r2';
import { TEST_R2 } from '../support/app';

const KEY =
  'events/2f1c7a36-8a51-4c43-9b7c-6f2a1d0e5b11/cover_9d3e1f22-5b7a-4c1e-8f60-1a2b3c4d5e6f.jpg';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('presignPut', () => {
  it('signs a PUT to the object on R2 that lives 15 minutes (D-105)', async () => {
    const url = new URL(await createR2(TEST_R2).presignPut(KEY, 'image/jpeg'));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the content type, so the upload must be sent as a JPEG', async () => {
    const url = new URL(await createR2(TEST_R2).presignPut(KEY, 'image/jpeg'));
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-type');
  });

  it('carries no checksum of an empty body, which R2 would compare with the upload and refuse', async () => {
    const url = new URL(await createR2(TEST_R2).presignPut(KEY, 'image/jpeg'));
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(names.filter((name) => name.includes('checksum'))).toEqual([]);
  });
});

describe('objectExists', () => {
  function sdkError(name: string, status: number): Error {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  }

  it('sends a HEAD for the key in the bucket and answers true when R2 has it', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    await expect(createR2(TEST_R2).objectExists(KEY)).resolves.toBe(true);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect((command as HeadObjectCommand).input).toEqual({ Bucket: TEST_R2.bucket, Key: KEY });
  });

  it('answers false for a 404', async () => {
    jest.spyOn(S3Client.prototype, 'send').mockRejectedValue(sdkError('NotFound', 404) as never);
    await expect(createR2(TEST_R2).objectExists(KEY)).resolves.toBe(false);
  });

  it.each([
    ['a 403, which says nothing about the object', sdkError('Forbidden', 403)],
    ['a 500', sdkError('InternalError', 500)],
    ['a network failure', new Error('socket hang up')],
  ])('rethrows %s rather than call the object missing', async (_case, error) => {
    jest.spyOn(S3Client.prototype, 'send').mockRejectedValue(error as never);
    await expect(createR2(TEST_R2).objectExists(KEY)).rejects.toBe(error);
  });
});
