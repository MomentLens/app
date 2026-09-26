import express from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { ApiError } from './errors';

// express.json with its default 100 kB limit, the largest create is about 40 kB. Media bytes never
// come this way (root invariant 5): a body that is not application/json is left unread, so it
// reaches the handler as undefined and fails the handler's parse.
const parseJson = express.json();

// Every error the JSON parser passes on is about the body: not JSON, too large, an unsupported
// charset. Each becomes the one 400 body, where Express would otherwise send its own HTML error.
export const jsonBody: RequestHandler = (req, res, next) => {
  parseJson(req, res, (error?: unknown) => {
    if (error === undefined) {
      next();
      return;
    }
    const reason = error instanceof Error ? error.message : 'unreadable body';
    next(new ApiError('invalid_request', `Body is not valid JSON: ${reason}`));
  });
};

// Parses a body or a path parameter with its contract schema. A failure is a 400 invalid_request
// whose message says which fields failed, for logs (hb §5.3).
export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError('invalid_request', z.prettifyError(result.error));
  }
  return result.data;
}

// A uuid path parameter, lowercased so it matches ids as Postgres prints them and as keys hold them.
export const PathId = z.uuid().transform((id) => id.toLowerCase());
