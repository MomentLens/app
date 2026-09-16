import { z } from 'zod';

// Supabase settings the API cannot run without. index.ts reads them once at startup, so a
// missing or malformed value stops the process with a message naming the variable, instead of
// surfacing later as a failed query. The prefix check catches the easiest mistake, pasting the
// publishable key into the secret slot, which RLS would turn into every table reading as empty.
const Env = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().startsWith('sb_secret_', 'must be a secret key, sb_secret_...'),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment.\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
