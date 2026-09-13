import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, it } from '@jest/globals';

import { createApp } from '../../src/app';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

it('answers a route that does not exist with 404', async () => {
  const response = await fetch(`${baseUrl}/no-such-route`);
  expect(response.status).toBe(404);
});
