import type { Request, Response } from 'express';

import { HealthResponse } from '@momentlens/shared-types';

import type { DatabaseCheck } from '../services/health';

// GET /health. The body parses against the shared schema before it is sent, so the API cannot
// drift from the contract the app reads. A failed check answers 503, so an uptime probe needs
// only the status code, and no proxy may cache the answer.
export function healthController(checkDatabase: DatabaseCheck) {
  return async (_req: Request, res: Response): Promise<void> => {
    const database = await checkDatabase();
    const body = HealthResponse.parse({
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      checkedAt: new Date().toISOString(),
    });
    res
      .status(body.status === 'ok' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(body);
  };
}
