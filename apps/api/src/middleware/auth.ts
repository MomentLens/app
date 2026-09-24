import { isAuthError, isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

import type { Supabase } from '../db/supabase';
import { ApiError } from './errors';

export interface AuthUser {
  id: string;
}

// Resolves to the user a token belongs to, or null when the token is not a valid session for this
// project. Rejects when the token could not be checked at all, because Auth could not be reached.
export type VerifyToken = (token: string) => Promise<AuthUser | null>;

// The claims the API trusts once the signature is good. Supabase signs a signed-in user's access
// token with role `authenticated` and the user's id as `sub`. A token for any other role, such as
// a legacy anon key, is not a user.
const UserClaims = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
});

// True for an Auth answer that says the token is bad: a JWT that fails the local check, or a 4xx
// from Auth for one it checked itself. False for a network failure, a 5xx or a 429, which say
// nothing about the token.
function rejectsToken(error: unknown): boolean {
  if (!isAuthError(error) || isAuthRetryableFetchError(error)) {
    return false;
  }
  const status = error.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

// Checks a Supabase access token with getClaims (D-109). The project signs with an asymmetric key,
// so getClaims verifies the signature and expiry against the project's JWKS, which it fetches once
// and caches for ten minutes. It falls back to asking Auth only for a token it cannot check
// locally, an HS256 token or a kid the project does not publish, and Auth rejects any token it did
// not sign.
//
// Neither getClaims nor this check can see a sign-out: an access token stays valid until it
// expires, up to an hour (D-109, Cost).
export function createTokenVerifier(supabase: Supabase): VerifyToken {
  return async (token) => {
    let result: Awaited<ReturnType<Supabase['auth']['getClaims']>>;
    try {
      result = await supabase.auth.getClaims(token);
    } catch {
      // getClaims throws instead of returning an error for some malformed tokens: a header or
      // payload that is base64url but not JSON, a header that is not an object, an alg it has no
      // algorithm for. Its network failures come back as returned errors, so every throw here is
      // about the token.
      return null;
    }
    if (result.error) {
      if (rejectsToken(result.error)) {
        return null;
      }
      throw new Error('Could not check the access token with Supabase Auth', {
        cause: result.error,
      });
    }
    const claims = UserClaims.safeParse(result.data?.claims);
    return claims.success ? { id: claims.data.sub } : null;
  };
}

// "Bearer <token>". The scheme is case-insensitive (RFC 6750 §2.1).
const BEARER = /^bearer +(\S+)$/i;

// Every authenticated route runs this first. It answers 401 no_session unless the request carries
// a valid access token, and otherwise sets req.user, the one source of the caller's identity.
// Nothing downstream checks identity again, and nothing reads a user id from the request itself.
export function requireAuth(verify: VerifyToken): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    const user = match?.[1] === undefined ? null : await verify(match[1]);
    if (user === null) {
      throw new ApiError('no_session', 'Missing, invalid or expired access token');
    }
    req.user = user;
    next();
  };
}

// The caller on a route behind requireAuth. Throws when requireAuth did not run, which is a
// wiring mistake and answers 500 rather than serving the route to nobody in particular.
export function authenticatedUser(req: Request): AuthUser {
  if (req.user === undefined) {
    throw new Error(`requireAuth did not run before ${req.method} ${req.path}`);
  }
  return req.user;
}
