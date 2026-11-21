// POST /profiles/me/avatar-upload and PUT /profiles/me/avatar (spec §4.2, D-141, D-172,
// arch:profile). The profile store is a fake that records each avatar it sets; rls.test.ts checks
// profile_avatar_key_check against the dev project. URLs are presigned by the real R2 presigner
// with test credentials.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  CreateAvatarUploadResponse,
  ErrorResponse,
  SetAvatarResponse,
} from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import { startApp, TEST_R2, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const A = randomUUID();
const B = randomUUID();
// A valid session whose account has no profile row, as one deleted in the last hour has.
const GONE = randomUUID();

const tokens = new Map([
  ['token-a', A],
  ['token-b', B],
  ['token-gone', GONE],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

const avatarKeyFor = (userId: string, uploadId: string) => `users/${userId}/avatar_${uploadId}.jpg`;

const objects = new Set<string>();
const heads: string[] = [];
const sets: { userId: string; key: string }[] = [];

let app: RunningApp;

beforeAll(async () => {
  app = await startApp(
    testDeps({
      verifyToken,
      setAvatar: (userId, key) => {
        if (userId === GONE) return Promise.resolve(false);
        sets.push({ userId, key });
        return Promise.resolve(true);
      },
      objectExists: (key) => {
        heads.push(key);
        return Promise.resolve(objects.has(key));
      },
    }),
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  objects.clear();
  heads.length = 0;
  sets.length = 0;
});

function send(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

describe('POST /profiles/me/avatar-upload', () => {
  it('answers 401 no_session with no token', async () => {
    const response = await send('POST', '/profiles/me/avatar-upload');
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });

  it("presigns a PUT to a new key in the caller's own folder, and writes nothing", async () => {
    const response = await send('POST', '/profiles/me/avatar-upload', 'token-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = CreateAvatarUploadResponse.parse(await response.json());
    const url = new URL(body.uploadUrl);
    expect(url.pathname).toBe(`/${avatarKeyFor(A, body.uploadId)}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(sets).toEqual([]);
  });

  it('gives every upload a new id, so a new photo never reuses a cached one', async () => {
    const one = CreateAvatarUploadResponse.parse(
      await (await send('POST', '/profiles/me/avatar-upload', 'token-a')).json(),
    );
    const two = CreateAvatarUploadResponse.parse(
      await (await send('POST', '/profiles/me/avatar-upload', 'token-a')).json(),
    );
    expect(one.uploadId).not.toBe(two.uploadId);
  });
});

describe('PUT /profiles/me/avatar', () => {
  it('answers 401 no_session with no token, and never HEADs', async () => {
    const response = await send('PUT', '/profiles/me/avatar', undefined, {
      uploadId: randomUUID(),
    });
    expect(response.status).toBe(401);
    expect(heads).toEqual([]);
  });

  it.each([
    ['an uploadId that is not a uuid', { uploadId: 'avatar.jpg' }],
    ['no uploadId', {}],
    ['a key in place of an uploadId', { key: avatarKeyFor(B, randomUUID()) }],
  ])('answers 400 invalid_request for %s', async (_case, body) => {
    const response = await send('PUT', '/profiles/me/avatar', 'token-a', body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
    expect(sets).toEqual([]);
  });

  it('sets the avatar at the key built from the caller, and presigns it for them', async () => {
    const uploadId = randomUUID();
    const key = avatarKeyFor(A, uploadId);
    objects.add(key);
    const response = await send('PUT', '/profiles/me/avatar', 'token-a', { uploadId });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = SetAvatarResponse.parse(await response.json());
    expect(body.avatar.cacheKey).toBe(key);
    const url = new URL(body.avatar.url);
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${key}`);
    expect(heads).toEqual([key]);
    expect(sets).toEqual([{ userId: A, key }]);
  });

  it("answers 409 for another user's uploadId: the key lands in the caller's folder, where nothing is", async () => {
    const uploadId = randomUUID();
    objects.add(avatarKeyFor(B, uploadId));
    const response = await send('PUT', '/profiles/me/avatar', 'token-a', { uploadId });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('upload_missing');
    expect(heads).toEqual([avatarKeyFor(A, uploadId)]);
    expect(sets).toEqual([]);
  });

  it('answers 409 upload_missing for an object not in R2, and writes nothing', async () => {
    const response = await send('PUT', '/profiles/me/avatar', 'token-a', {
      uploadId: randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('upload_missing');
    expect(sets).toEqual([]);
  });

  it('sets the same avatar again on a repeat', async () => {
    const uploadId = randomUUID();
    objects.add(avatarKeyFor(A, uploadId));
    expect((await send('PUT', '/profiles/me/avatar', 'token-a', { uploadId })).status).toBe(200);
    expect((await send('PUT', '/profiles/me/avatar', 'token-a', { uploadId })).status).toBe(200);
    expect(sets).toHaveLength(2);
  });

  it('answers 401 no_session for a valid token whose account has no profile', async () => {
    const uploadId = randomUUID();
    objects.add(avatarKeyFor(GONE, uploadId));
    const response = await send('PUT', '/profiles/me/avatar', 'token-gone', { uploadId });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });
});
