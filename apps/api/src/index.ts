import { pino } from 'pino';

import { createApp } from './app';
import { loadEnv, r2Settings } from './config';
import { createDatabase } from './db/sql';
import { createServerClient, SUPABASE_TIMEOUT_MS } from './db/supabase';
import { createR2 } from './lib/r2';
import { createTokenVerifier } from './middleware/auth';
import { createAlbumStore } from './services/album';
import { createAttendeeStore } from './services/attendees';
import { createEventStore } from './services/events';
import { createDatabaseCheck } from './services/health';
import { createInviteManagementStore, createInviteStore } from './services/invites';
import { createJoinRequestStore } from './services/join-requests';
import { createMediaStore } from './services/media';
import { createMediaImagesStore } from './services/media-images';
import { createConsentStore, createFindProfile } from './services/profiles';
import { createSubEventStore } from './services/sub-events';
import { createVenueQrStore } from './services/venue-qrs';

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

// Every read and write of data goes through this pool, as the API's own database login (D-164).
const sql = createDatabase(config.env.API_DATABASE_URL);
// Checks access tokens with Supabase Auth, and nothing else. A token check holds no session and
// reads no data, so the pool and this client never share a user (D-109).
const authClient = createServerClient(
  config.env.SUPABASE_URL,
  config.env.SUPABASE_PUBLISHABLE_KEY,
  { timeoutMs: SUPABASE_TIMEOUT_MS },
);
const r2 = createR2(r2Settings(config.env));

createApp({
  logger,
  checkDatabase: createDatabaseCheck(sql, logger),
  verifyToken: createTokenVerifier(authClient),
  findProfile: createFindProfile(sql),
  consent: createConsentStore(sql),
  events: createEventStore(sql),
  attendees: createAttendeeStore(sql),
  joinRequests: createJoinRequestStore(sql),
  invites: createInviteStore(sql),
  inviteManagement: createInviteManagementStore(sql),
  venueQrs: createVenueQrStore(sql),
  subEvents: createSubEventStore(sql),
  media: createMediaStore(sql),
  album: createAlbumStore(sql),
  mediaImages: createMediaImagesStore(sql),
  presignGet: r2.presignGet,
  presignPut: r2.presignPut,
  objectExists: r2.objectExists,
  objectSize: r2.objectSize,
  deleteObject: r2.deleteObject,
}).listen(config.port, (error) => {
  if (error) {
    logger.fatal(error, 'API failed to start');
    process.exit(1);
  }
  logger.info({ port: config.port }, 'API listening');
});
