import { Router } from 'express';
import type { RequestHandler } from 'express';

// requireAuth sits on the route, not on the router with router.use, which would also run it for
// every unmatched path this router sees and answer 401 where the answer is 404.
export function profilesRouter(auth: RequestHandler, getMine: RequestHandler): Router {
  const router = Router();
  router.get('/profiles/me', auth, getMine);
  return router;
}
