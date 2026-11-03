import postgres from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Sql } from '../../src/db/sql';

// rls.test.ts was written against PostgREST, which D-164 removed. This is the part of supabase-js's
// query builder that file uses, run as SQL, so its tests keep their meaning: `from` with select,
// insert, update, delete, eq, neq, in, is, not is, order, limit, single and maybeSingle, and `rpc`.
// Each request runs as one statement the way PostgREST ran it. Rows come back through json_agg,
// so a timestamp, a numeric or a jsonb value has the same JSON form PostgREST gave it, and a
// failure comes back as `error`, not thrown. Anything else throws, so a test cannot depend on a
// method this does not implement.
//
// The types are supabase-js's own, so the tests type-check as they did against PostgREST.
export type SqlClient = Pick<SupabaseClient, 'from' | 'rpc'>;

// Who a request runs as. The API's login is service_role from the start (D-164). anon and
// authenticated need a login that may switch to them, as PostgREST's authenticator did, and an
// authenticated request carries the claims of a token Auth signed, so auth.uid() reads its `sub`.
export type Caller =
  | { role: 'service_role' }
  | { role: 'anon' }
  | { role: 'authenticated'; claims: Record<string, unknown> };

interface ClientError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

interface Response {
  data: unknown;
  error: ClientError | null;
  count: number | null;
}

type Row = Record<string, unknown>;

const NAME = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!NAME.test(name)) throw new Error(`sqlClient takes plain lowercase names, got ${name}`);
  return `"${name}"`;
}

// A column the table does not have. PostgREST answered one in a write's body with PGRST204, and
// Postgres answers one in a select or a filter with 42703.
class UnknownColumn extends Error {
  constructor(
    table: string,
    name: string,
    readonly payload: boolean,
  ) {
    super(
      payload
        ? `Could not find the '${name}' column of '${table}' in the schema cache`
        : `column ${table}.${name} does not exist`,
    );
  }
}

// A failure as supabase-js reported it. Anything that is neither a database error nor an unknown
// column is a mistake in the test or in this file, so it throws.
function failure(error: unknown): ClientError {
  if (error instanceof UnknownColumn) {
    return {
      code: error.payload ? 'PGRST204' : '42703',
      message: error.message,
      details: null,
      hint: null,
    };
  }
  if (error instanceof postgres.PostgresError) {
    return {
      code: error.code,
      message: error.message,
      details: error.detail ?? null,
      hint: error.hint ?? null,
    };
  }
  throw error;
}

// Column types, read once per table and connection, so a filter value is cast the way PostgREST
// cast it. A name that is not a column of the table fails here instead of in Postgres.
const tableColumns = new WeakMap<Sql, Map<string, Promise<Map<string, string>>>>();

function columnsOf(sql: Sql, table: string): Promise<Map<string, string>> {
  let cache = tableColumns.get(sql);
  if (cache === undefined) {
    cache = new Map();
    tableColumns.set(sql, cache);
  }
  let columns = cache.get(table);
  if (columns === undefined) {
    columns = sql
      .unsafe<{ name: string; type: string }[]>(
        `select attname as name, format_type(atttypid, atttypmod) as type
         from pg_catalog.pg_attribute
         where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
        [`public.${identifier(table)}`],
      )
      .then((rows) => new Map(rows.map((row) => [row.name, row.type])));
    cache.set(table, columns);
  }
  return columns;
}

interface FunctionShape {
  set: boolean;
  composite: boolean;
  void: boolean;
  args: { name: string; type: string }[];
}

const functionShapes = new WeakMap<Sql, Map<string, Promise<FunctionShape>>>();

function shapeOf(sql: Sql, name: string): Promise<FunctionShape> {
  let cache = functionShapes.get(sql);
  if (cache === undefined) {
    cache = new Map();
    functionShapes.set(sql, cache);
  }
  let shape = cache.get(name);
  if (shape === undefined) {
    identifier(name);
    shape = sql
      .unsafe<FunctionShape[]>(
        `select p.proretset as set,
                t.typtype = 'c' or (p.prorettype = 'record'::regtype and not p.proretset) as composite,
                p.prorettype = 'void'::regtype as void,
                coalesce((
                  select json_agg(json_build_object('name', a.name, 'type', format_type(a.type, null))
                                  order by a.n)
                  from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]),
                              p.proargnames,
                              coalesce(p.proargmodes, array_fill('i'::"char", array[p.pronargs])))
                       with ordinality as a(type, name, mode, n)
                  where a.mode in ('i', 'b')
                ), '[]'::json) as args
         from pg_catalog.pg_proc p
         join pg_catalog.pg_type t on t.oid = p.prorettype
         where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
        [name],
      )
      .then((rows) => {
        const [only, ...more] = rows;
        if (only === undefined || more.length > 0) {
          throw new Error(`sqlClient expects exactly one public.${name}, found ${rows.length}`);
        }
        return only;
      });
    cache.set(name, shape);
  }
  return shape;
}

