import { createHmac, randomUUID } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for one Supabase project's Auth server, so the real getClaims path runs with no
// project. It serves the project's JWKS, as a project with an asymmetric signing key does, and
// answers GET /user with 403 for every token, the answer Auth gives a token it did not sign.
// getClaims falls back to GET /user for a token it cannot check locally (an HS256 token, or a
// kid missing from the JWKS).

export interface TestKey {
  kid: string;
  privateKey: webcrypto.CryptoKey;
  publicJwk: webcrypto.JsonWebKey & { kid: string };
}

// An ES256 key pair with the JWK fields Supabase publishes for an ECC signing key.
export async function createTestKey(kid: string = randomUUID()): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...jwk, kid, alg: 'ES256', use: 'sig' },
  };
}

function encode(part: object): string {
  return Buffer.from(JSON.stringify(part)).toString('base64url');
}

// Signs claims as an ES256 JWT. `header` overrides or adds header fields, such as a foreign kid.
export async function signToken(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const signingInput = `${encode({ alg: 'ES256', typ: 'JWT', kid: key.kid, ...header })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

// An HS256 JWT, the shape of a token signed with a project's legacy shared secret.
export function signHs256Token(secret: string, claims: Record<string, unknown>): string {
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

// The claims Supabase puts in a signed-in user's access token, valid for another hour.
export function userClaims(sub: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'http://127.0.0.1/auth/v1',
    iat: now,
    exp: now + 3600,
    session_id: randomUUID(),
    is_anonymous: false,
    ...overrides,
  };
}

export interface FakeAuth {
  // Pass as the Supabase project URL.
  url: string;
  jwksRequests: number;
  userRequests: number;
  // When set, every Auth route answers with this status, as Auth does when it is down (503) or
  // rate limiting (429).
  failWith: number | null;
  close(): Promise<void>;
}

export async function startFakeAuth(keys: TestKey[]): Promise<FakeAuth> {
  const state = {
    jwksRequests: 0,
    userRequests: 0,
    failWith: null as number | null,
  };
  const server = createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      state.jwksRequests += 1;
    } else if (req.url === '/auth/v1/user') {
      state.userRequests += 1;
    } else {
      send(404, { message: 'not found' });
      return;
    }
    if (state.failWith !== null) {
      send(state.failWith, { code: 'unexpected_failure', message: 'fake auth failure' });
    } else if (req.url === '/auth/v1/user') {
      send(403, { code: 'bad_jwt', message: 'invalid JWT: unable to parse or verify signature' });
    } else {
      send(200, { keys: keys.map((key) => key.publicJwk) });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get jwksRequests() {
      return state.jwksRequests;
    },
    get userRequests() {
      return state.userRequests;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(status: number | null) {
      state.failWith = status;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
