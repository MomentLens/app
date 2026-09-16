// The negative test for health_check's RLS setup (D-73, docs/ARCHITECTURE.md §1). It needs a
// real project, so it reads SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for
// the dev project from the environment.
//
// `pnpm --filter api test:rls` loads them from the root .env and sets REQUIRE_SUPABASE, so a
// missing value fails there instead of skipping. Plain `pnpm test`, and so CI, skips this file,
// because CI never holds the secret key.
import { describe, expect, it } from '@jest/globals';
import { pino } from 'pino';

import { createServerClient } from '../../src/db/supabase';
import { createDatabaseCheck } from '../../src/services/health';

function projectFromEnv() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  return url && secretKey && publishableKey ? { url, secretKey, publishableKey } : null;
}

const project = projectFromEnv();
const required = process.env.REQUIRE_SUPABASE === '1';

if (project === null) {
  if (required) {
    it('has the dev project settings it needs', () => {
      throw new Error(
        'Set SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for the dev project in the root .env',
      );
    });
  } else {
    it.skip('needs the dev project; run pnpm --filter api test:rls', () => undefined);
  }
} else {
  const silent = pino({ level: 'silent' });

  describe('health_check in the dev project', () => {
    it('shows the seeded row to the secret key', async () => {
      const secret = createServerClient(project.url, project.secretKey);
      const result = await secret.from('health_check').select('id');
      expect(result.error).toBeNull();
      expect(result.data).toEqual([{ id: 1 }]);
    });

    it('shows no rows, and no error, to the publishable key', async () => {
      const publishable = createServerClient(project.url, project.publishableKey);
      const result = await publishable.from('health_check').select('id');
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    });

    it('reports ok through the real database check with the secret key', async () => {
      const check = createDatabaseCheck(createServerClient(project.url, project.secretKey), silent);
      await expect(check()).resolves.toBe('ok');
    });

    it('reports error, not ok, when the check is handed the publishable key', async () => {
      const check = createDatabaseCheck(
        createServerClient(project.url, project.publishableKey),
        silent,
      );
      await expect(check()).resolves.toBe('error');
    });
  });
}