async function run(sql: Sql, caller: Caller, text: string, params: unknown[]): Promise<Row[]> {
  const values = params as never[];
  if (caller.role === 'service_role') {
    return sql.unsafe<Row[]>(text, values);
  }
  const claims = caller.role === 'authenticated' ? caller.claims : { role: 'anon' };
  return sql.begin(async (tx) => {
    await tx.unsafe(
      `select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`,
      [caller.role, JSON.stringify(claims)],
    );
    return tx.unsafe<Row[]>(text, values);
  });
}

type Filter =
  | { kind: 'compare'; column: string; operator: '=' | '<>'; value: unknown }
  | { kind: 'in'; column: string; values: readonly unknown[] }
  | { kind: 'is'; column: string; negate: boolean; value: null | boolean };

class Query implements PromiseLike<Response> {
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private selected = '*';
  private returning: string | null = null;
  private count = false;
  private head = false;
  private values: unknown = null;
  private readonly filters: Filter[] = [];
  private readonly orders: { column: string; ascending: boolean }[] = [];
  private limitTo: number | null = null;
  private expect: 'many' | 'single' | 'maybe' = 'many';

  constructor(
    private readonly sql: Sql,
    private readonly caller: Caller,
    private readonly table: string,
  ) {}

  select(columns = '*', options: { count?: 'exact'; head?: boolean } = {}) {
    if (this.action === 'select') {
      this.selected = columns;
      this.count = options.count === 'exact';
      this.head = options.head === true;
    } else {
      this.returning = columns;
    }
    return this;
  }

  insert(values: Row | Row[]) {
    this.action = 'insert';
    this.values = values;
    return this;
  }

