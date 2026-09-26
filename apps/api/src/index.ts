import { pino } from 'pino';

import { createApp } from './app';
import { loadEnv, r2Settings } from './config';
import { createSupabase } from './db/supabase';
import { createR2 } from './lib/r2';
import { createTokenVerifier } from './middleware/auth';
import { createEventStore } from './services/events';
import { createDatabaseCheck } from './services/health';
import { createFindProfile } from './services/profiles';

const DEFAULT_PORT = 3000;

const logger = pino();

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function readConfig() {
  return { port: parsePort(process.env.PORT), env: loadEnv() };
}

// A bad setting stops the process here with one log line that names it, which is what
// `journalctl -u momentlens-api` shows. systemd keeps restarting, and every restart says the same.
let config: ReturnType<typeof readConfig>;
try {
  config = readConfig();
} catch (error) {
  logger.fatal(error, 'API configuration is invalid');
  process.exit(1);
}

const supabase = createSupabase(config.env);
// A second client, used only to check tokens. The client that queries must never hold a user
// session, because supabase-js would then send the user's token in place of the secret key and
// RLS would hide every row. Keeping token checks on their own client rules that out.
const authClient = createSupabase(config.env);
const r2 = createR2(r2Settings(config.env));

createApp({
  logger,
  checkDatabase: createDatabaseCheck(supabase, logger),
  verifyToken: createTokenVerifier(authClient),
  findProfile: createFindProfile(supabase),
  events: createEventStore(supabase),
  presignGet: r2.presignGet,
  presignPut: r2.presignPut,
  objectExists: r2.objectExists,
}).listen(config.port, (error) => {
  if (error) {
    logger.fatal(error, 'API failed to start');
    process.exit(1);
  }
  logger.info({ port: config.port }, 'API listening');
});
