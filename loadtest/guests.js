// k6 load test: simulated wedding guests on the MomentLens dev server, over HTTP and Realtime.
// README.md says how to run it, what each setting does and how to read the result.

import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

import { signIn } from './lib/api.js';
import { config, GUESTS_PER_EVENT, phaseAt, pick } from './lib/config.js';
import { runPhone, scriptErrors } from './lib/phone.js';
import { summaryMarkdown } from './lib/summary.js';
import { uploadOne } from './lib/upload.js';

const seedPath = __ENV.SEED || `./.seed/${config.host}.json`;

// SharedArray reads the seed file once and shares it across VUs. Each VU reading its own copy
// would cost the whole file's size per guest.
function readSeed() {
  return JSON.parse(open(seedPath));
}
const accounts = new SharedArray('guests', () => readSeed().guests);
const events = new SharedArray('events', () => readSeed().events);
const password = new SharedArray('password', () => [readSeed().password])[0];
// The photo is 316 KB. Kept once, as base64, and decoded only by the VU that uploads.
const fixtures = new SharedArray('fixtures', () => [
  encoding.b64encode(open('./fixtures/photo.jpg', 'b')),
  encoding.b64encode(open('./fixtures/thumb.webp', 'b')),
]);

if (!config.publishableKey) throw new Error('Set SUPABASE_PUBLISHABLE_KEY (README, "Setup")');
if (accounts.length < config.accountOffset + config.guests) {
  throw new Error(
    `${seedPath} holds ${accounts.length} guest accounts, and this run needs ${
      config.accountOffset + config.guests
    }. Run seed.mjs with --guests ${config.accountOffset + config.guests}.`,
  );
}

// The events this machine's guests belong to. The seed fills each event with 150 guests in
// account order, so guest i is in event floor(i / 150).
const firstEvent = Math.floor(config.accountOffset / GUESTS_PER_EVENT);
const lastEvent = Math.floor((config.accountOffset + config.guests - 1) / GUESTS_PER_EVENT);
if (events.length <= lastEvent) {
  throw new Error(
    `${seedPath} holds ${events.length} events, and this run needs ${lastEvent + 1}.`,
  );
}
const activeEvents = lastEvent - firstEvent + 1;
const uploadsPerMinute = config.uploads ? Math.round(config.uploadsPerMinute * activeEvents) : 0;

const holdEndpoints = ['event', 'sub_events', 'album_page', 'images', 'uploaders'];
if (uploadsPerMinute > 0) holdEndpoints.push('preflight', 'complete');
// Sign-ins happen as guests arrive, during the ramp, so they are judged over the whole run.
const wholeRunEndpoints = ['sign_in'];

function thresholds() {
  const rules = {
    // Makes the hold's request count appear in the summary, for requests a second.
    'http_reqs{phase:hold}': ['count>=0'],
    // Stops a broken step early, so it costs less server time. Checked from the first minute on.
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '60s' }],
    script_errors: ['count<1'],
  };
  for (const ep of holdEndpoints) {
    rules[`http_req_duration{ep:${ep},phase:hold}`] = ['p(95)<500', 'p(99)<1000'];
    rules[`http_req_failed{ep:${ep},phase:hold}`] = ['rate<0.01'];
  }
  for (const ep of wholeRunEndpoints) {
    rules[`http_req_duration{ep:${ep}}`] = ['p(95)<500', 'p(99)<1000'];
    rules[`http_req_failed{ep:${ep}}`] = ['rate<0.01'];
  }
  if (uploadsPerMinute > 0) {
    // Half the uploads the rate asks for. Fewer means uploads stalled, even if none failed.
    const expected = (uploadsPerMinute * config.holdSeconds) / 60;
    rules['uploads_completed{phase:hold}'] = [`count>=${Math.floor(expected / 2)}`];
    rules.upload_failures = ['count<1'];
  }
  if (config.realtime) {
    rules.realtime_join_ok = ['rate>0.99'];
    rules.realtime_join_duration = ['p(95)<1000'];
    rules.realtime_server_closes = ['count<1'];
    rules.realtime_channel_errors = ['count<1'];
    rules['realtime_media_messages{phase:hold}'] = ['count>=0'];
    if (uploadsPerMinute > 0) rules['realtime_delivery_lag{phase:hold}'] = ['p(95)<2000'];
  }
  return rules;
}

