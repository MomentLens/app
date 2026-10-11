import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export function venueQrsRouter(
  auth: RequestHandler,
  handlers: { list: RequestHandler; regenerate: RequestHandler },
): Router {
  const router = Router();
  const noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  router.get('/events/:eventId/venue-qrs', noStore, auth, handlers.list);
  router.post(
    '/events/:eventId/venue-qrs/:venueId/regenerate',
    noStore,
    auth,
    jsonBody,
    handlers.regenerate,
  );
  return router;
}
