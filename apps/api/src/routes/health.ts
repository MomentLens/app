import { Router } from 'express';
import type { RequestHandler } from 'express';

// Unauthenticated on purpose. The body says only whether the database answered, never what is
// in it, so there is nothing here worth a login.
export function healthRouter(handler: RequestHandler): Router {
  const router = Router();
  router.get('/health', handler);
  return router;
}
