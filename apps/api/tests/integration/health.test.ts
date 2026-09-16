import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from '@jest/globals';

import { HealthResponse } from '@momentlens/shared-types';

import { createApp } from '../../src/app';
import type { DatabaseState } from '../../src/services/health';

// Starts the app with a database check fixed to one answer, calls GET /health once, and closes.
async function getHealth(state: DatabaseState): Promise<Response> {
  const server = createApp({ checkDatabase: () => Promise.resolve(state) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/health`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('GET /health', () => {
  it('answers 200 with a body that matches the shared schema when the database is ok', async () => {
    const response = await getHealth('ok');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = HealthResponse.parse(await response.json());
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(Math.abs(Date.now() - Date.parse(body.checkedAt))).toBeLessThan(5000);
  });

  it('answers 503 with a degraded body that still matches the schema when the check fails', async () => {
    const response = await getHealth('error');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = HealthResponse.parse(await response.json());
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('error');
  });
});
