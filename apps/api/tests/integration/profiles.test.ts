// GET /profiles/me and POST /profiles/me/consent (D-109, D-161). The token check is a fake here,
// keyed by token string; auth.test.ts covers the real one. The consent store is an in-memory fake;
// rls.test.ts runs the real one against the dev project. The avatar is presigned by the real R2
// presigner with test credentials.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  AcceptConsentResponse,
  ErrorResponse,
  PRIVACY_POLICY_VERSION,
  ProfileResponse,
} from '@momentlens/shared-types';

import type { AppDeps } from '../../src/app';
import type { VerifyToken } from '../../src/middleware/auth';
import type {
  AcceptConsentResult,
  ConsentStore,
  FindProfile,
  ProfileRecord,
} from '../../src/services/profiles';
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

// Holds each accepted (user, version) pair and records every call, as the consent table's key
// does: a second acceptance of the same version is a repeat and adds nothing.
class FakeConsent implements ConsentStore {
  readonly rows = new Set<string>();
  readonly reads: { userId: string; version: number }[] = [];
  readonly accepts: { userId: string; version: number }[] = [];
  // Accounts deleted since their token was issued, which the real insert's foreign key refuses.
  readonly deletedAccounts = new Set<string>();
  failWith: Error | null = null;

  accepted(userId: string, version: number): Promise<boolean> {
    this.reads.push({ userId, version });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.rows.has(`${userId}:${version}`));
  }

  accept(userId: string, version: number): Promise<AcceptConsentResult> {
    this.accepts.push({ userId, version });
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.deletedAccounts.has(userId)) return Promise.resolve('no_account');
    const key = `${userId}:${version}`;
    if (this.rows.has(key)) return Promise.resolve('repeated');
    this.rows.add(key);
    return Promise.resolve('created');
  }
}

const consent = new FakeConsent();

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return testDeps({ verifyToken, findProfile, consent, ...overrides });
}

let app: RunningApp;

beforeAll(async () => {
  app = await startApp(deps());
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  consent.rows.clear();
  consent.reads.length = 0;
  consent.accepts.length = 0;
  consent.deletedAccounts.clear();
  consent.failWith = null;
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
    expect(body).toEqual({
      userId: B,
      fullName: 'Bilal Ahmed',
      avatar: null,
      consentRequired: true,
    });
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

  it('asks for consent until the caller accepts the current version, and reads only theirs', async () => {
    const before = ProfileResponse.parse(await (await getMe('token-a')).json());
    expect(before.consentRequired).toBe(true);
    expect(consent.reads).toEqual([{ userId: A, version: PRIVACY_POLICY_VERSION }]);
    consent.rows.add(`${A}:${PRIVACY_POLICY_VERSION}`);
    const after = ProfileResponse.parse(await (await getMe('token-a')).json());
    expect(after.consentRequired).toBe(false);
  });

  it("still asks B for consent after A accepted, so another user's row never clears B's", async () => {
    consent.rows.add(`${A}:${PRIVACY_POLICY_VERSION}`);
    const body = ProfileResponse.parse(await (await getMe('token-b')).json());
    expect(body.consentRequired).toBe(true);
    expect(consent.reads).toEqual([{ userId: B, version: PRIVACY_POLICY_VERSION }]);
  });

  it('still asks for consent when the caller accepted only another version', async () => {
    consent.rows.add(`${A}:${PRIVACY_POLICY_VERSION + 1}`);
    const body = ProfileResponse.parse(await (await getMe('token-a')).json());
    expect(body.consentRequired).toBe(true);
  });
});

