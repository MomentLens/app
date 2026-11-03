// Settings for one k6 run, read from environment variables (`k6 run -e NAME=value`). The README
// lists each one. Nothing here has a ceiling on load: GUESTS is limited only by how many accounts
// the seed file holds and by what one load machine can drive.

// Spec §4.17: 150 active Guests per event. The API refuses a 151st, so a larger run uses more
// events, never fuller ones.
export const GUESTS_PER_EVENT = 150;

// What the app does, from apps/mobile. Kept in one place so a change in the app has one place to
// change here.
export const APP = {
  // use-media-realtime.ts: refetch once changes pause for 1 s, and at least every 4 s.
  quietMs: 1000,
  maxWaitMs: 4000,
  // realtime-js 2.116.0, RealtimeClient CONNECTION_TIMEOUTS.HEARTBEAT_INTERVAL.
  heartbeatMs: 25000,
  // realtime-js 2.116.0, RECONNECT_INTERVALS, then 10 s for every later try.
  reconnectMs: [1000, 2000, 5000, 10000],
  // use-album-images.ts: a signed thumbnail URL is asked for again after 45 minutes.
  renewImagesMs: 45 * 60 * 1000,
  // shared-types MAX_MEDIA_IMAGES_BATCH: the serving endpoint signs at most 50 ids a call.
  imagesBatch: 50,
  // Auth issues 3600 s access tokens (arch §7). Refresh well before that.
  refreshTokenMs: 50 * 60 * 1000,
};

function number(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`Set ${name} with -e ${name}=...`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number, not ${raw}`);
  return value;
}

function flag(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

const baseUrl = (__ENV.BASE_URL || 'https://api.momentlens.me').replace(/\/+$/, '');

export const config = {
  baseUrl,
  wsUrl: baseUrl.replace(/^http/, 'ws'),
  // Names the seed file: api.momentlens.me, or 127.0.0.1_8787 for a local stack.
  host: baseUrl
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(':', '_'),
  publishableKey: __ENV.SUPABASE_PUBLISHABLE_KEY || '',
  // Guests this machine drives, and the index of its first account in the seed file. Several
  // machines split a large run by giving each its own ACCOUNT_OFFSET (README, "Above one machine").
  guests: number('GUESTS'),
  accountOffset: number('ACCOUNT_OFFSET', 0),
  // Guests that join a second. Realtime allows 100 joins a second in all (arch §7).
  rampPerSecond: number('RAMP_PER_SEC', 2),
  settleSeconds: number('SETTLE', 30),
  holdSeconds: number('HOLD', 300),
  // Photos a minute in each event this machine drives.
  uploadsPerMinute: number('UPLOADS_PER_MIN', 10),
  thinkMinSeconds: number('THINK_MIN', 10),
  thinkMaxSeconds: number('THINK_MAX', 30),
  // Share of those actions that are a return to the app after the phone was locked. At the
  // default think time, 0.15 is about once every two minutes.
  foregroundShare: number('FOREGROUND_SHARE', 0.15),
  realtime: flag('REALTIME', true),
  uploads: flag('UPLOADS', true),
};

config.rampSeconds = Math.ceil(config.guests / config.rampPerSecond);
// Guests are connected and browsing from here on. Uploads start here too.
config.holdStartSeconds = config.rampSeconds + config.settleSeconds;
config.endSeconds = config.holdStartSeconds + config.holdSeconds;

if (config.accountOffset % GUESTS_PER_EVENT !== 0) {
  // Each machine must own whole events, or two machines would each upload to one event at the
  // full rate.
  throw new Error(`ACCOUNT_OFFSET must be a multiple of ${GUESTS_PER_EVENT}`);
}
if (config.thinkMaxSeconds < config.thinkMinSeconds) {
  throw new Error('THINK_MAX must be at least THINK_MIN');
}

// "ramp", "hold" or "end", from the run's start time in ms. Thresholds read only "hold".
export function phaseAt(t0, now = Date.now()) {
  const seconds = (now - t0) / 1000;
  if (seconds < config.holdStartSeconds) return 'ramp';
  if (seconds < config.endSeconds) return 'hold';
  return 'end';
}

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
