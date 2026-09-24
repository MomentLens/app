import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';

import { createApp } from '../../src/app';
import type { AppDeps } from '../../src/app';
import { createR2 } from '../../src/lib/r2';

// R2 settings that presign for real, with no network and no account. A URL signed with them
// fails at R2, which no test sends it to.
export const TEST_R2 = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key-id',
  secretAccessKey: 'test-secret-access-key',
  bucket: 'momentlens-test',
};

// Dependencies for createApp that need no Supabase project. Each test overrides what it checks.
// The token check rejects every token unless a test passes a real one.
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    logger: pino({ level: 'silent' }),
    checkDatabase: () => Promise.resolve('ok'),
    verifyToken: () => Promise.resolve(null),
    findProfile: () => Promise.resolve(null),
    presignGet: createR2(TEST_R2).presignGet,
    ...overrides,
  };
}

export interface RunningApp {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startApp(deps: AppDeps): Promise<RunningApp> {
  const server = createApp(deps).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
