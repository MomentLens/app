import { Router } from 'express';
import type { RequestHandler } from 'express';

export interface ReviewQueueHandlers {
  listFlags: RequestHandler;
  keepFlags: RequestHandler;
  listBlurRegions: RequestHandler;
  keepBlurRegion: RequestHandler;
}

// requireAuth runs on each route before any parameter or query is parsed. None of these routes
// reads a request body (root invariant 5).
export function reviewQueueRouter(auth: RequestHandler, handlers: ReviewQueueHandlers): Router {
  const router = Router();
  router.get('/events/:eventId/review-queue/flags', auth, handlers.listFlags);
  router.post('/media/:mediaId/flags/keep', auth, handlers.keepFlags);
  router.get('/events/:eventId/review-queue/blur-regions', auth, handlers.listBlurRegions);
  router.post('/blur-regions/:regionId/keep', auth, handlers.keepBlurRegion);
  return router;
}
