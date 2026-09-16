import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';

import { healthController } from './controllers/health';
import { healthRouter } from './routes/health';
import type { DatabaseCheck } from './services/health';

// What the app needs from outside. index.ts builds the real ones from the environment, and tests
// pass fakes, so no test needs a Supabase project.
export interface AppDeps {
  checkDatabase: DatabaseCheck;
}

// Built separately from index.ts so tests get an app without a listening port.
// Middleware and routes attach here, in the route → controller → service layering
// from apps/api/CLAUDE.md.
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());
  app.use(healthRouter(healthController(deps.checkDatabase)));
  return app;
}
