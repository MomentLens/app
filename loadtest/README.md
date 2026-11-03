# Load test

A k6 test that measures how many wedding guests the dev server (`api.momentlens.me`) holds at once, over HTTP and over Supabase Realtime, and which part of the server fails first. Each step of a ladder is one run: guests join, everyone stays connected for 5 minutes, and the run passes only if every endpoint stays inside its limits for all 5 minutes.

Nothing here has a ceiling on load. `GUESTS` sets the number of guests, the seeder makes as many accounts and events as that needs, and a run larger than one machine can drive splits across several machines (see "Above one machine"). The one fixed number is spec §4.17's 150 Guests per event: more guests means more events, never fuller ones.

## The shared server comes first

The dev server is shared with B and C and runs about 2 hours a day on student credits. Before every run against it:

- Ask Ukasha, and say the guest count, the hold time and when.
- Tell B and C. Their phones count toward Realtime's 200 connections and they see the server slow down.
- An agent asks before each run, every time, as root `AGENTS.md` requires for anything over SSH.

The scripts change nothing on the server: no setting, no limit, no deploy. Raising a limit after a run is a separate decision (see "The ladder").

## What one simulated guest does

One k6 virtual user is one phone with one account and one event open. `lib/phone.js` follows the app (`apps/mobile`):

- **Opens the event**, as the event layout and the Home tab do: `GET /events/{eventId}`, `GET /events/{eventId}/sub-events`, `GET /events/{eventId}/media` (the first 50 photos), `GET /events/{eventId}/media/uploaders`, then `POST /events/{eventId}/media/images` for the thumbnails of the loaded photos, 50 ids a call.
- **Joins Realtime** as `use-media-realtime.ts` does: one WebSocket to `/realtime/v1/websocket` with protocol version 2.0.0, one channel with `postgres_changes` on `media` filtered by `event_id` and on `event` filtered by `id`, the access token in the join, and a heartbeat every 25 s. The message format comes from realtime-js 2.116.0, the version the app pins.
- **Browses** every 10 to 30 s (`THINK_MIN`, `THINK_MAX`). It scrolls to the next page and signs its thumbnails. At the end of the album it switches a sub-event filter or pulls to refresh. 15% of these actions (`FOREGROUND_SHARE`) are a return to the app after the phone was locked: the event, sub-events and album refetch, and the uploaders list refetches if its 60 s cache has run out.
- **Refetches on every Realtime change**, with the app's debounce (1 s after changes stop, at least every 4 s): every loaded album page in order, the uploaders list, and thumbnails for new photos. One published photo makes every phone in its event do this. It is the largest multiplier of HTTP load, so a test without it reports too little.
- **Reconnects** after the server closes its socket, with realtime-js's waits (1, 2, 5, then 10 s), then refetches the album and the event as the app does after a rejoin.
- **Refreshes** its access token after 50 minutes and its thumbnail URLs after 45, which matters only in runs longer than that.

**Uploads** run as a separate scenario at a fixed rate, `UPLOADS_PER_MIN` photos a minute in each event (default 10), during the hold only. A random guest of the event runs pre-flight, PUTs `fixtures/photo.jpg` and `fixtures/thumb.webp` straight to R2 with the presigned URLs, then calls completion. Each photo gets its own JPEG comment segment, so its SHA-256 differs and pre-flight never answers `duplicate` (root invariant 7). The server's worker processes the photo, sets `processed_at`, and Realtime sends the change to every phone in the event. Each phone records how long the change took to arrive, from the change's `commit_timestamp` to the moment it arrived.

What the model leaves out:

- Admin and Photographer phones. There is one Admin per 150 Guests, and the Admin's status card call (`GET /events/{eventId}/album`) is not simulated.
- Full-size photo views. The app asks for thumbnails only so far.
- GPS and QR check-ins. The seeder checks every guest in as the Admin (D-157), so pre-flight accepts their uploads.
- The fixture photo has no faces, so the worker spends less time on it than on a real wedding photo. This test measures the API, Auth and Realtime. The worker needs its own measurement.
- Every guest signs in at the start of each run. Real phones keep a session for weeks, so sign-ins here are more frequent than at a wedding. They are judged over the whole run, apart from the other endpoints.

## Setup

1. Install k6 2.3.0. It is a standalone program, not an npm package, and nothing in the repo depends on it.

   ```bash
   brew install k6
   k6 version
   ```

   On Windows, install it inside WSL2 from the release on GitHub (`k6-v2.3.0-linux-amd64.tar.gz`). The scripts were checked with 2.3.0. Another version may parse them differently.

