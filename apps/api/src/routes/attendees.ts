import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export function attendeesRouter(
  auth: RequestHandler,
  handlers: {
    list: RequestHandler;
    role: RequestHandler;
    remove: RequestHandler;
    block: RequestHandler;
  },
): Router {
  const router = Router();
  router.get('/events/:eventId/attendees', auth, handlers.list);
  router.patch('/events/:eventId/attendees/:userId/role', auth, jsonBody, handlers.role);
  router.post('/events/:eventId/attendees/:userId/remove', auth, jsonBody, handlers.remove);
  router.post('/events/:eventId/attendees/:userId/block', auth, jsonBody, handlers.block);
  return router;
}
