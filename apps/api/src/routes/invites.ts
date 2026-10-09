import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface InviteHandlers {
  resolve: RequestHandler;
  join: RequestHandler;
  list: RequestHandler;
  regenerate: RequestHandler;
}

// Each auth middleware runs before the body is read, as in routes/events.ts. A lookup takes
// optionalAuth, since the signup banner and Manual Join Entry show the event before a session
// exists (D-115). A join takes requireAuth.
export function invitesRouter(
  optional: RequestHandler,
  auth: RequestHandler,
  handlers: InviteHandlers,
): Router {
  const router = Router();
  router.post('/invites/resolve', optional, jsonBody, handlers.resolve);
  router.post('/invites/join', auth, jsonBody, handlers.join);
  // Refusals carry no credentials, but they must not leave a cached management answer either.
  const noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  router.get('/events/:eventId/invites', noStore, auth, handlers.list);
  router.post('/events/:eventId/invites/regenerate', noStore, auth, jsonBody, handlers.regenerate);
  return router;
}
