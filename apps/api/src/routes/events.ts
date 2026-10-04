import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface EventHandlers {
  create: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  createCoverUpload: RequestHandler;
  setCover: RequestHandler;
  getSettings: RequestHandler;
  updateSettings: RequestHandler;
  cancelJoinRequest: RequestHandler;
}

// requireAuth runs on each route, before the body is read, so an unauthenticated request is
// answered 401 without parsing anything it sent.
export function eventsRouter(auth: RequestHandler, handlers: EventHandlers): Router {
  const router = Router();
  router.post('/events', auth, jsonBody, handlers.create);
  router.get('/events', auth, handlers.list);
  router.get('/events/:eventId', auth, handlers.get);
  router.post('/events/:eventId/cover-upload', auth, handlers.createCoverUpload);
  router.put('/events/:eventId/cover', auth, jsonBody, handlers.setCover);
  router.get('/events/:eventId/settings', auth, handlers.getSettings);
  router.patch('/events/:eventId/settings', auth, jsonBody, handlers.updateSettings);
  router.delete('/events/:eventId/join-request', auth, handlers.cancelJoinRequest);
  return router;
}
