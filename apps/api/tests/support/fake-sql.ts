import type { Sql } from '../../src/db/sql';

// What a test's fake function returns, as supabase-js's rpc did: rows or JSON, or an error, which
// the fake throws as postgres.js would.
export type FakeRpc = (
  name: string,
  params: Record<string, unknown>,
) => Promise<{ data: unknown; error: Error | null }>;

class Json {
  constructor(readonly value: unknown) {}
}

// A stand-in for the API's SQL pool, for stores whose every statement calls one SQL function with
// named arguments. It reads the function's name and each `p_name => value` from the statement, and
// hands them to `rpc`. A statement ending `as result` gets back one row holding `data`, as a
// function returning jsonb does; any other gets `data` as its rows. database.test.ts runs the same
// stores against Postgres; a fake only checks what the service does with each answer.
export function fakeSql(rpc: FakeRpc): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    const name = /public\.(\w+)\(/.exec(text)?.[1];
    if (name === undefined) {
      throw new Error(`fakeSql takes function calls only, got: ${text}`);
    }
    const params: Record<string, unknown> = {};
    values.forEach((value, i) => {
      const argument = /(\w+)\s*=>\s*$/.exec(strings[i] ?? '')?.[1];
      if (argument === undefined) {
        throw new Error(`fakeSql found no argument name before value ${i} of ${name}`);
      }
      params[argument] = value instanceof Json ? value.value : value;
    });
    return rpc(name, params).then(({ data, error }) => {
      if (error) throw error;
      return /\bas result\s*$/.test(text) ? [{ result: data }] : data;
    });
  };
  return Object.assign(sql, { json: (value: unknown) => new Json(value) }) as unknown as Sql;
}
