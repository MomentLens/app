import { Router } from 'express';
import type { RequestHandler } from 'express';

import { jsonBody } from '../middleware/body';

export interface ProfileHandlers {
  getMine: RequestHandler;
  acceptConsent: RequestHandler;
}

// requireAuth sits on the route, not on the router with router.use, which would also run it for
// every unmatched path this router sees and answer 401 where the answer is 404. It runs before the
// body is read, so an unauthenticated request is answered 401 without parsing anything it sent.
export function profilesRouter(auth: RequestHandler, handlers: ProfileHandlers): Router {
  const router = Router();
  router.get('/profiles/me', auth, handlers.getMine);
  router.post('/profiles/me/consent', auth, jsonBody, handlers.acceptConsent);
  return router;
}
