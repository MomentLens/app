import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface BlurRegionHandlers {
  add: RequestHandler;
  list: RequestHandler;
  remove: RequestHandler;
}

// requireAuth runs on each route before the body is read. Only POST has a body, a small JSON
// rectangle; no image byte comes this way (root invariant 5).
export function blurRegionsRouter(auth: RequestHandler, handlers: BlurRegionHandlers): Router {
  const router = Router();
  router.post('/media/:mediaId/blur-regions', auth, jsonBody, handlers.add);
  router.get('/media/:mediaId/blur-regions', auth, handlers.list);
  router.delete('/blur-regions/:regionId', auth, handlers.remove);
  return router;
}
