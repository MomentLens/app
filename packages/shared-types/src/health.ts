import { z } from 'zod';

/**
 * GET /health. The body has this shape whether the status code is 200 or 503.
 *
 * `database` is `error` when the API cannot read the seeded `health_check` row, because the
 * project is unreachable, the read timed out, or the row is missing. `status` is derived from
 * the individual checks, so a later check can join without changing what `ok` means to callers.
 */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['ok', 'error']),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