  update(values: Row) {
    this.action = 'update';
    this.values = values;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: 'compare', column, operator: '=', value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: 'compare', column, operator: '<>', value });
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  is(column: string, value: null | boolean) {
    this.filters.push({ kind: 'is', column, negate: false, value });
    return this;
  }

  not(column: string, operator: string, value: null | boolean) {
    if (operator !== 'is') throw new Error(`sqlClient supports not(column, 'is', ...) only`);
    this.filters.push({ kind: 'is', column, negate: true, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(count: number) {
    this.limitTo = count;
    return this;
  }

  single() {
    this.expect = 'single';
    return this;
  }

  maybeSingle() {
    this.expect = 'maybe';
    return this;
  }

  then<A = Response, B = never>(
    onfulfilled?: ((value: Response) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<Response> {
    try {
      return await this.request();
    } catch (error) {
      return { data: null, error: failure(error), count: null };
    }
  }

  private async request(): Promise<Response> {
    const columns = await columnsOf(this.sql, this.table);
    const column = (name: string, payload = false) => {
      if (!columns.has(name)) throw new UnknownColumn(this.table, name, payload);
      return identifier(name);
    };
    const list = (text: string) =>
      text.trim() === '*'
        ? '*'
        : text
            .split(',')
            .map((name) => column(name.trim()))
            .join(', ');
    // postgres.js serializes a value by the type Postgres reports for its parameter, which turns
    // the string 'true' into false for a boolean and encodes a JSON string twice. So filter values
    // go in as text and are cast in SQL, as PostgREST cast them from the URL, and JSON goes in as
    // an object.
    const params: unknown[] = [];
    const param = (value: unknown, cast: string) => {
      params.push(value);
      return `$${String(params.length)}::${cast}`;
    };
    const text = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
    if (this.action === 'insert' && this.filters.length > 0) {
      throw new Error('sqlClient takes no filters on an insert');
    }

    const where = this.filters.map((filter) => {
      const name = column(filter.column);
      const type = columns.get(filter.column) ?? 'text';
      switch (filter.kind) {
        case 'compare':
          return `${name} ${filter.operator} ${param(text(filter.value), `text::${type}`)}`;
        case 'in':
          return `${name} = any(${param(filter.values.map(text), `text[]::${type}[]`)})`;
        case 'is': {
          const value = filter.value === null ? 'null' : String(filter.value);
          return `${name} is ${filter.negate ? 'not ' : ''}${value}`;
        }
      }
    });
    const whereText = where.length > 0 ? ` where ${where.join(' and ')}` : '';
    const table = `public.${identifier(this.table)}`;

    let query: string;
    let countText: string | null = null;
    if (this.action === 'select') {
      const order =
        this.orders.length > 0
          ? ` order by ${this.orders.map((o) => `${column(o.column)} ${o.ascending ? 'asc' : 'desc'}`).join(', ')}`
          : '';
      const limit = this.limitTo === null ? '' : ` limit ${String(Math.trunc(this.limitTo))}`;
      query = `select coalesce(json_agg(_t), '[]'::json) as rows from (select ${list(this.selected)} from ${table}${whereText}${order}${limit}) _t`;
      if (this.count) countText = `select count(*)::int as count from ${table}${whereText}`;
    } else {
      if (this.orders.length > 0 || this.limitTo !== null) {
        throw new Error('sqlClient takes order and limit on selects only');
      }
      let write: string;
      if (this.action === 'insert') {
        const rows = (Array.isArray(this.values) ? this.values : [this.values]) as Row[];
        // supabase-js sends the union of every row's keys, and a row missing one gets null.
        const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const names = keys.map((key) => column(key, true)).join(', ');
        write = `insert into ${table} (${names}) select ${names} from json_populate_recordset(null::${table}, ${param({ rows }, 'json')} -> 'rows')`;
      } else if (this.action === 'update') {
        const keys = Object.keys(this.values as Row);
        const names = keys.map((key) => column(key, true)).join(', ');
        const source = `(select ${names} from json_populate_record(null::${table}, ${param(this.values, 'json')}))`;
        write =
          keys.length === 1
            ? `update ${table} set ${names} = ${source}${whereText}`
            : `update ${table} set (${names}) = ${source}${whereText}`;
      } else {
        write = `delete from ${table}${whereText}`;
      }
      query =
        this.returning === null
          ? write
          : `with _w as (${write} returning ${list(this.returning)}) select coalesce(json_agg(_w), '[]'::json) as rows from _w`;
    }

    if (this.head) {
      if (countText === null) throw new Error('sqlClient takes head with count only');
      const [counted] = await run(this.sql, this.caller, countText, params);
      return { data: null, error: null, count: (counted?.count as number | undefined) ?? 0 };
    }
    const [result] = await run(this.sql, this.caller, query, params);
    const count =
      countText === null
        ? null
        : (((await run(this.sql, this.caller, countText, params))[0]?.count as
            number | undefined) ?? 0);
    if (this.action !== 'select' && this.returning === null) {
      return { data: null, error: null, count };
    }
    return this.shaped((result?.rows ?? []) as Row[], count);
  }

  // single and maybeSingle as PostgREST answered them: PGRST116 for the wrong number of rows.
  private shaped(rows: Row[], count: number | null): Response {
    if (this.expect === 'many') return { data: rows, error: null, count };
    if (rows.length === 1) return { data: rows[0], error: null, count };
    if (rows.length === 0 && this.expect === 'maybe') return { data: null, error: null, count };
    return {
      data: null,
      error: {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: `The result contains ${String(rows.length)} rows`,
        hint: null,
      },
      count: null,
    };
  }
}

// A function call the way PostgREST made it: each argument read from the JSON body as the type the
// function declares, by name, so an argument left out takes its default.
async function call(
  sql: Sql,
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const shape = await shapeOf(sql, name);
  const declared = new Map(shape.args.map((arg) => [arg.name, arg.type]));
  const given = Object.keys(args);
  for (const key of given) {
    if (!declared.has(key)) throw new Error(`public.${name} takes no argument ${key}`);
  }
  const fn = `public.${identifier(name)}(${given.map((key) => `${identifier(key)} => _a.${identifier(key)}`).join(', ')})`;
  const from =
    given.length === 0
      ? ''
      : ` from json_to_record($1::json) as _a(${given.map((key) => `${identifier(key)} ${declared.get(key) ?? 'text'}`).join(', ')})`;
  // An object, not a string: postgres.js encodes a json parameter itself.
  const params = given.length === 0 ? [] : [args];

  let text: string;
  if (shape.set) {
    text = `select coalesce(json_agg(_r), '[]'::json) as result${from === '' ? ' from' : `${from},`} ${fn} as _r`;
  } else if (shape.composite) {
    text = `select to_json(_r) as result${from === '' ? ' from' : `${from},`} ${fn} as _r`;
  } else if (shape.void) {
    text = `select ${fn}${from}`;
  } else {
    text = `select to_json(${fn}) as result${from}`;
  }
  try {
    const [row] = await run(sql, caller, text, params);
    return { data: shape.void ? null : (row?.result ?? null), error: null, count: null };
  } catch (error) {
    return { data: null, error: failure(error), count: null };
  }
}

export function sqlClient(sql: Sql, caller: Caller): SqlClient {
  const client = {
    from: (table: string) => new Query(sql, caller, table),
    rpc: (name: string, args: Record<string, unknown> = {}) => call(sql, caller, name, args),
  };
  return client as unknown as SqlClient;
}

// The claims of a token Auth signed, read without checking the signature, since Auth just issued
// it. PostgREST set the same JSON as request.jwt.claims.
export function claimsOf(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
