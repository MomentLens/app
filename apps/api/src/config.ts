import { z } from 'zod';

import type { R2Settings } from './lib/r2';

// Settings the API cannot run without. index.ts reads them once at startup, so a missing or
// malformed value stops the process with a message naming the variable, instead of surfacing
// later as a failed query or an unsigned URL. The API holds no Supabase secret key: its data
// goes through API_DATABASE_URL, a login that runs as service_role (D-164).
const Env = z.object({
  SUPABASE_URL: z.url(),
  // The anon JWT, the stack's ANON_KEY_ASYMMETRIC. Only the token check sends it, and Auth ignores
  // it, so it grants nothing. The sb_publishable_ key needed Envoy to swap it for this JWT (D-164).
  // The role is read because a service_role JWT here would be a secret in the wrong variable.
  SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .refine((key) => jwtRole(key) === 'anon', 'must be the anon JWT, whose role is anon'),
  // Postgres on the server's loopback. The login is momentlens_api, never the postgres superuser.
  API_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  // It becomes part of the R2 hostname, so anything else would sign URLs for a host that is not R2.
  R2_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'must be the 32-character Cloudflare account ID'),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});
export type Env = z.infer<typeof Env>;

// The role claim of a JWT, read without verifying the signature. That is enough to catch the wrong
// key in the wrong variable, which is all this is for.
function jwtRole(token: string): unknown {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null
      ? (claims as { role?: unknown }).role
      : undefined;
  } catch {
    return undefined;
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment.\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function r2Settings(env: Env): R2Settings {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  };
}
