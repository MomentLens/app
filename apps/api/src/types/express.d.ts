import type { AuthUser } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      // Set by requireAuth, or by optionalAuth, which sets null for a caller with no session.
      user?: AuthUser | null;
    }
  }
}
