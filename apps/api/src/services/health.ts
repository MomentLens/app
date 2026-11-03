import type { Logger } from 'pino';

import type { Sql } from '../db/sql';

export type DatabaseState = 'ok' | 'error';
export type DatabaseCheck = () => Promise<DatabaseState>;

// Reads the one row the first migration seeds into health_check. Anything other than exactly
// that row is an error, including a missing row, which means the migration has not run.
// The statement timeout on the pool bounds the read, so /health answers 503 instead of hanging.
export function createDatabaseCheck(sql: Sql, logger: Logger): DatabaseCheck {
  return async () => {
    try {
      const rows = await sql`select id from public.health_check where id = 1`;
      if (rows.length === 0) {
        logger.warn('health_check returned no row: the migration has not run');
        return 'error';
      }
      return 'ok';
    } catch (err) {
      logger.warn({ err }, 'health_check read failed');
      return 'error';
    }
  };
}
