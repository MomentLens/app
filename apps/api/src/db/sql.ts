import postgres from 'postgres';

// How long one query may run. The phone gives up after 10 s, so a stalled query fails here first.
export const DATABASE_TIMEOUT_MS = 3000;

// How long opening a connection may take, in seconds, as postgres.js counts it.
const CONNECT_TIMEOUT_S = 3;

// Postgres prints a timestamp as "2026-11-03 10:00:00.123456+00" and its JSON as
// "2026-11-03T10:00:00.123456+00:00". PostgREST sent the JSON form, so the schemas expect it.
function timestamptzAsJson(text: string): string {
  return text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
}

// The API's connections to Postgres. It logs in as momentlens_api, which runs every statement as
// service_role, so RLS never applies and every authorization decision lives in the service layer
// (D-73, D-164). The SQL functions take the user as an argument; none reads auth.uid().
//
// PostgREST returned every row as Postgres's own JSON. These types keep those shapes, so the zod
// schemas read the values they always did. A timestamp stays a string at full precision: a Date
// keeps milliseconds only, and the album's keyset cursor would then skip photos (D-164). A bigint
// is a number, as count(*) and pgmq's message ids always fit in one.
export function createSql(url: string, { timeoutMs }: { timeoutMs?: number } = {}) {
  return postgres(url, {
    max: 10,
    connect_timeout: CONNECT_TIMEOUT_S,
    // Closes a connection nobody has used for a minute, so a quiet API holds few of Postgres's.
    idle_timeout: 60,
    // A NOTICE from a SQL function is not an error, and console.log would bypass pino.
    onnotice: () => undefined,
    connection: {
      application_name: 'momentlens-api',
      timezone: 'UTC',
      datestyle: 'ISO',
      ...(timeoutMs === undefined ? {} : { statement_timeout: timeoutMs }),
    },
    types: {
      timestamptz: {
        to: 1184,
        from: [1184],
        serialize: (value: Date | string) =>
          value instanceof Date ? value.toISOString() : String(value),
        parse: timestamptzAsJson,
      },
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (value: string) => String(value),
        parse: (text: string) => text.replace(' ', 'T'),
      },
      date: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => String(value),
        parse: (text: string) => text,
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number | bigint) => String(value),
        parse: (text: string) => Number(text),
      },
    },
  });
}

export type Sql = ReturnType<typeof createSql>;

// The API's one pool, with the deadline. The tests build theirs without it, because a CI runner
// can take longer than the API's deadline for one statement.
export function createDatabase(url: string): Sql {
  return createSql(url, { timeoutMs: DATABASE_TIMEOUT_MS });
}

// True when Postgres refused a write because a foreign key named `constraint` points at a row
// that is gone, such as an account deleted within its token's hour.
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof postgres.PostgresError &&
    error.code === '23503' &&
    error.constraint_name === constraint
  );
}
