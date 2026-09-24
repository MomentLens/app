import { z } from 'zod';

import type { R2Settings } from './lib/r2';

// Settings the API cannot run without. index.ts reads them once at startup, so a missing or
// malformed value stops the process with a message naming the variable, instead of surfacing
// later as a failed query or an unsigned URL. The prefix check catches the easiest mistake,
// pasting the publishable key into the secret slot, which RLS would turn into every table
// reading as empty.
const Env = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().startsWith('sb_secret_', 'must be a secret key, sb_secret_...'),
  // It becomes part of the R2 hostname, so anything else would sign URLs for a host that is not R2.
  R2_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'must be the 32-character Cloudflare account ID'),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});
export type Env = z.infer<typeof Env>;

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
