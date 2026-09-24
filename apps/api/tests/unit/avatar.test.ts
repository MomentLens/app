// presignAvatar, the one function that presigns a profile photo (D-35, D-109, arch §1). It sees
// only user ids, never roles, so the Admin is one more viewer who is not the owner.
import { randomUUID } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';

import { PresignedImage } from '@momentlens/shared-types';

import { createR2 } from '../../src/lib/r2';
import type { PresignGet } from '../../src/lib/r2';
import { presignAvatar } from '../../src/services/avatar';
import type { AvatarOwner } from '../../src/services/avatar';
import { TEST_R2 } from '../support/app';

const OWNER = randomUUID();
const MEMBER = randomUUID();
const ADMIN = randomUUID();
const KEY = `users/${OWNER}/avatar_${randomUUID()}.jpg`;

function fakePresign() {
  return jest.fn<PresignGet>((key) =>
    Promise.resolve(`https://signed.test/${key}?X-Amz-Signature=abc`),
  );
}

function owner(overrides: Partial<AvatarOwner> = {}): AvatarOwner {
  return { userId: OWNER, avatarKey: KEY, dnpActive: false, ...overrides };
}

describe('presignAvatar', () => {
  it.each([
    ['the owner', OWNER],
    ['a member', MEMBER],
  ])('returns null to %s when there is no profile photo', async (_who, viewer) => {
    const presign = fakePresign();
    await expect(presignAvatar(owner({ avatarKey: null }), viewer, presign)).resolves.toBeNull();
    expect(presign).not.toHaveBeenCalled();
  });

  describe('when the owner has Do Not Publish active', () => {
    it.each([
      ['a member', MEMBER],
      ['the Admin', ADMIN],
    ])('returns null to %s and signs nothing', async (_who, viewer) => {
      const presign = fakePresign();
      await expect(presignAvatar(owner({ dnpActive: true }), viewer, presign)).resolves.toBeNull();
      expect(presign).not.toHaveBeenCalled();
    });

    it('returns the owner their own photo', async () => {
      const presign = fakePresign();
      await expect(presignAvatar(owner({ dnpActive: true }), OWNER, presign)).resolves.toEqual({
        url: `https://signed.test/${KEY}?X-Amz-Signature=abc`,
        cacheKey: KEY,
      });
      expect(presign).toHaveBeenCalledWith(KEY);
    });
  });

  it('presigns the photo for another viewer when Do Not Publish is off, cached by its key', async () => {
    const presign = fakePresign();
    const image = await presignAvatar(owner(), MEMBER, presign);
    expect(presign).toHaveBeenCalledWith(KEY);
    expect(image?.cacheKey).toBe(KEY);
  });

  it('returns a presigned R2 URL living one hour, never a bare bucket URL', async () => {
    const image = await presignAvatar(owner(), MEMBER, createR2(TEST_R2).presignGet);
    const parsed = PresignedImage.parse(image);
    expect(parsed.cacheKey).toBe(KEY);

    const url = new URL(parsed.url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
