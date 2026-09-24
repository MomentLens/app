import { z } from 'zod';

/**
 * Every `code` an error body can carry, grouped by the status in Handbook §5.3's table. A slice
 * that adds a code adds it here and to that table in the same PR, so the API cannot send a code
 * the app has never heard of without failing typecheck.
 */
export const ErrorCode = z.enum([
  // 400
  'invalid_request',
  // 401
  'no_session',
  // 403
  'not_member',
  'wrong_role',
  'not_uploader',
  // 404
  'not_found',
  // 409
  'duplicate',
  'album_closed',
  'unverified',
  'upload_missing',
  // 422
  'event_full',
  'too_many_references',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The one error body, for every status except the 503 from GET /health (Handbook §5.3). The app
 * switches on `code`. `message` is for logs and never reaches a user as it stands.
 *
 * An installed app built before a code existed fails to parse a body that carries it. The client
 * then falls back to the HTTP status, which still says what kind of failure it was.
 */
export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