describe('POST /profiles/me/consent', () => {
  function accept(token?: string, body?: unknown, path = '/profiles/me/consent') {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(`${app.baseUrl}${path}`, init);
  }

  const current = { policyVersion: PRIVACY_POLICY_VERSION };

  async function errorCode(response: Response): Promise<string> {
    return ErrorResponse.parse(await response.json()).error.code;
  }

  it('answers 401 no_session with no token, and records nothing', async () => {
    const response = await accept(undefined, current);
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
    expect(consent.accepts).toEqual([]);
  });

  it('answers 401 no_session for a token the check rejects, and records nothing', async () => {
    const response = await accept('token-nobody', current);
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
    expect(consent.accepts).toEqual([]);
  });

  it.each([
    ['an older version', { policyVersion: PRIVACY_POLICY_VERSION - 1 }],
    ['a newer version', { policyVersion: PRIVACY_POLICY_VERSION + 1 }],
    ['the version as a string', { policyVersion: String(PRIVACY_POLICY_VERSION) }],
    ['no version', {}],
    ["another user's id beside the version", { ...current, userId: B }],
    ['an array', [current]],
  ])('answers 400 invalid_request for %s, and records nothing', async (_case, body) => {
    const response = await accept('token-a', body);
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
    expect(consent.accepts).toEqual([]);
  });

  it('answers 400 invalid_request for a body that is not JSON, and records nothing', async () => {
    const response = await accept('token-a', '{"policyVersion": 1');
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
    expect(consent.accepts).toEqual([]);
  });

  it('answers 400 invalid_request for no body at all, and records nothing', async () => {
    const response = await accept('token-a');
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
    expect(consent.accepts).toEqual([]);
  });

  it("records the caller's acceptance with 201, and GET /profiles/me stops asking", async () => {
    const response = await accept('token-a', current);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['policyVersion']);
    expect(AcceptConsentResponse.parse(json)).toEqual(current);
    expect(consent.accepts).toEqual([{ userId: A, version: PRIVACY_POLICY_VERSION }]);
    const me = ProfileResponse.parse(await (await getMe('token-a')).json());
    expect(me.consentRequired).toBe(false);
  });

  it('answers a repeat 200 with the same body, and keeps one row', async () => {
    await accept('token-a', current);
    const response = await accept('token-a', current);
    expect(response.status).toBe(200);
    expect(AcceptConsentResponse.parse(await response.json())).toEqual(current);
    expect([...consent.rows]).toEqual([`${A}:${PRIVACY_POLICY_VERSION}`]);
  });

  it("records B's acceptance for B only, so A is still asked", async () => {
    await accept('token-b', current);
    expect(consent.accepts).toEqual([{ userId: B, version: PRIVACY_POLICY_VERSION }]);
    const me = ProfileResponse.parse(await (await getMe('token-a')).json());
    expect(me.consentRequired).toBe(true);
  });

  it('ignores a user id in the query string: B naming A still records B', async () => {
    await accept('token-b', current, `/profiles/me/consent?userId=${A}`);
    expect(consent.accepts).toEqual([{ userId: B, version: PRIVACY_POLICY_VERSION }]);
  });

  it('answers 401 no_session when the account was deleted after the token was issued', async () => {
    consent.deletedAccounts.add(GONE);
    const response = await accept('token-gone', current);
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
  });

  it('answers 500 internal_error, naming no cause, when the store fails', async () => {
    consent.failWith = new Error('connection to db.example.supabase.co refused');
    const response = await accept('token-a', current);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe('internal_error');
    expect(text).not.toContain('supabase');
  });
});

describe('GET /profiles/me when something breaks', () => {
  async function getMeWith(find: FindProfile, store: ConsentStore = consent): Promise<Response> {
    const broken = await startApp(deps({ findProfile: find, consent: store }));
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

  it('answers 500 rather than say no consent is needed when the consent read fails', async () => {
    const failing: ConsentStore = {
      accepted: () => Promise.reject(new Error('connection to db.example.supabase.co refused')),
      accept: () => Promise.reject(new Error('not used here')),
    };
    const response = await getMeWith(findProfile, failing);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe('internal_error');
    expect(text).not.toContain('supabase');
  });
});
