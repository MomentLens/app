// requireAuth against the real getClaims check (D-109). A fake Auth server stands in for the
// project, serving its JWKS, so every token here is checked the way production checks one. The
// same check against a token from the dev project is in rls.test.ts.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { createClient } from '@supabase/supabase-js';

import { ErrorResponse } from '@momentlens/shared-types';

import { createTokenVerifier } from '../../src/middleware/auth';
import type { FindProfile } from '../../src/services/profiles';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';
import {
  createTestKey,
  signHs256Token,
  signToken,
  startFakeAuth,
  userClaims,
} from '../support/fake-auth';
import type { FakeAuth, TestKey } from '../support/fake-auth';

// Answers every user with a profile, so the response says which user requireAuth attached.
const echoProfile: FindProfile = (userId) =>
  Promise.resolve({ userId, fullName: 'Test User', avatarKey: null, dnpActive: false });

function startAppAgainst(auth: FakeAuth): Promise<RunningApp> {
  // auth-js caches the JWKS in a module-level map keyed by the client's storage key, which every
  // client for 127.0.0.1 shares. A storage key of its own gives each app an empty cache.
  const client = createClient(auth.url, 'sb_secret_test', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `sb-test-${randomUUID()}`,
    },
  });
  const verifyToken = createTokenVerifier(client);
  return startApp(testDeps({ verifyToken, findProfile: echoProfile }));
}

function getMe(app: RunningApp, authorization?: string): Promise<Response> {
  return fetch(`${app.baseUrl}/profiles/me`, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

async function expectNoSession(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
  const body = ErrorResponse.parse(await response.json());
  expect(body.error.code).toBe('no_session');
}

let projectKey: TestKey;
let otherProjectKey: TestKey;
let auth: FakeAuth;
let app: RunningApp;

beforeAll(async () => {
  projectKey = await createTestKey();
  otherProjectKey = await createTestKey();
  auth = await startFakeAuth([projectKey]);
  app = await startAppAgainst(auth);
});

afterAll(async () => {
  await app.close();
  await auth.close();
});

beforeEach(() => {
  auth.failWith = null;
});

describe('requireAuth', () => {
  it("accepts a token the project signed and attaches the token's sub as the user", async () => {
    const userId = randomUUID();
    const token = await signToken(projectKey, userClaims(userId));
    const response = await getMe(app, `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { userId: string }).userId).toBe(userId);
  });

  it('accepts the scheme in any case, as RFC 6750 allows', async () => {
    const token = await signToken(projectKey, userClaims(randomUUID()));
    expect((await getMe(app, `bearer ${token}`)).status).toBe(200);
  });

  describe('answers 401 no_session', () => {
    it('with no Authorization header', async () => {
      await expectNoSession(await getMe(app));
    });

    it.each([
      ['an empty bearer', 'Bearer '],
      ['another scheme', 'Basic dXNlcjpwYXNz'],
      ['a token with no scheme', 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln'],
      ['a value that is not a JWT', 'Bearer not-a-jwt'],
      ['three base64url parts that are not JSON', 'Bearer aGVsbG8.d29ybGQ.c2ln'],
      [
        'a header that decodes to null',
        `Bearer ${Buffer.from('null').toString('base64url')}.e30.c2ln`,
      ],
    ])('for %s', async (_case, authorization) => {
      await expectNoSession(await getMe(app, authorization));
    });

    it('for an expired token the project signed', async () => {
      const token = await signToken(
        projectKey,
        userClaims(randomUUID(), { exp: Math.floor(Date.now() / 1000) - 1 }),
      );
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });

    it('for a token with no exp', async () => {
      const claims: Record<string, unknown> = userClaims(randomUUID());
      delete claims.exp;
      await expectNoSession(await getMe(app, `Bearer ${await signToken(projectKey, claims)}`));
    });

    it("for a token whose payload was swapped for another user's", async () => {
      const [header, , signature] = (await signToken(projectKey, userClaims(randomUUID()))).split(
        '.',
      );
      const forged = Buffer.from(JSON.stringify(userClaims(randomUUID()))).toString('base64url');
      await expectNoSession(await getMe(app, `Bearer ${header}.${forged}.${signature}`));
    });

    it('for a token claiming alg none', async () => {
      const [, payload] = (await signToken(projectKey, userClaims(randomUUID()))).split('.');
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT', kid: projectKey.kid }),
      ).toString('base64url');
      await expectNoSession(await getMe(app, `Bearer ${header}.${payload}.`));
    });

    it("for another project's token, whose kid this project does not publish", async () => {
      const token = await signToken(otherProjectKey, userClaims(randomUUID()));
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });

    it("for another project's token that reuses this project's kid", async () => {
      const token = await signToken(otherProjectKey, userClaims(randomUUID()), {
        kid: projectKey.kid,
      });
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });

    it('for an HS256 token, which Auth does not recognize', async () => {
      const token = signHs256Token('a-guessed-secret', userClaims(randomUUID()));
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });

    it('for a token the project signed for a role other than authenticated', async () => {
      const token = await signToken(projectKey, userClaims(randomUUID(), { role: 'anon' }));
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });

    it('for a token the project signed whose sub is not a user id', async () => {
      const token = await signToken(projectKey, userClaims('not-a-uuid'));
      await expectNoSession(await getMe(app, `Bearer ${token}`));
    });
  });

  // A 401 sends the app to refresh its session. An outage is not a dead session, so it answers
  // 500, which Sentry reports and the app shows as an error.
  describe('answers 500 internal_error when it cannot check the token', () => {
    it.each([
      ['Auth is down', 503],
      ['Auth is rate limiting', 429],
    ])('when %s', async (_case, status) => {
      const coldApp = await startAppAgainst(auth);
      try {
        auth.failWith = status;
        const token = await signToken(projectKey, userClaims(randomUUID()));
        const response = await getMe(coldApp, `Bearer ${token}`);
        expect(response.status).toBe(500);
        expect(ErrorResponse.parse(await response.json()).error.code).toBe('internal_error');
      } finally {
        await coldApp.close();
      }
    });
  });

  it('checks tokens against the cached JWKS, with no call to Auth per request', async () => {
    const coldApp = await startAppAgainst(auth);
    try {
      const jwksBefore = auth.jwksRequests;
      const userBefore = auth.userRequests;
      for (let i = 0; i < 3; i += 1) {
        const token = await signToken(projectKey, userClaims(randomUUID()));
        expect((await getMe(coldApp, `Bearer ${token}`)).status).toBe(200);
      }
      expect(auth.jwksRequests - jwksBefore).toBe(1);
      expect(auth.userRequests - userBefore).toBe(0);
    } finally {
      await coldApp.close();
    }
  });
});
