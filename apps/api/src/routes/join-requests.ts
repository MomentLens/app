import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

// Pending Approvals (D-144). A batch names its targets in the body; block names one in the path.
export function joinRequestsRouter(
  auth: RequestHandler,
  handlers: {
    list: RequestHandler;
    approve: RequestHandler;
    reject: RequestHandler;
    block: RequestHandler;
  },
): Router {
  const router = Router();
  router.get('/events/:eventId/join-requests', auth, handlers.list);
  router.post('/events/:eventId/join-requests/approve', auth, jsonBody, handlers.approve);
  router.post('/events/:eventId/join-requests/reject', auth, jsonBody, handlers.reject);
  router.post('/events/:eventId/join-requests/:userId/block', auth, jsonBody, handlers.block);
  return router;
}
