import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface MediaHandlers {
  status: RequestHandler;
  preflight: RequestHandler;
  complete: RequestHandler;
  listAlbum: RequestHandler;
  listUploaders: RequestHandler;
  serveImages: RequestHandler;
}

// requireAuth runs on each route, before the body is read, so an unauthenticated request is
// answered 401 without parsing anything it sent. Pre-flight reads JSON only, and completion reads no
// body, so no image byte is ever read here (root invariant 5).
export function mediaRouter(auth: RequestHandler, handlers: MediaHandlers): Router {
  const router = Router();
  router.get('/events/:eventId/media/uploaders', auth, handlers.listUploaders);
  router.get('/events/:eventId/media', auth, handlers.listAlbum);
  router.post('/events/:eventId/media/images', auth, jsonBody, handlers.serveImages);
  router.post('/events/:eventId/media/status', auth, jsonBody, handlers.status);
  router.post('/events/:eventId/media/preflight', auth, jsonBody, handlers.preflight);
  router.post('/media/:mediaId/complete', auth, handlers.complete);
  return router;
}
