import { pino } from 'pino';

import { createApp } from './app';

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

const port = parsePort(process.env.PORT);

createApp().listen(port, (error) => {
  if (error) {
    logger.fatal(error, 'API failed to start');
    process.exit(1);
  }
  logger.info({ port }, 'API listening');
});
