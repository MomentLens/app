import { pino } from 'pino';

import { createApp } from './app';
import { loadEnv } from './config';
import { createSupabase } from './db/supabase';
import { createDatabaseCheck } from './services/health';

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

const checkDatabase = createDatabaseCheck(createSupabase(config.env), logger);

createApp({ checkDatabase }).listen(config.port, (error) => {
  if (error) {
    logger.fatal(error, 'API failed to start');
    process.exit(1);
  }
  logger.info({ port: config.port }, 'API listening');
});
