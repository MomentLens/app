import * as Sentry from '@sentry/node';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import {
  createCoverUploadController,
  createEventController,
  getEventController,
  listEventsController,
  setEventCoverController,
} from './controllers/events';
import { healthController } from './controllers/health';
import {
  cancelJoinRequestController,
  joinEventController,
  resolveInviteController,
} from './controllers/invites';
import { getMyProfileController } from './controllers/profiles';
import type { ObjectExists, PresignGet, PresignPut } from './lib/r2';
import { optionalAuth, requireAuth } from './middleware/auth';
import type { VerifyToken } from './middleware/auth';
import { errorHandler, notFound } from './middleware/errors';
import { eventsRouter } from './routes/events';
import { healthRouter } from './routes/health';
import { invitesRouter } from './routes/invites';
import { profilesRouter } from './routes/profiles';
import type { EventStore } from './services/events';
import type { DatabaseCheck } from './services/health';
import type { InviteStore } from './services/invites';
import type { FindProfile } from './services/profiles';

// What the app needs from outside. index.ts builds the real ones from the environment, and tests
// pass fakes, so no test needs a Supabase project or an R2 account.
export interface AppDeps {
  logger: Logger;
  checkDatabase: DatabaseCheck;
  verifyToken: VerifyToken;
  findProfile: FindProfile;
  events: EventStore;
  invites: InviteStore;
  presignGet: PresignGet;
  presignPut: PresignPut;
  objectExists: ObjectExists;
}

// Built separately from index.ts so tests get an app without a listening port.
// Middleware and routes attach here, in the route → controller → service layering
// from apps/api/CLAUDE.md.
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());
  const auth = requireAuth(deps.verifyToken);
  app.use(healthRouter(healthController(deps.checkDatabase)));
  app.use(profilesRouter(auth, getMyProfileController(deps.findProfile, deps.presignGet)));
  app.use(
    eventsRouter(auth, {
      create: createEventController(deps.events, deps.presignGet),
      list: listEventsController(deps.events, deps.presignGet),
      get: getEventController(deps.events, deps.presignGet),
      createCoverUpload: createCoverUploadController(deps.events, deps.presignPut),
      setCover: setEventCoverController(deps.events, deps.objectExists, deps.presignGet),
      cancelJoinRequest: cancelJoinRequestController(deps.invites),
    }),
  );
  app.use(
    invitesRouter(optionalAuth(deps.verifyToken), auth, {
      resolve: resolveInviteController(deps.invites, deps.presignGet),
      join: joinEventController(deps.invites),
    }),
  );
  app.use(notFound);
  // After every route and before any other error middleware, so it sees each error a route passes
  // on. It reports errors with a status of 500 or more and hands every error to the next handler,
  // which writes the response. Without SENTRY_DSN it reports nothing.
  Sentry.setupExpressErrorHandler(app);
  app.use(errorHandler(deps.logger));
  return app;
}