2. Set the publishable key. It is public by design. Copy `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from `apps/mobile/.env`:

   ```bash
   export SUPABASE_PUBLISHABLE_KEY=<the key>
   ```

3. Raise the open-file limit in the shell that runs k6. Each guest holds a WebSocket and at least one HTTP connection, and macOS shells may start at 256.

   ```bash
   ulimit -n 65536
   ```

## Seeding

`seed.mjs` makes the accounts and events through the same Auth and API endpoints the app uses, and writes them to `.seed/<host>.json`. Git ignores that folder. The file holds the shared password of every test account, so keep it off chat and out of commits.

```bash
node loadtest/seed.mjs --guests 300 --photos-per-event 200
```

It is safe to run again. It keeps everything the file already lists and adds only what is missing:

- Guest accounts `lt-guest-000001@momentlens.me` onwards, and one Admin account per event, `lt-admin-0001@momentlens.me` onwards. Email autoconfirm is on (arch §7), so no mail goes out.
- One event per 150 guests, each created by its Admin with 3 sub-events and an open album. Guest `i` joins event `floor(i / 150)` with the Guest invite, and the Admin checks each one in.
- With `--photos-per-event`, the Admin uploads photos until each event has that many, so guests have an album to scroll. The worker publishes them over the next minutes. 200 photos is 4 pages.

An event can hold 2,000 uploads (spec §4.17), and every run adds some. Before reusing an event, the seeder asks the API how many uploads it has. If fewer than `--upload-budget` (default 1,000) uploads are left after the prefill, it makes a new event for those guests. `--new-events` makes new events for every slot.

Everything it makes stays in the dev database and the `momentlens-dev` bucket, because no endpoint deletes an event. B and C never see these events, since an event list shows only the events an account belongs to.

| Flag | Default | Meaning |
|---|---|---|
| `--guests` | required | Guest accounts to have, and guests to put in events |
| `--base-url` | `https://api.momentlens.me` | Server to seed |
| `--concurrency` | 16 | Calls in flight at once |
| `--photos-per-event` | 0 | Photos each event should hold before a run |
| `--upload-budget` | 1000 | Uploads each reused event must still have room for |
| `--new-events` | off | Make new events instead of reusing them |

## Running a step

Run from `loadtest/`, so the summary lands in `results/`. Start the server sampler in a second terminal just before k6, for longer than the run lasts:

```bash
ssh momentlens 'sudo bash -s -- 900' < server-stats.sh > results/150-guests-server.csv
```

```bash
k6 run -e GUESTS=150 -e RUN_ID=150-guests guests.js
```

At the end k6 prints a summary table and writes two files: `results/<RUN_ID>-summary.md`, laid out like `report-template.md`, and `results/<RUN_ID>-k6.json` with every number. k6 exits with a non-zero code when a threshold fails.

A run lasts the ramp (`GUESTS / RAMP_PER_SEC` seconds), then `SETTLE`, then `HOLD`, then up to 30 s while phones hang up. At the defaults, 150 guests take 75 + 30 + 300 seconds, about 7 minutes.

| Setting | Default | Meaning |
|---|---|---|
| `GUESTS` | required | Guests this machine drives |
| `ACCOUNT_OFFSET` | 0 | First account this machine uses. A multiple of 150 |
| `BASE_URL` | `https://api.momentlens.me` | Server under test |
| `SUPABASE_PUBLISHABLE_KEY` | required | From `apps/mobile/.env` |
| `SEED` | `.seed/<host>.json` | Seed file |
| `RAMP_PER_SEC` | 2 | Guests that arrive each second. Realtime accepts 100 joins a second for the whole server |
| `SETTLE` | 30 | Seconds after the ramp before measuring starts |
| `HOLD` | 300 | Seconds measured |
| `UPLOADS_PER_MIN` | 10 | Photos a minute in each event |
| `UPLOADS` | 1 | 0 turns uploads off |
| `REALTIME` | 1 | 0 turns the WebSockets off, for an HTTP-only run |
| `THINK_MIN`, `THINK_MAX` | 10, 30 | Seconds between a guest's actions |
| `FOREGROUND_SHARE` | 0.15 | Share of actions that are a return to the app |
| `RUN_ID` | the start time | Names the result files |

## Pass criteria

