#!/usr/bin/env node
// Makes the accounts and events a load test run needs, through the same Auth and API endpoints
// the app uses, and records them in loadtest/.seed/<host>.json for guests.js. Safe to run again:
// it keeps what the file already holds and adds only what is missing. README.md, "Seeding".
//
// Usage: SUPABASE_PUBLISHABLE_KEY=... node loadtest/seed.mjs --guests 300 [options]

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Spec §4.17. The API refuses more, and this script never asks for more.
const GUESTS_PER_EVENT = 150;
const UPLOADS_PER_EVENT = 2000;

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    guests: { type: 'string' },
    'base-url': { type: 'string', default: 'https://api.momentlens.me' },
    concurrency: { type: 'string', default: '16' },
    'photos-per-event': { type: 'string', default: '0' },
    'upload-budget': { type: 'string', default: '1000' },
    'new-events': { type: 'boolean', default: false },
  },
});

function count(name, min) {
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < min) {
    console.error(`--${name} must be a whole number of at least ${min}`);
    process.exit(2);
  }
  return value;
}

if (args.guests === undefined) {
  console.error('Usage: node loadtest/seed.mjs --guests N [--base-url URL] [--concurrency 16]');
  console.error('       [--photos-per-event 0] [--upload-budget 1000] [--new-events]');
  process.exit(2);
}
const guests = count('guests', 1);
const concurrency = count('concurrency', 1);
const photosPerEvent = count('photos-per-event', 0);
const uploadBudget = count('upload-budget', 0);
const baseUrl = args['base-url'].replace(/\/+$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!publishableKey) {
  console.error('Set SUPABASE_PUBLISHABLE_KEY (README, "Setup").');
  process.exit(2);
}
if (photosPerEvent + uploadBudget > UPLOADS_PER_EVENT) {
  console.error(`--photos-per-event plus --upload-budget must stay within ${UPLOADS_PER_EVENT}.`);
  process.exit(2);
}

const host = new URL(baseUrl).host.replace(':', '_');
const seedFile = join(here, '.seed', `${host}.json`);
const eventCount = Math.ceil(guests / GUESTS_PER_EVENT);

