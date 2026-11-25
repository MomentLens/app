// The dev bucket refuses a GET without a signature (hb §11.3, D-57, root invariant 3). Every other
// serving test signs with a fake presigner, so this is the one that sends R2 the request.
//
// R2's S3 endpoint answers any request without a signature with 400 InvalidArgument, not 403, and
// it does so for a public bucket too: R2 serves a public bucket through r2.dev or a custom domain,
// never this endpoint. So this proves a key alone reads nothing here. It does not prove the bucket
// is private; that is the bucket's r2.dev and custom-domain settings, checked by hand in the
// Cloudflare dashboard (Ukasha, 2026-11-26).
//
// It reads the four R2_* settings from the root .env and runs with test:rls, beside the other
// dev-project tests (hb §13.4). REQUIRE_SUPABASE makes a missing setting fail there instead of
// skipping; plain `pnpm test` skips the file. It writes one small object at a subject-file key
// under a fresh media id that no row points at, and deletes it afterwards.
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { createR2 } from '../../src/lib/r2';

const settings = {
  accountId: process.env.R2_ACCOUNT_ID ?? '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  bucket: process.env.R2_BUCKET ?? '',
};
const configured = Object.values(settings).every((value) => value !== '');
if (process.env.REQUIRE_SUPABASE === '1' && !configured) {
  throw new Error(
    'r2-bucket.test.ts needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET',
  );
}
const describeR2 = configured ? describe : describe.skip;

describeR2('the dev bucket', () => {
  const r2 = createR2(settings);
  // The shape of a Do Not Publish subject's file (arch §3).
  const key = `${randomUUID()}/${randomUUID()}_v1.jpg`;

  afterAll(async () => {
    await r2.deleteObject(key);
  });

  it("refuses an unsigned GET of a subject's file that a signed GET reads", async () => {
    const put = await fetch(await r2.presignPut(key, 'image/jpeg'), {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(put.status).toBe(200);

    const signed = await r2.presignGet(key);
    expect((await fetch(signed)).status).toBe(200);

    // The same URL with its signature removed: the object's address on the bucket.
    const unsigned = new URL(signed);
    unsigned.search = '';
    expect(unsigned.pathname.endsWith(key)).toBe(true);
    const refused = await fetch(unsigned);
    const body = await refused.text();
    expect(refused.status).toBe(400);
    expect(body).toContain('<Code>InvalidArgument</Code>');
    expect(body).toContain('<Message>Authorization</Message>');
  });
});