All of these must hold. Numbers marked "hold" count only requests made during the 5-minute hold, so the ramp cannot move them.

- Each endpoint on its own, in the hold: P95 under 500 ms, P99 under 1 s, under 1% errors. That covers the event, sub-events, album page, images and uploaders calls, plus pre-flight and completion when uploads are on. A slow rare write cannot hide inside a fast total.
- Sign-in, over the whole run: the same three limits.
- Uploads: at least half of the photos the rate asks for complete in the hold, and none fails at any step.
- Realtime, over the whole run: at least 99% of joins succeed, join replies have P95 under 1 s, the server closes no socket, and no channel reports an error. In the hold, delivery lag P95 stays under 2 s.
- No error in the script itself (`script_errors`). Such an error is a bug in this test, never a result.

A run that fails more than 5% of all requests stops itself, checked from its first minute on, so a broken step wastes less server time.

P95 includes the network between the load machine and Dubai. Run a 1-guest step first (`GUESTS=1 UPLOADS=0 HOLD=60`) and record its P95 as the floor.

## The ladder

The goal is the largest guest count that passes, the component that fails above it, and the same again after raising that limit.

1. A 1-guest run for the network floor.
2. 50, 100, 150 (one full event), 200, 300 guests, then doubling: 600, 1,200, 2,400.
3. When a step fails, bisect between the last pass and the fail until the gap is 25 guests, or 10% above 1,000 guests. That gap is this configuration's limit.
4. Name the component from the evidence: the failed threshold, Realtime's log lines, the process at 100% of one core in `server-stats.sh`'s output, an error code.
5. Raising the limit changes the shared server, so Ukasha decides it and a decision log entry records it before the next run. D-163 says the first runs use Realtime's defaults.

Walls expected on the current server, in the order they should appear:

1. **Realtime**, at 200 connections or 100 messages a second, whichever comes first (arch §7). B's and C's phones count toward the 200. At 10 photos a minute, one full event receives 150 × 10 / 60 = 25 messages a second, so two full events reach 50, and four reach 100. Realtime also checks each change against each watching phone's RLS on one thread.
2. **The API**, one Node process, so one of the four cores at most.
3. **PostgREST and Postgres** behind the API.
4. **nginx**, at Ubuntu's 768 connections per worker. A WebSocket uses two (one to the phone, one to Envoy).
5. **Envoy** between nginx and Supabase allows 10,000 connections per upstream in the pinned config, well above nginx.
6. **The load machine** itself (see below).

## Above one machine

On a 1,000-guest run against a local mock server, k6 peaked at 929 MB of memory, so plan about 1 MB per guest. One machine also runs out of local ports to one server address: macOS has 16,384 (49152 to 65535) and Linux 28,232 by default, and each guest holds a WebSocket and at least one HTTP connection. So one laptop drives a few thousand guests at most, and tens of thousands need several machines.

To split a run, give each machine its own block of accounts with `ACCOUNT_OFFSET`, a multiple of 150 so that each event belongs to one machine and its upload rate is not doubled. Seed once for the total, copy the seed file to every machine, and start them within a few seconds of each other:

```bash
# machine 1
k6 run -e GUESTS=3000 -e ACCOUNT_OFFSET=0 -e RUN_ID=6000-a guests.js
# machine 2
k6 run -e GUESTS=3000 -e ACCOUNT_OFFSET=3000 -e RUN_ID=6000-b guests.js
```

Each machine judges its own thresholds. The step passes only if every machine passes. Add each machine's requests a second for the total.

`RAMP_PER_SEC` is per machine. Realtime accepts 100 joins a second in all, so keep the sum under that.

## Files

| File | What it does |
|---|---|
| `guests.js` | The k6 entry: scenarios, thresholds, sign-in, the summary |
| `lib/config.js` | Settings, and the app's timings in one place |
| `lib/api.js` | Every call, tagged with the endpoint's name |
| `lib/phone.js` | One guest's phone: browsing, Realtime, refetches |
| `lib/upload.js` | One upload, and the unique JPEG |
| `lib/summary.js` | The Markdown summary |
| `seed.mjs` | Accounts, events, check-ins and photos, in plain Node |
| `server-stats.sh` | CPU, memory and connections on the server, every 5 s |
| `report-template.md` | The report for a ladder session |
| `fixtures/` | A 1600 × 1200 JPEG with no faces (316 KB) and a 400 × 300 WebP thumbnail, made with OpenCV |
