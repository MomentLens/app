// GET /profiles/me (D-109). The token check is a fake here, keyed by token string; auth.test.ts
// covers the real one. The avatar is presigned by the real R2 presigner with test credentials.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { ErrorResponse, ProfileResponse } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { FindProfile, ProfileRecord } from '../../src/services/profiles';
import { startApp, TEST_R2, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const A = randomUUID();
const B = randomUUID();
// Has a valid session and no profile row, as an account deleted in the last hour does.
const GONE = randomUUID();

const A_AVATAR = `users/${A}/avatar_${randomUUID()}.jpg`;

const profiles = new Map<string, ProfileRecord>([
  // Do Not Publish is active, which hides the avatar from everyone except A.
  [A, { userId: A, fullName: 'Ayesha Khan', avatarKey: A_AVATAR, dnpActive: true }],
  [B, { userId: B, fullName: 'Bilal Ahmed', avatarKey: null, dnpActive: false }],
]);

const tokens = new Map([
  ['token-a', A],
  ['token-b', B],
  ['token-gone', GONE],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

const findProfile: FindProfile = (userId) => Promise.resolve(profiles.get(userId) ?? null);

let app: RunningApp;

beforeAll(async () => {
  app = await startApp(testDeps({ verifyToken, findProfile }));
});

afterAll(async () => {
  await app.close();
});

function getMe(token?: string, path = '/profiles/me'): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

describe('GET /profiles/me', () => {
  it('answers 401 no_session with no token', async () => {
    const response = await getMe();
    expect(response.status).toBe(401);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('no_session');
  });

  it('answers 401 no_session for a token the check rejects', async () => {
    const response = await getMe('token-nobody');
    expect(response.status).toBe(401);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('no_session');
  });

  it('returns the caller their own profile, with their avatar under Do Not Publish', async () => {
    const response = await getMe('token-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = ProfileResponse.parse(await response.json());
    expect(body.userId).toBe(A);
    expect(body.fullName).toBe('Ayesha Khan');
    expect(body.avatar?.cacheKey).toBe(A_AVATAR);

    const url = new URL(body.avatar?.url ?? '');
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${A_AVATAR}`);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns A's row to B", async () => {
    const response = await getMe('token-b');
    const text = await response.text();
    const body = ProfileResponse.parse(JSON.parse(text));
    expect(body).toEqual({ userId: B, fullName: 'Bilal Ahmed', avatar: null });
    expect(text).not.toContain(A);
    expect(text).not.toContain('Ayesha');
  });

  it("ignores a user id in the query string: B asking for A's id still gets B", async () => {
    const response = await getMe('token-b', `/profiles/me?userId=${A}&user_id=${A}`);
    expect(ProfileResponse.parse(await response.json()).userId).toBe(B);
  });

  it("has no route that takes another user's id", async () => {
    const response = await getMe('token-b', `/profiles/${A}`);
    expect(response.status).toBe(404);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('not_found');
  });

  it('answers 401 no_session for a valid token whose account has no profile', async () => {
    const response = await getMe('token-gone');
    expect(response.status).toBe(401);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('no_session');
  });
});

describe('GET /profiles/me when something breaks', () => {
  async function getMeWith(find: FindProfile): Promise<Response> {
    const broken = await startApp(testDeps({ verifyToken, findProfile: find }));
    try {
      return await fetch(`${broken.baseUrl}/profiles/me`, {
        headers: { Authorization: 'Bearer token-a' },
      });
    } finally {
      await broken.close();
    }
  }

  it('answers 500 internal_error, naming no cause, when the read fails', async () => {
    const response = await getMeWith(() =>
      Promise.reject(new Error('connection to db.example.supabase.co refused')),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe('internal_error');
    expect(text).not.toContain('supabase');
  });

  it('answers 500 rather than send a stored name the contract rejects', async () => {
    const response = await getMeWith((userId) =>
      Promise.resolve({ userId, fullName: '   ', avatarKey: null, dnpActive: false }),
    );
    expect(response.status).toBe(500);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('internal_error');
  });
});
