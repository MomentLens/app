// The negative tests for RLS on health_check, profile and subject (D-73, docs/ARCHITECTURE.md §1),
// and the tests that need real Auth: the trigger that creates a profile, the cascades, and
// getClaims on a token the project signed (D-109). It needs a real project, so it reads
// SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for the dev project from the
// environment. Each test makes its own accounts under @momentlens.me and deletes them after. No
// email is sent, because the accounts are created confirmed through the admin API.
//
// `pnpm --filter api test:rls` loads them from the root .env when it exists and sets
// REQUIRE_SUPABASE, so a missing value fails there instead of skipping. Plain `pnpm test` skips
// this file. CI runs test:rls in .github/workflows/rls.yml with the dev project's keys as
// repository secrets (D-106).
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { createClient } from '@supabase/supabase-js';
import { pino } from 'pino';

import { createServerClient } from '../../src/db/supabase';
import { createTokenVerifier } from '../../src/middleware/auth';
import { createDatabaseCheck } from '../../src/services/health';
import { createFindProfile } from '../../src/services/profiles';

// A test here makes up to about 20 requests in sequence to the dev project in Frankfurt, two of
// them account creations, and from a GitHub runner that passed Jest's default 5 seconds.
jest.setTimeout(30_000);

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

  describe('profile and subject in the dev project', () => {
    const admin = createServerClient(project.url, project.secretKey);
    const created: string[] = [];

    afterAll(async () => {
      for (const id of created) {
        await admin.auth.admin.deleteUser(id);
      }
    });

    function newEmail(): string {
      return `rls-test+${randomUUID()}@momentlens.me`;
    }

    // Creates a confirmed account with this signup metadata, as the app's signUp sends it.
    async function createUser(metadata: Record<string, unknown>, email = newEmail()) {
      const password = randomUUID();
      const result = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: metadata,
      });
      if (result.data.user) {
        created.push(result.data.user.id);
      }
      return { ...result, email, password };
    }

    async function createNamedUser(fullName = 'Test User') {
      const result = await createUser({ full_name: fullName });
      expect(result.error).toBeNull();
      if (result.data.user === null) {
        throw new Error('createUser returned no user');
      }
      return { id: result.data.user.id, email: result.email, password: result.password };
    }

    async function readProfile(userId: string) {
      const result = await admin
        .from('profile')
        .select('user_id, full_name, avatar_key, notify_approval, notify_album')
        .eq('user_id', userId)
        .maybeSingle();
      expect(result.error).toBeNull();
      return result.data;
    }

    async function countSubjects(userId: string): Promise<number> {
      const result = await admin
        .from('subject')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      expect(result.error).toBeNull();
      return result.count ?? -1;
    }

    it('creates the profile from the signup name, trimmed, with both notifications on', async () => {
      // U+3000 and U+00A0 are whitespace to String.prototype.trim, which FullName uses.
      const user = await createNamedUser('\u3000 Ayesha Khan\u00a0\t');
      await expect(readProfile(user.id)).resolves.toEqual({
        user_id: user.id,
        full_name: 'Ayesha Khan',
        avatar_key: null,
        notify_approval: true,
        notify_album: true,
      });
    });

    it('counts code points, so a name of 80 emoji is accepted', async () => {
      const name = '\u{1F600}'.repeat(80);
      const user = await createNamedUser(name);
      expect((await readProfile(user.id))?.full_name).toBe(name);
    });

    it.each([
      ['no name', {}],
      ['a blank name', { full_name: ' \u3000\t\u00a0' }],
      ['an 81-character name', { full_name: 'a'.repeat(81) }],
      ['a name that is not a string', { full_name: 42 }],
    ])(
      'refuses signup with %s, so no account exists without a profile',
      async (_case, metadata) => {
        const email = newEmail();
        const refused = await createUser(metadata, email);
        expect(refused.error).not.toBeNull();
        expect(refused.data.user).toBeNull();

        // The same address signs up with a valid name, which it could not if the refused attempt
        // had left an account behind.
        const retried = await createUser({ full_name: 'Valid Name' }, email);
        expect(retried.error).toBeNull();
      },
    );

    it('keeps one subject per user, and any number with no user', async () => {
      const user = await createNamedUser();
      expect((await admin.from('subject').insert({ user_id: user.id })).error).toBeNull();
      const second = await admin.from('subject').insert({ user_id: user.id });
      expect(second.error?.code).toBe('23505');

      const proxies = await admin
        .from('subject')
        .insert([{ user_id: null }, { user_id: null }])
        .select('id');
      expect(proxies.error).toBeNull();
      const proxyIds = (proxies.data ?? []).map((row: { id: string }) => row.id);
      expect(proxyIds).toHaveLength(2);
      expect((await admin.from('subject').delete().in('id', proxyIds)).error).toBeNull();
    });

    it('deletes the profile and the subject with the account (ON DELETE CASCADE)', async () => {
      const user = await createNamedUser();
      expect((await admin.from('subject').insert({ user_id: user.id })).error).toBeNull();
      expect((await admin.auth.admin.deleteUser(user.id)).error).toBeNull();
      await expect(readProfile(user.id)).resolves.toBeNull();
      await expect(countSubjects(user.id)).resolves.toBe(0);
    });

    // Every write is checked by its effect, read back with the secret key, so the test does not
    // depend on whether the refusal arrives as an error or as zero rows.
    async function expectNoAccess(client: ReturnType<typeof createServerClient>, ownId: string) {
      const other = await createNamedUser('Other Person');
      await admin.from('subject').insert({ user_id: other.id });

      for (const table of ['profile', 'subject'] as const) {
        const read = await client.from(table).select('*');
        expect(read.error).toBeNull();
        expect(read.data).toEqual([]);
      }

      for (const target of [ownId, other.id]) {
        await client.from('profile').update({ full_name: 'Changed' }).eq('user_id', target);
        await client.from('profile').delete().eq('user_id', target);
        await client
          .from('subject')
          .update({ dnp_activated_at: new Date().toISOString() })
          .eq('user_id', target);
        await client.from('subject').delete().eq('user_id', target);
      }
      expect((await readProfile(other.id))?.full_name).toBe('Other Person');
      expect(await readProfile(ownId)).not.toBeNull();
      await expect(countSubjects(other.id)).resolves.toBe(1);
      const otherSubject = await admin
        .from('subject')
        .select('dnp_activated_at')
        .eq('user_id', other.id)
        .single();
      expect(otherSubject.data).toEqual({ dnp_activated_at: null });

      const stranger = randomUUID();
      await client.from('profile').insert({ user_id: stranger, full_name: 'Inserted' });
      await client.from('subject').insert({ user_id: ownId });
      await expect(readProfile(stranger)).resolves.toBeNull();
      await expect(countSubjects(ownId)).resolves.toBe(0);
    }

    it('shows the publishable key no rows and lets it write nothing', async () => {
      const own = await createNamedUser();
      await expectNoAccess(createServerClient(project.url, project.publishableKey), own.id);
    });

    it('shows a signed-in user no rows, their own included, and lets them write nothing', async () => {
      const own = await createNamedUser();
      const session = await createServerClient(
        project.url,
        project.publishableKey,
      ).auth.signInWithPassword({ email: own.email, password: own.password });
      expect(session.error).toBeNull();
      const accessToken = session.data.session?.access_token ?? '';

      const asUser = createClient(project.url, project.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      await expectNoAccess(asUser, own.id);
    });

    it("reads the caller's profile through the API's service", async () => {
      const user = await createNamedUser('Service Reader');
      const find = createFindProfile(admin);
      await expect(find(user.id)).resolves.toEqual({
        userId: user.id,
        fullName: 'Service Reader',
        avatarKey: null,
        dnpActive: false,
      });
      await expect(find(randomUUID())).resolves.toBeNull();
    });

    it('verifies a token the project signed, locally, with an asymmetric key (arch §7)', async () => {
      const user = await createNamedUser();
      const session = await createServerClient(
        project.url,
        project.publishableKey,
      ).auth.signInWithPassword({ email: user.email, password: user.password });
      const accessToken = session.data.session?.access_token ?? '';

      const header = JSON.parse(
        Buffer.from(accessToken.split('.')[0] ?? '', 'base64url').toString(),
      ) as { alg?: string; kid?: string };
      expect(header.alg).toMatch(/^(ES|RS)256$/);
      expect(header.kid).toEqual(expect.any(String));

      const verify = createTokenVerifier(createServerClient(project.url, project.secretKey));
      await expect(verify(accessToken)).resolves.toEqual({ id: user.id });
    });
  });
}
