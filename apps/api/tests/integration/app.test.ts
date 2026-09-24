import { afterAll, beforeAll, expect, it } from '@jest/globals';

import { ErrorResponse } from '@momentlens/shared-types';

import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

let app: RunningApp;
let baseUrl: string;

beforeAll(async () => {
  app = await startApp(testDeps());
  baseUrl = app.baseUrl;
});

afterAll(async () => {
  await app.close();
});

it('answers a route that does not exist with 404 and the one error body', async () => {
  const response = await fetch(`${baseUrl}/no-such-route`);
  expect(response.status).toBe(404);
  expect(ErrorResponse.parse(await response.json()).error.code).toBe('not_found');
});

// Checked on a real route, because Express's own 404 handler sets some of these headers itself
// and would pass without helmet.
it('sends helmet security headers and hides the framework', async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-powered-by')).toBeNull();
});
