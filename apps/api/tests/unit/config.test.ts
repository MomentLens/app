// The API's startup settings. The Supabase key is the anon JWT since D-164, and the service-role JWT
// must never pass for it.
import { describe, expect, it } from '@jest/globals';

import { loadEnv } from '../../src/config';

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part(claims)}.signature`;
}

const valid = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon', iss: 'supabase' }),
  API_DATABASE_URL: 'postgresql://momentlens_api:password@127.0.0.1:5432/postgres',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'access',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
};

describe('loadEnv', () => {
  it('takes the anon JWT as the Supabase key', () => {
    expect(loadEnv(valid).SUPABASE_PUBLISHABLE_KEY).toBe(valid.SUPABASE_PUBLISHABLE_KEY);
  });

  it.each([
    ['the service-role JWT', jwt({ role: 'service_role' })],
    ['a JWT with no role', jwt({ iss: 'supabase' })],
    ['an sb_publishable_ key, which only Envoy understood', 'sb_publishable_abc'],
    ['a payload that is not JSON', 'header.bm90IGpzb24.signature'],
    ['a payload of null', `header.${Buffer.from('null').toString('base64url')}.signature`],
  ])('refuses %s', (_name, key) => {
    expect(() => loadEnv({ ...valid, SUPABASE_PUBLISHABLE_KEY: key })).toThrow(
      'SUPABASE_PUBLISHABLE_KEY',
    );
  });

  it('refuses a database URL that is not postgres://', () => {
    expect(() => loadEnv({ ...valid, API_DATABASE_URL: 'http://127.0.0.1:5432' })).toThrow(
      'API_DATABASE_URL',
    );
  });

  it('needs API_DATABASE_URL', () => {
    expect(() => loadEnv({ ...valid, API_DATABASE_URL: undefined })).toThrow('API_DATABASE_URL');
  });
});