const scenarios = {
  guests: {
    executor: 'ramping-vus',
    exec: 'guest',
    startVUs: 0,
    stages: [
      { duration: `${config.rampSeconds}s`, target: config.guests },
      { duration: `${config.settleSeconds + config.holdSeconds}s`, target: config.guests },
    ],
    gracefulRampDown: '30s',
    gracefulStop: '30s',
  },
};
if (uploadsPerMinute > 0) {
  // An upload takes a few seconds, mostly the two PUTs to R2, so 10 s of arrivals is enough VUs.
  const perSecond = uploadsPerMinute / 60;
  scenarios.uploads = {
    executor: 'constant-arrival-rate',
    exec: 'upload',
    rate: uploadsPerMinute,
    timeUnit: '1m',
    duration: `${config.holdSeconds}s`,
    startTime: `${config.holdStartSeconds}s`,
    preAllocatedVUs: Math.max(2, Math.ceil(perSecond * 10)),
    maxVUs: Math.max(10, Math.ceil(perSecond * 60)),
    gracefulStop: '30s',
  };
}

export const options = {
  scenarios,
  thresholds: thresholds(),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  setupTimeout: '30s',
};

export function setup() {
  return { t0: Date.now() };
}

// This VU's guest, fixed at its first iteration. Each VU in the ramp starts exactly one iteration
// first, so the first `guests` iterations number the VUs 0 to guests - 1. A later iteration
// (after a crash in this script) keeps the same account rather than taking another phone's.
let myGuest = null;

export async function guest(data) {
  if (myGuest === null) myGuest = config.accountOffset + exec.scenario.iterationInInstance;
  // The phone hangs up when the hold ends, a moment before k6 stops the scenario. A new
  // iteration then would sign in again and add load nobody measures.
  if (phaseAt(data.t0) === 'end') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return;
  }
  const account = accounts[myGuest];
  const event = events[Math.floor(myGuest / GUESTS_PER_EVENT)];
  const session = signIn(account.email, password, phaseAt(data.t0));
  if (!session) {
    // Counted by http_req_failed{ep:sign_in}. Wait before trying again, as a person would.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return;
  }
  await runPhone({ t0: data.t0, session, event });
}

// Sessions this upload VU has signed in, by account index, so it signs each guest in once.
const uploadSessions = new Map();
let photo = null;
let thumbnail = null;

export function upload(data) {
  if (photo === null) {
    photo = new Uint8Array(encoding.b64decode(fixtures[0], 'std'));
    thumbnail = encoding.b64decode(fixtures[1], 'std');
  }
  const phase = phaseAt(data.t0);
  const eventIndex = firstEvent + Math.floor(Math.random() * activeEvents);
  const event = events[eventIndex];
  // A random guest of this event that this machine drives.
  const from = Math.max(eventIndex * GUESTS_PER_EVENT, config.accountOffset);
  const to = Math.min((eventIndex + 1) * GUESTS_PER_EVENT, config.accountOffset + config.guests);
  const index = from + Math.floor(Math.random() * (to - from));
  let session = uploadSessions.get(index);
  if (!session || Date.now() - session.signedInAt > 50 * 60 * 1000) {
    session = signIn(accounts[index].email, password, phase);
    if (!session) return;
    uploadSessions.set(index, session);
  }
  try {
    uploadOne({
      token: session.accessToken,
      eventId: event.id,
      subEventId: pick(event.subEventIds),
      photo,
      thumbnail,
      nonce: `${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`,
      phase,
    });
  } catch (error) {
    scriptErrors.add(1, { phase });
    console.error(`upload: ${error && error.stack ? error.stack : error}`);
  }
}

export function handleSummary(data) {
  const runId = __ENV.RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const markdown = summaryMarkdown(data, { config, runId, holdEndpoints, wholeRunEndpoints });
  return {
    stdout: `${markdown}\n`,
    [`results/${runId}-k6.json`]: JSON.stringify(data, null, 2),
    [`results/${runId}-summary.md`]: `${markdown}\n`,
  };
}
