import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';

import { ErrorResponse } from '@momentlens/shared-types';
import type { ErrorCode } from '@momentlens/shared-types';

// Handbook §5.3's table, code to status. A code added to ErrorCode fails typecheck here until it
// has a status, so the API cannot send a code without one.
const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  no_session: 401,
  not_member: 403,
  wrong_role: 403,
  not_uploader: 403,
  not_found: 404,
  duplicate: 409,
  album_closed: 409,
  unverified: 409,
  upload_missing: 409,
  event_full: 422,
  too_many_references: 422,
  internal_error: 500,
};

// An answer the API chose to give. Throw it, or pass it to next(), from any handler. The status
// comes from the code, so the two cannot disagree. `message` goes to the body for logs and is
// never shown to a user as it stands.
//
// `status` is also what Sentry's error handler reads, and it reports only 500 and above, so a
// 4xx ApiError never reaches Sentry.
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
  }
}

function body(code: ErrorCode, message: string): ErrorResponse {
  return ErrorResponse.parse({ error: { code, message } });
}

// After every route, so a path nothing matched gets the one error body instead of Express's HTML.
export const notFound: RequestHandler = (req, _res, next) => {
  next(new ApiError('not_found', `No route for ${req.method} ${req.path}`));
};

// The last middleware. It writes every error response the API sends (Handbook §5.3). Anything
// that is not an ApiError is a 500 whose body names no cause: the cause goes to the log here and
// to Sentry, whose handler runs just before this one.
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    // Express's own handler closes a connection whose response had already started.
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ApiError) {
      if (err.status === 401) {
        // A 401 must name the scheme it wants (RFC 9110 §15.5.2).
        res.set('WWW-Authenticate', 'Bearer');
      }
      res.status(err.status).json(body(err.code, err.message));
      return;
    }
    logger.error({ err, method: req.method, path: req.path }, 'request failed');
    res.status(500).json(body('internal_error', 'Internal error'));
  };
}
