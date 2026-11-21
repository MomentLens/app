import { Router } from 'express';
import type { RequestHandler } from 'express';

export interface ReferenceHandlers {
  list: RequestHandler;
  createUpload: RequestHandler;
  add: RequestHandler;
  remove: RequestHandler;
}

// requireAuth runs on each route. No route reads a body: the photo reaches R2 by its presigned PUT
// and never passes through the API (root invariant 5). The upload route is declared before the
// :referenceId routes, though their methods differ, so no reader takes "upload" for an id.
export function referencesRouter(auth: RequestHandler, handlers: ReferenceHandlers): Router {
  const router = Router();
  router.get('/events/:eventId/references', auth, handlers.list);
  router.post('/events/:eventId/references/upload', auth, handlers.createUpload);
  router.put('/events/:eventId/references/:referenceId', auth, handlers.add);
  router.delete('/events/:eventId/references/:referenceId', auth, handlers.remove);
  return router;
}