async function loadSeed() {
  try {
    return JSON.parse(await readFile(seedFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // One password for every test account, kept only in this git-ignored file.
    return {
      baseUrl,
      password: randomBytes(18).toString('base64url'),
      guests: [],
      admins: [],
      events: [],
    };
  }
}

const seed = await loadSeed();

async function save() {
  await mkdir(dirname(seedFile), { recursive: true });
  const temp = `${seedFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, seedFile);
}

async function pool(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One HTTP call, retried on a network failure, a 429 or a 5xx. Returns { status, body }.
async function call(method, path, { token, body, auth = false, raw, contentType } = {}) {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  const headers = {};
  if (auth) headers.apikey = publishableKey;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw !== undefined) headers['Content-Type'] = contentType;
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (attempt >= 5) throw new Error(`${method} ${path}: ${error.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
}

function expect(result, statuses, what) {
  if (!statuses.includes(result.status)) {
    throw new Error(
      `${what} answered ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}`,
    );
  }
  return result.body;
}

async function signIn(email) {
  const result = await call('POST', '/auth/v1/token?grant_type=password', {
    auth: true,
    body: { email, password: seed.password },
  });
  const body = expect(result, [200], `Sign-in for ${email}`);
  return { token: body.access_token, userId: body.user.id };
}

// Signs the account up, or signs it in when it already exists. Email autoconfirm is on (arch §7),
// so a sign-up answers with a session and sends no mail.
async function account(email, fullName) {
  const result = await call('POST', '/auth/v1/signup', {
    auth: true,
    body: { email, password: seed.password, data: { full_name: fullName } },
  });
  if (result.status === 200 && result.body && result.body.access_token) {
    return { token: result.body.access_token, userId: result.body.user.id };
  }
  if (result.status === 422 || result.status === 400) return signIn(email);
  expect(result, [200], `Sign-up for ${email}`);
  throw new Error(`Sign-up for ${email} returned no session. Is email autoconfirm off?`);
}

const sessions = new Map();

async function ensureAccounts(list, total, makeEmail, makeName, label) {
  const missing = [];
  for (let i = list.length; i < total; i += 1) missing.push(i);
  if (!missing.length) return;
  console.log(`Creating ${missing.length} ${label} accounts`);
  let done = 0;
  await pool(missing, concurrency, async (i) => {
    const email = makeEmail(i);
    const session = await account(email, makeName(i));
    list[i] = { email, userId: session.userId };
    sessions.set(email, session);
    done += 1;
    if (done % 100 === 0) console.log(`  ${done} of ${missing.length}`);
  });
  await save();
}

async function sessionFor(email) {
  if (!sessions.has(email)) sessions.set(email, await signIn(email));
  return sessions.get(email);
}

function hours(n) {
  return new Date(Date.now() + n * 3600 * 1000).toISOString();
}

async function createEvent(slot, admin) {
  const created = expect(
    await call('POST', '/events', {
      token: admin.token,
      body: {
        requestId: randomUUID(),
        name: `Load test ${new Date().toISOString().slice(0, 10)} event ${slot + 1}`,
        type: 'wedding',
        approvalMode: 'auto',
        venues: [{ name: 'Load test hall', lat: 31.5204, lng: 74.3587 }],
        subEvents: [
          {
            name: 'Mehndi',
            startsAt: hours(-2),
            endsAt: hours(2),
            venueIndex: 0,
            verificationRadiusM: 200,
          },
          {
            name: 'Baraat',
            startsAt: hours(2),
            endsAt: hours(6),
            venueIndex: 0,
            verificationRadiusM: 200,
          },
          {
            name: 'Walima',
            startsAt: hours(24),
            endsAt: hours(28),
            venueIndex: 0,
            verificationRadiusM: 200,
          },
        ],
      },
    }),
    [201, 200],
    'POST /events',
  );
  const id = created.event.id;
  const subEvents = expect(
    await call('GET', `/events/${id}/sub-events`, { token: admin.token }),
    [200],
    'GET sub-events',
  );
  expect(
    await call('PUT', `/events/${id}/album`, { token: admin.token, body: { open: true } }),
    [200],
    'PUT album',
  );
  const invites = expect(
    await call('GET', `/events/${id}/invites`, { token: admin.token }),
    [200],
    'GET invites',
  );
  const guestInvite = invites.invites.find((invite) => invite.role === 'guest');
  return {
    id,
    subEventIds: subEvents.subEvents.map((subEvent) => subEvent.id),
    inviteToken: guestInvite.token,
    guestStart: slot * GUESTS_PER_EVENT,
    joined: 0,
    verified: 0,
  };
}

async function uploadCount(event, admin) {
  const result = await call('GET', `/events/${event.id}/album`, { token: admin.token });
  return result.status === 200 ? result.body.uploadCount : null;
}

async function ensureEvents() {
  for (let slot = 0; slot < eventCount; slot += 1) {
    const admin = await sessionFor(seed.admins[slot].email);
    const current = seed.events[slot];
    if (current && !args['new-events']) {
      const used = await uploadCount(current, admin);
      if (used !== null && used + uploadBudget <= UPLOADS_PER_EVENT - photosPerEvent) {
        current.uploadCount = used;
        continue;
      }
      console.log(
        `Event ${slot + 1} has ${used ?? 'an unknown number of'} uploads, so it gets a new event`,
      );
    }
    seed.events[slot] = await createEvent(slot, admin);
    seed.events[slot].uploadCount = 0;
    console.log(`Created event ${slot + 1}: ${seed.events[slot].id}`);
    await save();
  }
}

// Guests join with the event's Guest invite, as a phone does after opening the link.
async function joinGuests() {
  for (let slot = 0; slot < eventCount; slot += 1) {
    const event = seed.events[slot];
    const target = Math.min(GUESTS_PER_EVENT, guests - event.guestStart);
    if (event.joined >= target) continue;
    const indexes = [];
    for (let i = event.guestStart + event.joined; i < event.guestStart + target; i += 1) {
      indexes.push(i);
    }
    console.log(`Event ${slot + 1}: ${indexes.length} guests joining`);
    await pool(indexes, concurrency, async (i) => {
      const session = await sessionFor(seed.guests[i].email);
      const joined = expect(
        await call('POST', '/invites/join', {
          token: session.token,
          body: { token: event.inviteToken },
        }),
        [200, 201],
        `Join for guest ${i}`,
      );
      if (joined.membership.status !== 'active') {
        throw new Error(
          `Guest ${i} is ${joined.membership.status}, not active. Is the event full?`,
        );
      }
    });
    event.joined = target;
    await save();
  }
}

// The Admin marks every Guest checked in (D-157), so pre-flight accepts their uploads without a
// GPS reading or a QR scan.
async function verifyGuests() {
  for (let slot = 0; slot < eventCount; slot += 1) {
    const event = seed.events[slot];
    if (event.verified >= event.joined) continue;
    const admin = await sessionFor(seed.admins[slot].email);
    const versions = new Map();
    let cursor;
    do {
      const query = `role=guest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = expect(
        await call('GET', `/events/${event.id}/attendees?${query}`, { token: admin.token }),
        [200],
        'GET attendees',
      );
      for (const attendee of page.attendees) versions.set(attendee.userId, attendee.accessVersion);
      cursor = page.nextCursor;
    } while (cursor);
    const todo = [];
    for (let i = event.guestStart + event.verified; i < event.guestStart + event.joined; i += 1) {
      todo.push(seed.guests[i].userId);
    }
    console.log(`Event ${slot + 1}: checking in ${todo.length} guests`);
    await pool(todo, concurrency, async (userId) => {
      if (!versions.has(userId)) throw new Error(`Guest ${userId} is not in the attendee list`);
      expect(
        await call('POST', `/events/${event.id}/attendees/${userId}/force-verify`, {
          token: admin.token,
          body: { expectedVersion: versions.get(userId) },
        }),
        [200],
        `Force-verify for ${userId}`,
      );
    });
    event.verified = event.joined;
    await save();
  }
}

// guests.js's uniqueJpeg, for Node: a comment segment after the JFIF header gives each photo its
// own SHA-256.
function uniqueJpeg(base, nonce) {
  let at = 2;
  if (base[2] === 0xff && base[3] === 0xe0) at = 4 + base.readUInt16BE(4);
  const text = Buffer.from(`momentlens-loadtest ${nonce}`, 'ascii');
  const header = Buffer.from([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff]);
  return Buffer.concat([base.subarray(0, at), header, text, base.subarray(at)]);
}

// Gives each event an album to browse, uploaded by its Admin, who needs no check-in.
async function prefillPhotos() {
  if (photosPerEvent === 0) return;
  const photo = await readFile(join(here, 'fixtures', 'photo.jpg'));
  const thumbnail = await readFile(join(here, 'fixtures', 'thumb.webp'));
  for (let slot = 0; slot < eventCount; slot += 1) {
    const event = seed.events[slot];
    const admin = await sessionFor(seed.admins[slot].email);
    const have = (await uploadCount(event, admin)) ?? 0;
    const need = Math.max(0, photosPerEvent - have);
    if (!need) continue;
    console.log(`Event ${slot + 1}: uploading ${need} photos`);
    await pool(
      Array.from({ length: need }, (_, i) => i),
      Math.min(concurrency, 4),
      async (i) => {
        const bytes = uniqueJpeg(photo, `${event.id}-${Date.now()}-${i}-${randomUUID()}`);
        const pre = expect(
          await call('POST', `/events/${event.id}/media/preflight`, {
            token: admin.token,
            body: {
              contentHash: createHash('sha256').update(bytes).digest('hex'),
              subEventId: event.subEventIds[i % event.subEventIds.length],
            },
          }),
          [201, 200],
          'Pre-flight',
        );
        expect(
          await call('PUT', pre.photoUploadUrl, { raw: bytes, contentType: 'image/jpeg' }),
          [200],
          'R2 PUT',
        );
        expect(
          await call('PUT', pre.thumbnailUploadUrl, { raw: thumbnail, contentType: 'image/webp' }),
          [200],
          'R2 PUT',
        );
        expect(
          await call('POST', `/media/${pre.mediaId}/complete`, { token: admin.token }),
          [200],
          'Completion',
        );
      },
    );
    event.uploadCount = have + need;
    await save();
  }
  console.log('Photos uploaded. The worker publishes them over the next minutes.');
}

await ensureAccounts(
  seed.admins,
  eventCount,
  (i) => `lt-admin-${String(i + 1).padStart(4, '0')}@momentlens.me`,
  (i) => `Load Admin ${i + 1}`,
  'Admin',
);
await ensureAccounts(
  seed.guests,
  guests,
  (i) => `lt-guest-${String(i + 1).padStart(6, '0')}@momentlens.me`,
  (i) => `Load Guest ${i + 1}`,
  'Guest',
);
await ensureEvents();
await joinGuests();
await verifyGuests();
await prefillPhotos();
console.log(`Ready: ${guests} guests in ${eventCount} events. Seed file: ${seedFile}`);
