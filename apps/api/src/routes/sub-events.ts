import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface SubEventHandlers {
  list: RequestHandler;
  add: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

// requireAuth runs on each route, before the body is read, so an unauthenticated request is
// answered 401 without parsing anything it sent. A sub-event's own path carries no event id: the
// API reads the event from the sub-event's row (hb §5.3).
export function subEventsRouter(auth: RequestHandler, handlers: SubEventHandlers): Router {
  const router = Router();
  router.get('/events/:eventId/sub-events', auth, handlers.list);
  router.post('/events/:eventId/sub-events', auth, jsonBody, handlers.add);
  router.patch('/sub-events/:subEventId', auth, jsonBody, handlers.update);
  router.delete('/sub-events/:subEventId', auth, handlers.remove);
  return router;
}
