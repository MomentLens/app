import type { Logger } from 'pino';

import type { Supabase } from '../db/supabase';

export type DatabaseState = 'ok' | 'error';
export type DatabaseCheck = () => Promise<DatabaseState>;

// Long enough for a round trip to Frankfurt, short enough that a paused or unreachable project
// answers /health with 503 instead of holding the request open.
const READ_TIMEOUT_MS = 3000;

// Reads the one row the first migration seeds into health_check. Anything other than exactly
// that row is an error, including a missing row: a read with the wrong key returns no rows and
// no error, and that must never pass as healthy.
export function createDatabaseCheck(supabase: Supabase, logger: Logger): DatabaseCheck {
  return async () => {
    try {
      const result = await supabase
        .from('health_check')
        .select('id')
        .eq('id', 1)
        .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
        .maybeSingle();
      if (result.error) {
        logger.warn({ err: result.error }, 'health_check read failed');
        return 'error';
      }
      if (result.data === null) {
        logger.warn('health_check returned no row: wrong key, or the migration has not run');
        return 'error';
      }
      return 'ok';
    } catch (err) {
      logger.warn({ err }, 'health_check read threw');
      return 'error';
    }
  };
}
