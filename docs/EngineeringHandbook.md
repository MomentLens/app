# MomentLens engineering handbook — v4
> How to actually build it: stack, architecture, environment, workflow, and sequencing.
> Companion to `Idea.md` (the spec), `DecisionLog.md` and `WorkSlices.md`.

## 0. How to use this document

Read §1 (stack), §2 (architecture), §8 or §9 (environment setup), and **§18 (AI tools)** once. Get your machines working. Then go straight to §14 and pull other sections as reference when you actually touch that subsystem.

§18 is not optional reading and it is not last for a reason of importance. It is last because it makes more sense once you know the shape of the system. Read it before you write code, not after, because retrofitting a team policy on AI-generated code three weeks in is much harder than agreeing on one now.

One framing before anything else. Everything here assumes v11's scope. If building this starts taking meaningfully longer than planned, the answer is almost never "work faster." It is "cut more," and spec §6 and §7 already list what is cuttable. Revisit that list before you panic, and revisit it early rather than in April.

---

## 1. Tech stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Mobile client | React Native (Expo SDK 57, RN 0.86), TypeScript | The team knows JS/TS/React, and React skills transfer to the Pakistani job market better than Flutter. Expo Custom Dev Client gives full native module access without leaving the managed workflow. |
| Navigation | Expo Router | File-based, matches how the spec already organizes screens as routes. |
| Client UI state | Zustand | Tiny, no boilerplate. |
| Server state | TanStack Query | Owns everything that comes from the API: fetching, caching, retries, pagination, background refetch. Do not duplicate this in Zustand. |
| Styling | NativeWind | Utility classes, and a shared token system so three people don't produce three shades of the same blue. |
| Local structured storage | `expo-sqlite` | The upload queue and offline QR scans need real querying (status, retry count), not key-value. |
| Local key-value | `react-native-mmkv` | Fast and synchronous, for settings and the auth token cache. Not for the queue. |
| Forms & validation | `react-hook-form` + `zod` | Zod schemas shared conceptually with backend validation, one mental model for "what does valid data look like." |
| Lists | `@shopify/flash-list` v2 | Not `FlatList`. See §16. Note that v2 is New-Architecture-only, removed all size estimates, and replaced `MasonryFlashList` with a `masonry` prop. |
| Animation & gestures | `react-native-reanimated` v4 + `react-native-gesture-handler` | Worklets run on the UI thread. See §16. |
| Backend API | Express 5, TypeScript, Node LTS | The team knows it. |
| Backend validation | `zod` | Same mental model as the frontend. |
| Object storage client | `@aws-sdk/client-s3` against R2 | Presigned upload URLs. |
| Auth / DB / Realtime / Queue | Supabase (Postgres, Auth, Realtime, `pgmq`) | One managed service instead of stitching four together. |
| Object storage | Cloudflare R2 | Zero egress fees, 10 GB permanently free. |
| AI worker | Python 3.12+, FastAPI (thin), `pgmq` consumer | Face detection, embedding, and generation of the public and per-subject blur variants. There is no display-variant job; nobody resizes (D-58). |
| Face detection & embeddings | InsightFace via ONNX Runtime, not PyTorch | ONNX runs meaningfully faster on CPU-only hosting and has a much smaller dependency footprint. |
| Compute hosting | One Netcup RS 1000 G12 root server (4 dedicated AMD EPYC cores) for development and the demo | What the team develops against is what the panel sees, and nothing on demo day depends on a laptop. See §13 and D-78. |
| Process management | `systemd` + `nginx` + `certbot` | No Docker. See §13 for why. |
| CI | GitHub Actions | Free, you already have GitHub. |
| E2E testing | Maestro | Local runs are free; cloud runs are metered. |
| Package manager | `pnpm` | Fast, disk-efficient, first-class workspaces for the monorepo. |

**Pin your versions and do not chase upgrades.** Expo ships a major SDK roughly every four months. Between now and June 2027 there will be at least two more. Pick SDK 56 (or whatever is current when you start), pin it, and do not upgrade unless something is actually broken. An SDK bump in month eight will cost you a week and gain you nothing you need.

---

## 2. Software architecture overview

Three runtimes, one shared source of truth.

```text
┌─────────────────────┐         ┌──────────────────────┐
│   Expo / React       │  REST   │   Express API          │
│   Native App          │◄───────►│   (Node/TS)            │
│  (iOS + Android)      │  JSON   │                        │
└──────────┬───────────┘         └──────────┬────────────┘
           │                                 │
           │ direct, presigned              │ reads/writes
           │ upload (see §7)                 │
           ▼                                 ▼
┌─────────────────────┐         ┌──────────────────────┐
│  Cloudflare R2        │         │   Supabase             │
│  (media files)         │◄───────►│   Postgres / Auth /    │
└─────────────────────┘  read    │   Realtime / pgmq       │
           ▲              media  └──────────┬────────────┘
           │                                 │ pgmq job
           │ read/write                      ▼
           │                     ┌──────────────────────┐
           └─────────────────────│  FastAPI AI Worker     │
                                  │  (Python): detect,     │
                                  │  face embed, blur      │
                                  └──────────────────────┘
```

Four decisions embedded in that diagram, none of them obvious the first time you draw one:

- **The app never talks to R2 or the worker directly for anything that needs a permission check.** It talks to Express, which is the only thing issuing presigned URLs. Express is the single source of truth for "is this request allowed."
- **Media bytes bypass Express on upload.** The app uploads directly to R2 with a presigned URL. §7 explains why this is deliberate.
- **The worker never serves live user requests.** It consumes `pgmq` jobs only. FastAPI's HTTP surface is a `/health` endpoint and nothing else. This is what keeps Python's GIL out of your user-facing latency.
- **Every image request is authorized before it becomes a URL, and there is no exception to that.** The client never constructs a bucket URL. It asks Express for a photo's image; Express checks whether the requester is a Do Not Publish subject in that photo and mints a short-lived presigned R2 URL for the correct pre-generated file (spec §4.11, §4.13). Viewing and downloading use the same endpoint. **Media bytes still never pass through Express**, because the variants already exist in R2 and Express only signs a URL. v3 described an authenticated compositing endpoint here, which would have contradicted the rule two bullets above; D-57 removed it.

---

## 3. Repository structure

One monorepo, three packages. For three people, a single repo beats three repos: no version-mismatch coordination, one PR can touch app and API together, and anyone can `grep` the whole system.

```text
momentlens/
├── CLAUDE.md                 # session context: invariants + routing. Root file.
├── apps/
│   ├── mobile/              # Expo app
│   │   ├── CLAUDE.md
│   │   ├── src/
│   │   │   ├── app/          # Expo Router screens
│   │   │   ├── components/
│   │   │   ├── stores/       # Zustand
│   │   │   ├── hooks/        # TanStack Query hooks
│   │   │   ├── lib/          # API client, SQLite queue, storage helpers
│   │   │   └── constants/    # hard-coded limits (spec §4.17)
│   │   ├── __tests__/
│   │   ├── tailwind.config.js, global.css   # the only two files with hex colors (§15)
│   │   └── app.json / eas.json
│   │
│   └── api/                  # Express API
│       ├── CLAUDE.md
│       ├── src/
│       │   ├── routes/
│       │   ├── controllers/
│       │   ├── services/
│       │   ├── middleware/    # JWT verification, error handling
│       │   ├── db/            # typed Supabase client + query helpers
│       │   └── schemas/       # zod
│       ├── tests/
│       │   ├── unit/
│       │   └── integration/   # the RLS + serving-endpoint negative tests (§11)
│       └── package.json
│
├── worker/                   # Python AI worker. Outside apps/ on purpose: see below.
│   ├── CLAUDE.md
│   ├── app/
│   │   ├── jobs/
│   │   │   ├── thumbnail_dims.py # Phase 3 warm-up (D-72): dims, thumb, version, processed_at
│   │   │   ├── face_process.py   # detect, embed, write public + subject variants
│   │   │   └── reprocess.py      # retroactive blur; match only, never re-detect
│   │   ├── ai/
│   │   │   ├── face.py        # InsightFace / ONNX wrapper
│   │   │   └── image.py       # OpenCV helpers: elliptical mask, blur, encode
│   │   └── main.py
│   ├── tests/
│   └── requirements.txt       # exactly pinned, not ranges
│
├── packages/
│   └── shared-types/          # zod schemas. TypeScript only; the worker cannot import this.
│
├── supabase/
│   └── migrations/
│
├── e2e/                       # Maestro flows (§11)
├── .github/workflows/
│   ├── ci.yml                 # lint, typecheck, unit + integration tests
│   └── keepalive.yml          # D-67. Deliberately not a cron on the compute box.
├── scripts/
│   ├── deploy.sh              # the §13 update sequence, written down once
│   └── provision.sh           # the §13 setup sequence, run once on any new server
├── docs/
│   ├── ARCHITECTURE.md        # see §18. This file is load-bearing
│   ├── Idea.md                # the spec
│   ├── EngineeringHandbook.md
│   ├── DecisionLog.md
│   └── WorkSlices.md
├── .env.example               # every variable, no values. Committed.
├── pnpm-workspace.yaml
└── package.json
```

**Why `worker/` sits outside `apps/`.** `pnpm-workspace.yaml` globs `apps/*` and `packages/*`, and every entry it finds is expected to have a `package.json`. A Python directory in there confuses the workspace tooling for no benefit. It is a peer application that pnpm does not manage.

**`.env.example` is committed and every variable appears in it, with no values.** Without it, day one for the other two people is a series of messages asking which variables exist. Add a variable there in the same commit that introduces it.

**Tests live next to what they test, with one exception.** Jest specs for the app go in `apps/mobile/__tests__/`, the API's in `apps/api/tests/`, the worker's in `worker/tests/`. Maestro flows go in a top-level `e2e/` because they exercise the whole system rather than one package.

**⚠ One structural decision to make before the first migration: who owns the R2 object key format.** The key carries a version (`{media_id}/public_v{n}.jpg`, D-60), and both the worker (writing files) and the API (signing URLs) need it. If each constructs the string in its own language, they will drift, and a drift there means a 404 at best and the wrong file at worst.

**Do not construct the key in two places.** The worker writes `public_key` and the per-subject keys onto the media row as it uploads them. The API reads the column and presigns it. It never builds a key. This is one column against a whole class of cross-language bug, and it also means the version-bump logic lives in exactly one file.

**Settled by D-70.** The API still has to name an upload key before the worker has seen the photo, so the rule is one builder per key family. The API builds the upload keys, the original and the client thumbnail, in one function. The worker builds every derived key. Each writes its keys onto the row, and whatever serves a file reads the column.

There is **no `dedup.py`**. Deduplication is a SHA-256 lookup in Express and is not a worker job (§7).

There is **no `variant.py`** either. D-58 removed the client resize, so there is no display variant to generate and the job that produced it does not exist. Note that this was Phase 5's warm-up task in v3; §14 has a replacement.

`packages/shared-types` is worth having even though it starts small. Anything crossing the app-to-API boundary lives here once and is imported by both sides. The alternative is spending an hour debugging a bug that turns out to be "the app expected `guestCount`, the API sends `guest_count`."

`docs/ARCHITECTURE.md` is new in v3 and it exists for §18. Read that section before deciding it's bureaucracy.

---

## 4. Frontend architecture

**Navigation.** Expo Router, file-based. `app/event/[id]/album.tsx` is the route `/event/:id/album`. This makes "spec section to actual file" mechanical rather than a design exercise.

**State: two tools for two kinds of state, and do not blur them.**
- *Server state* (the event, the album, attendees) goes to **TanStack Query**. Loading and error states, caching, retries, background refetch, all free. Do not copy server data into Zustand "just in case." That is the classic mistake that reintroduces exactly the synchronization bugs TanStack Query exists to prevent.
- *Client and UI state* (the active sub-event chip, the Viewfinder's Public/Local Only toggle, the current theme) goes to **Zustand**. This state has no server counterpart.
- Auth sits between. Supabase Auth owns the token lifecycle; a thin `useAuthStore` mirrors "is there a logged-in user" so the rest of the app reads it synchronously without every component knowing about Supabase's session API.
- **The upload queue is neither.** It lives in `expo-sqlite` because it must survive a force-kill and needs real queries (status, retry count, which sub-event). Do not put it in Zustand, and do not put it in TanStack Query. A thin hook reads it and exposes the counts the My Media banner needs.

**Styling.** NativeWind, tokens defined once in `tailwind.config.js` (§15), utility classes everywhere, never a hardcoded hex in a component.

**Type safety across the boundary.** Define request and response shapes as zod schemas in `packages/shared-types` and build one thin typed API client the mobile app imports. This is the single highest-leverage thing you can do to prevent the "works on my machine, breaks in the app" class of bug that eats disproportionate time on inexperienced teams.

**Image dimensions are still worth storing, for a smaller reason than in v3.** Spec §4.11 has the worker write `width` and `height` onto every media row. In v3 blur correctness depended on them, because the client positioned an absolute crop box inside a known frame; D-57 removed the overlay, so that dependency is gone and nothing about privacy breaks if these are wrong. What still needs them is a future masonry grid: FlashList v2 no longer estimates sizes, so masonry without known heights produces a collapse-then-expand reflow on every image load. Store them from day one anyway, because the worker is already opening the file and backfilling the columns against R2 later is a real job.

**Two rules the album query must follow, and both fail silently if you get them wrong.**
- Filter on `processed_at IS NOT NULL` (D-55). A row that exists but has not been processed has no blur variants yet, so showing it in the shared album shows an unblurred photo. The uploader sees their own unprocessed photo in My Media with a spinner; nobody else sees it anywhere.
- Never cache a photo by media ID alone. The image URL carries `variant_version` (D-60), and `expo-image` must be given an explicit cache key that includes it. Otherwise a retroactive blur regenerates the file in R2 and every client that already loaded the photo keeps serving the pre-blur image out of its own disk cache.

**Key native modules:**

| Library | Used for |
|---|---|
| `expo-camera` | The Viewfinder, and QR scanning |
| `expo-image-picker` | "+ Add Media" per sub-event section. Not in the Viewfinder. |
| `expo-image` | Cached, performant image rendering |
| `expo-image-manipulator` | HEIC to JPEG, EXIF handling, the 300px thumbnail, and the 4096px guard resize that only fires on non-phone files. Native, off the JS thread. |
| `expo-crypto` | SHA-256 over the upload bytes with `digest()`. Node's `crypto` does not exist in React Native. |
| `expo-location` | Foreground GPS reads only. No background location APIs. |
| `expo-file-system` | Local Only storage in the app sandbox (spec §4.12) |
| `expo-sqlite` | Upload queue, offline QR scan records |
| `expo-notifications` | Push |
| `expo-haptics` | Shutter feedback and small tactile polish |
| Background upload | iOS `beginBackgroundTask` + Android foreground service. Small, focused native surface; likely a narrowly-scoped community library. |

---

## 5. Backend architecture (Express API)

**Layering: route → controller → service.** Routes define the HTTP surface, controllers parse and validate with zod, services hold business logic and talk to Supabase. This is not ceremony. It means "is this event's guest limit reached" is testable without an HTTP server, and it is the difference between three people working on different features and three people colliding in one giant `routes.ts`.

**Auth middleware.** Every authenticated route verifies the Supabase JWT from the `Authorization` header using Supabase's server SDK. Do not hand-roll JWT verification. The middleware attaches the verified user to `req.user`; nothing downstream re-checks identity.

**Row Level Security. Do this, it is not optional.** RLS policies are rules the database itself enforces regardless of which query arrives. If you only enforce permissions in Express, one buggy code path (or you in six months adding an endpoint and forgetting the check) leaks data. Given this app's core premise involves people's photos and face embeddings, that is not a corner worth cutting.

**Superseded in part by D-73.** The API uses the secret key and enforces the rules below in its service layer, each with a negative authorization test. RLS stays on for every table, with `SELECT` policies only on `media` and `event` for Realtime, so the app cannot read or write any other table directly. The rules still describe who may see what; `docs/ARCHITECTURE.md` §1 has the current table.

**The good news: v10 made your RLS much smaller.** Because Photographer uploads now land in the shared album, there is no per-role media visibility rule. Write policies for:

- **`media`**: `SELECT` allowed to any member of the event, with one exception. A Photographer can `SELECT` only rows where they are the uploader (spec §4.10). `UPDATE`/`DELETE` allowed to the uploader and to the Admin of that event.
  - `uploader_role_at_upload` still exists as a column, but it is **display metadata only**. It drives the Uploader filter chip and nothing else. In v3 it also routed the download endpoint between an original and a 2048px version; D-58 collapsed those into one file, so it now routes nothing. Do not put it in an RLS predicate and do not put it in a routing branch either.
- **`event`**: visible only to members of that event.
- **`membership`**: a user can read their own rows; Admin can read all rows for their own events.
- **`face_reference`** (a user's reference embeddings): readable only by that user and by the worker's service role. Never exposed through any user-facing endpoint.
- **There is no `dnp_crop` table.** v3 named its RLS policy as the single most sensitive rule in the system. D-57 deleted the table, and with it that policy. The danger did not disappear; it moved somewhere easier to reason about and easier to test, which was most of the point.
- **The image-serving endpoint is now the most sensitive authorization check in the system**, and it is application logic rather than RLS. One endpoint answers "which file does this requester get for this photo." It checks whether the requesting user is a Do Not Publish subject on that media row, then presigns the corresponding key: the subject's own variant if so, the public file otherwise. Get this wrong and a subject's unblurred variant reaches somebody else, which is the exact thing the app promises not to do. Write the negative test before the endpoint (§11).
- **`dnp_subject`** (which users are Do Not Publish subjects on which media row): readable by any event member, because the client needs to know a photo has personalization without learning who the subject is. Return the row without the subject identity unless the requester is that subject.
- **`subject`** (the person a blur applies to, with a **nullable** foreign key to the auth user). Create it with the nullable FK from the first migration even though Proxy Blur is deferred (D-63). Adding it now is a column definition; adding it later against live rows is a migration.
- **The Recognized Faces read is viewer-scoped, not a stored exclusion.** Spec §4.11 hides a Do Not Publish user's face from every viewer except that user. Implement it as a predicate parameterized by the requesting user, never by omitting the row at write time. Getting this wrong does not throw an error; it silently returns nothing for Find My Photos for exactly the users the feature exists for.

There is no `PlanTier` table. The hard-coded constants in spec §4.17 are plain conditionals in the relevant service functions, not a database lookup.

**API contract.** Generate an OpenAPI spec from your zod schemas with `zod-to-openapi` so every endpoint's shape is documented and machine-checkable rather than tribal knowledge.

---

## 6. AI worker architecture (FastAPI)

This is a **queue consumer**, not a web server written in FastAPI. The distinction shapes how you build it. The main loop polls `pgmq`, dispatches to a job handler, writes results to Postgres and R2, and moves on. The HTTP surface is `/health` so nginx and you can ping it.

**Why this shape protects you.** Python's GIL means one process cannot truly run two CPU-bound tasks in parallel on threads; you need multiple processes. If the worker served live HTTP, a face-detection job would stall every other request that process was handling. As a queue consumer it is off the user-facing path entirely: the upload succeeds and returns the moment the file lands in R2, processing happens after, and the user finds out via Supabase Realtime. For more throughput you run more worker processes against the same queue. On a 2-core box, run **one** worker process and leave the second core for Express, Postgres connections, and nginx. Do not run two.

**Load the model once, at startup.** Cold-loading InsightFace per job costs several seconds; a warm model takes well under a second for a photo with a few faces and several seconds for a large group, because every face gets its own recognition pass (D-78 has the measured numbers). Lazy-loading is the single most likely reason your demo feels slow, and it is entirely avoidable. Note that input resolution barely moves this number, because InsightFace resizes internally to `det_size` for detection and crops to 112x112 for recognition; what full-size input actually costs you is JPEG decode time, roughly 100 to 200ms.

**Job types:**

| Job | Trigger | Work |
|---|---|---|
| `thumbnail_dims` | Any upload completes, from Phase 3 until S-21 retires it (D-72) | No ML. Write `width`/`height`, the thumbnail only if the client's is missing, bump `variant_version`, then set `processed_at`. Never runs on the same upload as `face_process` |
| `face_process` | Any upload completes | Detect faces once, extract an embedding per face, match against event members' Do Not Publish reference sets, write the public blurred file plus one variant per matched subject and a blurred thumbnail for each (D-69), write `width`/`height`, then set `processed_at` |
| `reprocess` | A user activates Do Not Publish, or a manual blur correction is confirmed or reverted | **Match only, never detect.** Compare the already-stored embeddings for that event against the newly-active reference set, then regenerate the public file, the new per-subject variant and the thumbnails of both for matched photos only, bumping `variant_version` |

`reference_process` and `manual_blur` joined these jobs later (D-74). `docs/ARCHITECTURE.md` §5 has the current list.

**Three rules inside `face_process` that are easy to get subtly wrong:**

- **`processed_at` is written last, after every variant is in R2.** It is what makes the row album-visible (D-55). Write it early and you publish an unblurred photo for the length of the rest of the job.
- **Bump `variant_version` on every write, including the first** (D-60). The object key carries it. A stable key means clients serve the pre-blur image from their own cache after a retroactive blur.
- **N Do Not Publish subjects means N+1 files, never 2^N.** No viewer ever needs two subjects unblurred at once, so there is no combination to enumerate. A photo with no Do Not Publish faces produces no extra files at all.

**Blur implementation, specified in spec §4.11 and worth repeating because it is two lines that a viva will ask about:** expand the detection box 30 to 40 percent and mask elliptically, since a tight box leaves hair, ears, jawline and clothing visible; and blur by downsampling then upsampling with a box blur on top, since a single light Gaussian is partially invertible.

**Use ONNX-exported models**, which InsightFace ships, rather than the full PyTorch runtime. Meaningfully faster CPU inference and a much smaller install, both of which matter on a CPU-only server.

**Model choice.** Start with `buffalo_l` for accuracy. If the server is struggling, `buffalo_s` is materially faster with a modest accuracy cost. Decide with a measurement, not a guess.

---

## 7. The upload pipeline, architecturally

Worth its own section because getting this wrong is the easiest way to make a small server the bottleneck for the entire app.

**Do not route media bytes through Express.** If every photo flows through Node, you pay for that bandwidth and CPU twice, once receiving and once forwarding, on a box you are specifically keeping light. Instead:

1. **Pre-flight** (small JSON, this *does* go through Express): content hash, album ID, sub-event ID, and the GPS reading taken at capture time. No image bytes, the thumbnail included (D-69). Express does two lookups. First, a SHA-256 match against existing media for this event; an exact match is silently rejected with no file transfer. Second, the verification check: a `VenueVerification` row for this user and sub-event, **or** `membership.admin_verified_at IS NOT NULL`, **or** `role = 'photographer'`. Both are single indexed lookups. Neither risks blocking the event loop.
2. **Presigned URLs.** If it passes, Express builds the upload keys for the photo and its thumbnail in its one key function, writes them onto the new media row (D-70), and presigns a PUT URL for each via `@aws-sdk/client-s3` (R2 is S3-API-compatible; this is standard SDK functionality).
3. **Direct upload.** The client PUTs the photo and its thumbnail straight to R2. Express is not in this path.
4. **Completion.** The client tells Express "done," and Express enqueues the `pgmq` job.

**One client pipeline for every role.** v3 had two, split on the resize. D-58 removed the resize, so the only thing left that differs by role is the location gate, and that is a server-side check in pre-flight rather than a client behaviour.

| Step | Every role |
|---|---|
| EXIF strip | Yes. Timestamp and orientation survive; everything else, including GPS, is stripped. |
| HEIC to JPEG | Yes |
| Client resize | **None**, unless the longest edge exceeds 4096px, in which case resize to 4096px. Never fires on a phone photo. |
| Thumbnail | 300px WebP, for the grid. Unblurred, so it goes to R2 by presigned PUT and is served only for photos with no Do Not Publish face (D-69) |
| Hash | SHA-256 over the **exact byte stream about to be uploaded**, after EXIF strip and HEIC conversion |
| Location gate | Server-side in pre-flight. Photographers pass automatically. |

**Do not hash the thumbnail.** v3 did, and it does not work: WebP encoders differ across iOS, Android and library versions, so the same source photo hashes differently on two devices and after any dependency bump. Hash the bytes you are actually PUTting (D-53).

There is no role branch left to unit-test here. There is still a branch in the pre-flight verification check, and that one is worth a test.

**Why the client-side check is not a security hole.** Spec §4.5 has the client compare GPS against cached coordinates on-device so the queue can unlock without connectivity, which matters at venues with bad WiFi. The client is optimistic; the server is the authority. The pre-flight submits the reading, the server re-validates it against the sub-event's stored coordinates, and only the server writes the `VenueVerification` row. Do not let anyone "simplify" this by trusting a client-supplied `verified: true` boolean.

---

## 8. Development environment — macOS (Ukasha, M1)

1. **Homebrew**, if not already installed.
2. **Node via a version manager**, not a system install. `fnm install && fnm use` reads the pinned version from `.nvmrc`.
3. **pnpm**: the exact version pinned in `package.json` under `packageManager`. `corepack enable` picks it up, or run `npm install -g pnpm@<that version>`.
4. **Skip Watchman.** Expo SDK 56 replaced it with a Node file watcher for Metro, and `apps/api` turns it off for Jest. A broken Homebrew install only prints dyld errors, so `brew uninstall watchman` rather than repairing it.
5. **Xcode** from the App Store, for the iOS Simulator and local iOS builds. Unavoidably macOS-only.
6. **Xcode Command Line Tools**: `xcode-select --install`.
7. **CocoaPods**, usually handled by Expo's prebuild, but `sudo gem install cocoapods` if needed directly.
8. **Android Studio** for the SDK and an emulator.
9. **Python 3.12+**: `brew install python@3.12`, then a venv per the worker's `requirements.txt`.
10. **EAS CLI**: `npm install -g eas-cli`, then `eas login`.
11. **VS Code** with ESLint, Prettier, Tailwind CSS IntelliSense, Python, and Expo Tools.
12. **Check the machine** with `pnpm check:machine` (not `pnpm doctor`, which is pnpm's own command). It compares Node, pnpm, Python, Java, the Android SDK and Xcode against the repo pins.

**One thing that changed.** Your M1 is ARM64 and the server is x86-64 (D-78), so local and production no longer share an architecture. InsightFace 2.0 installs as pure Python and its dependencies ship wheels for both, which keeps that gap small. If a wheel behaves differently on the server, debug it there, not on your Mac. The M1 is still the fastest machine the team has measured for face processing, which is one reason the worker is yours.

**What the M1 is not.** Since D-78 it is not the demo runtime. The API and worker run on the server for the demo, so anything the demo needs has to work there, not only on your Mac.

---

## 9. Development environment — Windows (x86, no GPU)

Same Node/pnpm/Android Studio/Python/EAS/VS Code steps as §8, with these differences:

- Use **WSL2** for the backend (Express and FastAPI) and general Node tooling. It avoids a long tail of path-handling and native-module-compilation quirks. Run Metro from WSL2 where possible; Android Studio and the emulator run on Windows itself.
- Install Node, pnpm, and Python **inside WSL2**, not the Windows-native versions, so the toolchain stays consistent.
- **The iOS Simulator does not exist on Windows.** Apple ships it only with Xcode. This is not workaround-able. Practically:
  - You can write and test 100% of the Android side locally.
  - For iOS, **EAS Build compiles iOS binaries in the cloud with no local Mac**. You cannot run the Simulator, but you can build a real iOS app and install it on a physical iPhone via the Custom Dev Client, entirely from Windows. EAS Build's free tier covers a limited number of builds per month, which is enough if you are not rebuilding natively every day (§10 explains why you won't be).
  - For the rare Simulator-only moment, borrow Ukasha's machine.
- **Architecture on the Python worker.** The server is x86-64 like your machine (D-78), so a wheel that installs in WSL2 should install on the server too. The M1 is now the machine that differs. If something fails only on the server, SSH in and debug it there.

---

## 10. The fast iteration loop

This trips up almost every team new to React Native, so be explicit about the mental model: **most of your daily changes need no native rebuild at all.**

**Two tiers:**
1. **The Dev Client**, a native shell built once via `eas build --profile development` (or locally with `expo run:ios` / `expo run:android`) and installed like any app. It contains all your native modules compiled in.
2. **Your JS/TS**, served live by Metro (`npx expo start`) to that installed Dev Client over WiFi or USB. Every save pushes through **Fast Refresh** in under a second, preserving most component state.

**You only rebuild natively when:**
- You add or upgrade a package containing native code.
- You change native configuration in `app.json` / `app.config.js` (permissions, icons, splash).
- You switch build profiles.

Everything else (screens, components, styling, business logic, API calls, state) is Fast Refresh, dozens of times an hour.

**Simulator versus physical device.** Simulators are fine for layout, navigation, and most logic, which is genuinely most of your UI work. They are **bad for this app specifically**: they fake the camera and GPS unreliably or not at all. Given how central the Viewfinder and the verification gate are, plan to do a meaningful share of daily development on a real phone, not just testing at the end. Bugs in those areas will not appear in a simulator.

**EAS Update** (OTA JS updates) matters for one week of your life: the week before your defense, when you need a last-minute fix on installed test devices without rebuilding. Set it up in Phase 6, not Phase 0.

---

## 11. Coding, building, and testing strategy

**Linting and formatting:** ESLint and Prettier for TypeScript, Ruff for Python. Ruff replaces flake8, black, and isort with one much faster tool.

**Pre-commit hooks:** Husky and `lint-staged`, so issues are caught before a commit lands rather than in CI ten minutes later.

**Testing, proportionate to your timeline:**

- **Unit tests, most of your test effort.** Pure logic, no UI, no network: Haversine distance for GPS verification, hard-coded limit checks, the pre-flight verification branch (§7), sub-event status computation from timestamps (spec §4.3, and this one has real edge cases because In Progress depends on the *next* sub-event's start). Jest with the `jest-expo` preset for the app and plain Jest for the API, since `jest-expo` is an Expo preset with no place on an Express server; `pytest` for the worker.
  - There is no pHash Hamming distance test any more. Deduplication is a hash equality check.
  - There is no client-pipeline role branch to test any more either (D-58).
- **Integration tests, some, and one of them is the most valuable test in the project.**

  **Write this one first, before the endpoint it tests exists.** Authenticate as user A. Request the image for a photo where user B is a Do Not Publish subject. Assert that what comes back is the public file and not B's variant, and that a direct request for B's variant key returns 403. Roughly twenty lines. If this project has exactly one test, that is the one, because a too-permissive authorization check throws no error and looks identical to a correct one; it just returns the wrong file (§18).

  Then: does RLS actually block a Photographer from reading another user's media, and does RLS actually block one user from reading another user's `face_reference` rows. Under D-73 those rules live in the API's service layer, so these are negative API tests. The two RLS policies that remain, `SELECT` on `media` and `event`, get a Realtime test: a non-member receives nothing.

  Also worth an integration test, because it fails silently in the other direction: does the album query exclude rows with `processed_at` null (D-55), and does a Do Not Publish user's Find My Photos return their own photos (spec §4.11, the viewer-scoped filter).
- **E2E tests, few, and only for flows that would be genuinely bad to break.** Maestro against a handful of critical paths: sign up, join event, capture, see it in the album. Verify a Do Not Publish face is blurred for a second viewer. Verify photos sit in the local queue when location permission is denied and only upload after a QR scan. Do not try to E2E everything.

**One calibration task that is not a test but belongs here.** The similarity thresholds in spec §4.11 are placeholders. Before Phase 5 ends, take roughly 30 photos of the three of you in varied lighting and angles, compute the cosine similarity distribution for same-person and different-person pairs, and pick your production match threshold and your loose manual-blur threshold from **your own data**. Write the numbers and the date into `docs/ARCHITECTURE.md`. Shipping thresholds someone wrote down as an example is how the blur silently fails in the demo.

Two honesty notes that belong with the numbers rather than in the viva prep, because this is where they will be forgotten. Thirty photos of three people is a small and unrepresentative sample, so the thresholds are overfitted to your demo set; say that yourself rather than being asked. And run the manual-blur threshold against **curated references only** (D-54), which is what the abuse check uses in production, otherwise you calibrate one thing and ship another.

**CI (GitHub Actions):** on every PR, lint, typecheck, and unit tests for app, API, and worker, plus the authorization test above. Keep it under a few minutes. A CI pipeline nobody waits for is a CI pipeline that gets ignored. Add **Sentry's free tier** in Phase 0 as well; when something breaks in demo week you want a stack trace rather than a guess, and it is an afternoon.

---

## 12. Git & team collaboration

**Trunk-based, not GitFlow.** For three people, develop/release/hotfix branches are pure overhead.

```text
main ← always deployable
  ├── feature/venue-verification-gate
  ├── feature/album-face-filter
  └── fix/upload-queue-cancel
```

**PRs, even at this size.** The value is not process for its own sake. It is insurance against the bus-factor problem: if only the author has ever read a piece of code, that is a real risk when they are unavailable during exam week and their area breaks. A quick review spreads enough context that the team is not hostage to one person's availability.

**Ownership with mandatory cross-review.** One primary owner per surface (mobile, API, worker), matching comfort, but at least one of the other two reviews every PR. Not to gatekeep. To keep any area from becoming a black box.

**Conventional commits** (`feat:`, `fix:`, `chore:`). Makes `git log` useful when you are trying to remember why something changed three weeks ago. Never put anyone's name in a collaboration list or include co-author trailers (`Co-authored-by:`) in commits. PR titles and descriptions carry no tool attribution either, such as a "Generated with Claude Code" line.

**Issue tracking:** GitHub Projects, a simple Kanban board mapped to the phases in §14. Do not reach for Jira.

**This section also governs AI-generated code. See §18 for the specific rules.**

---

## 13. Deployment

### Mobile app

**EAS Build profiles** in `eas.json`:
- `development`: includes the dev client, for §10's iteration loop.
- `preview`: internal distribution, for "here, try this build" moments without the dev client attached.
- `production`: what you demo from at your defense. It builds an APK with internal distribution, because the demo phones get the app by sideload (D-61) and Android's store format, an app bundle, cannot be sideloaded.

### Backend: one server for development and the demo

**Development and the demo run on one Netcup RS 1000 G12 root server from 15 October 2026.** D-78 explains why. In short, what the team develops and tunes against is what the panel sees, and demo morning no longer depends on a laptop booting and a tunnel connecting. Until the switch, development runs on an interim server that `docs/ARCHITECTURE.md` §7 names.

**Two environments, one server.** Development uses the dev Supabase project and the dev bucket. The demo stack uses the stable project and bucket and goes up one month before the demo (D-76). How the two sit side by side on one server is open until Phase 7 (`docs/ARCHITECTURE.md` §7).

**What the server does not buy you.** It removes the laptop, not the network dependency. Supabase, R2, and the phones are all still on the network. If campus WiFi dies, the demo dies with it, which is why the fallback in §14's Phase 7 is a recorded walkthrough on local storage rather than a seeded dataset that lives in Supabase (D-62).

**Bus factor.** All three developers reach the same server over HTTPS, so nobody tunnels into anybody's laptop, and demo morning has no single machine in the room that has to boot.

### The server: one Netcup root server, no containers

**Why no Docker.** The common argument against Docker on small hardware is that it is slow, and that argument is wrong: on Linux, containers are namespaces and cgroups, not virtualization, and the runtime overhead is near zero. Do not say "Docker is slow" in your viva; someone will correct you. The real reason is simpler. Docker buys portability between environments, and you have exactly one environment. For a three-person team that has never deployed anything, the container layer is one more thing to learn, one more thing to break at 2am, and one more layer between you and a stack trace. Skip it, and get your repeatability from pinned dependencies and a written setup script instead.

**Order it with room to test.** Pick Ubuntu 24.04 LTS as the operating system. First orders come with a 30-day refund, so run the InsightFace benchmark on the server inside that window, because D-78's reopen condition depends on it. Netcup can hold orders from outside the EU for an ID check, so order a few days before you need the server.

**Set it up with `scripts/provision.sh`.** The script is this section in runnable form: system packages, the Node, pnpm and Python versions the repo pins, the `momentlens` user, the repo checkout and API build, both systemd units, nginx, the firewall and TLS. Every step checks before it acts, so running it again is safe. Copy it to the new server and run it as root:

```bash
scp scripts/provision.sh root@SERVER_IP:/root/
ssh root@SERVER_IP 'bash /root/provision.sh --domain api.yourdomain.com --email you@example.com'
```

Leave out `--email` to skip TLS until DNS points at the server; the script prints the `certbot` command to run then. Passing `--email` accepts Let's Encrypt's terms. The script never writes secrets, so fill in `/srv/momentlens/.env` yourself afterwards. The API refuses to start until `SUPABASE_URL` and `SUPABASE_SECRET_KEY` hold real values, and `journalctl -u momentlens-api` names the one that is wrong.

**Three choices in the script worth knowing.**
- **The install is filtered to `api...`**, the API and the workspace packages it depends on, so the server never installs Expo or React Native. `apps/mobile` is built by EAS, not here. Add a workspace package the API depends on and the filter picks it up on its own.
- **Node comes from the official release tarball** at the exact version in `.nvmrc`, checked against the published SHA-256 sums and installed under `/usr/local`. Never install it with fnm on the server. fnm puts binaries under the login user's home, which the service account cannot reach, and systemd fails with `status=203/EXEC`.
- **The `momentlens` user's home is `/var/lib/momentlens`, and the checkout is `/srv/momentlens`.** Keeping them apart stops pnpm's store and pip's cache from landing inside the git working tree.

**Two systemd units.** `provision.sh` writes these to `/etc/systemd/system/`. Change the script in the same PR as any change here.

`momentlens-api.service`:
```ini
[Unit]
Description=MomentLens Express API
After=network.target

[Service]
Type=simple
User=momentlens
WorkingDirectory=/srv/momentlens/apps/api
EnvironmentFile=/srv/momentlens/.env
ExecStart=/usr/local/bin/node --import ./dist/instrument.js dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`momentlens-worker.service`:
```ini
[Unit]
Description=MomentLens AI Worker
After=network.target

[Service]
Type=simple
User=momentlens
WorkingDirectory=/srv/momentlens/worker
EnvironmentFile=/srv/momentlens/.env
ExecStart=/srv/momentlens/worker/.venv/bin/python -m app.main
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**The API unit preloads `dist/instrument.js`**, which starts Sentry before `dist/index.js` imports express, because an ESM module's imports run before its own code (`apps/api/src/instrument.ts`). `deploy.sh` never rewrites units, so a server whose unit predates the preload keeps running the API without Sentry, and says nothing about it. Run `provision.sh` once there. It pulls and builds before it writes the unit, so `dist/instrument.js` exists by the time systemd restarts the API.

`Restart=always` is the whole reason to use systemd rather than `nohup` and hope. If the worker crashes on a malformed image at 3am, it comes back.

The worker answers `/health` on `127.0.0.1:8000`, and nginx does not proxy it. Ping it from the box with `curl http://127.0.0.1:8000/health`.

**nginx as reverse proxy**, in `/etc/nginx/sites-available/momentlens`:
```nginx
server {
    server_name api.yourdomain.com;
    client_max_body_size 1m;   # media goes to R2, not here. Keep this small
                               # on purpose: it's a guardrail against anyone
                               # accidentally adding a route that proxies files.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**TLS**: `sudo certbot --nginx -d api.yourdomain.com`. Certbot installs its own renewal timer; verify it with `systemctl list-timers | grep certbot`. You need a real domain for this. A cheap `.com` or a free `.me` from the GitHub Student Pack is fine, and you need HTTPS anyway because iOS App Transport Security will refuse plaintext.

**Deploying an update:** `scripts/deploy.sh` is this sequence, and running that script is how you deploy.

```bash
ssh SERVER 'sudo bash /srv/momentlens/scripts/deploy.sh'
```

What it does, in order:

```bash
cd /srv/momentlens
sudo -H -u momentlens git pull --ff-only
sudo -H -u momentlens env HUSKY=0 pnpm install --filter "api..." --frozen-lockfile
sudo -H -u momentlens pnpm --filter api build
sudo systemctl restart momentlens-api
# worker only if something under worker/ changed:
sudo -H -u momentlens worker/.venv/bin/pip install -r worker/requirements.txt
sudo systemctl restart momentlens-worker
```

The script decides that last pair by diffing `worker/` between the old commit and the new one, so a deploy that touched only the API leaves the worker running. Pass `--skip-worker` to leave it alone regardless.

**Logs**: `journalctl -u momentlens-worker -f`. Learn this command in week one. It is where every mysterious failure will be explained.

**Secrets**: EAS environment variables, which replaced EAS Secrets, one set per build profile. Only `EXPO_PUBLIC_` values reach the app and anyone holding the APK can read them, so no secret belongs in a mobile build at all. A `.env` on the server, owned by the `momentlens` user with `chmod 600`, referenced by both systemd units via `EnvironmentFile`. Never commit either.

**Supabase environments**: exactly two projects, which is the free-tier limit. A **dev** project (your daily database, fine to break) and a **stable** project (what the demo points at, treated carefully). Do not develop against the project you will demo from.

**Keep-alive**: free Supabase projects pause after 7 days of inactivity. Run it as a **GitHub Actions scheduled workflow**, not as a cron on the server (D-67). v3 put it on the box it was meant to protect against, which chains two failures together. One YAML file, independent failure domain. Set this up in Phase 0, not the week you discover a paused database.

That file is `.github/workflows/keepalive.yml`. It reads the seeded `health_check` row through PostgREST daily and fails the run on anything but 200, or if that row ever reaches the publishable key, because Supabase never defines what "activity" means and an auth health check may not count. Two things its first run taught us. Query a table, never the PostgREST root, which serves the OpenAPI spec and accepts secret keys only, so a publishable key gets 401 there. And send a publishable key on the `apikey` header alone, because it is not a JWT. One caveat that has nothing to do with Supabase: GitHub disables scheduled workflows in a public repository after 60 days with no repository activity, so a long quiet stretch stops the keep-alive without an error. `gh workflow enable keepalive.yml` brings it back.

**Fallback, and what "standby" has to actually mean.** The team's Azure for Students, AWS and GCP credits, held across the three of you and used in that order (D-79). The standby VM is created for the rehearsal, deleted, and created again for demo week, so a credit is only spent while it is protecting something. D-38 rejected rotation partly because the keep-alive cron lived on the box that would be moving. D-67 moved it to GitHub Actions, so that objection is gone.

A credit sitting unused is not a standby. To make it one, three things must exist before Phase 7:
1. `scripts/provision.sh`, the §13 setup sequence above as a runnable script rather than a list you follow by hand.
2. A written record of the DNS change: which registrar, which A record, and the TTL (set it low, 300s, at least a week before your defense so a swap propagates in minutes rather than hours). That record is in `docs/ARCHITECTURE.md` §7.
3. **One rehearsal.** Spin the standby VM up once on whichever credit is current, run `provision.sh`, point a staging subdomain at it, confirm the app works, then tear it down. An untested fallback is a story you tell yourself. Budget half a day in Phase 7.

Both R2 and Supabase are external, so a compute swap moves no data. That is the whole reason this fallback is cheap, and it is worth saying out loud in a viva.

---

## 14. Things to build first

The single most important idea here: **build one thin slice through the entire system before building any one piece deeply.** The biggest risk for a team that has never shipped past three screens is not "is the UI polished." It is discovering late that the pieces do not connect the way you assumed. Auth tokens not reaching the API, environment variables differing between local and deployed, CORS, a field name mismatch. These surface only when things are wired together, so wire them together first, ugly.

**Phase 0 — plumbing (days, not weeks)**
Environment on all three machines (§8/§9). Repo scaffolded (§3). Server provisioned with `scripts/provision.sh`, nginx and TLS up, both systemd units running something trivial. Supabase projects created, keep-alive cron running. Express has one route, `GET /health`, that queries one table. The Expo app has one screen that calls it and displays the result, from a phone, over the internet, against the real deployed API. Nothing here is a feature. The entire goal is proving the wiring.

Also in Phase 0: **Sentry's free tier** and the **GitHub Actions keep-alive** for both Supabase projects (D-67). There is no Cloudflare Tunnel, because the server has a public hostname with TLS (D-78).

Also in Phase 0: **create `docs/ARCHITECTURE.md` and assign it an owner.** It is referenced throughout this handbook as the source of truth (§18) and it does not write itself. Start it with headed but empty sections, filled in as each is decided: data model with every table and its RLS intent; the upload pipeline; the blur pipeline's stages and job types; measured similarity thresholds with the date they were measured; and deployment layout, which now means both environments and the DNS record. One person owns keeping it current, and updating it is part of the PR that changes the thing it describes, not a separate task nobody does.

Also in Phase 0, and it is not optional: **spike InsightFace on the server.** Prove that InsightFace, `onnxruntime` and OpenCV import and run one detection on one photo. If this fails, it changes your worker plan, and you want to know in week one rather than month seven. The spike passed on an ARM64 server and on the M1 on 2026-09-15; run it again on the x86-64 server the day it is provisioned.

**Phase 1 — walking skeleton**
Auth (sign up, log in via Supabase Auth), create an event with bare-minimum fields, join via a Guest Link, see it in a list. No QR, no camera, no AI, no offline handling, no polish. This proves the full stack end to end on the real feature set rather than a toy.

**Phase 2 — event structure**
The informational schedule with the §4.3 status computation, both role-specific invite links, attendee management, Force Verify. Still mostly CRUD, and that is the point: this is where you get comfortable with RLS and permission patterns before the hard parts arrive.

**Phase 3 — capture & upload**
The Viewfinder (native aspect, 1x fixed, no gallery picker), My Media with its SQLite queue, the single upload pipeline (D-58), SHA-256 pre-flight, presigned direct-to-R2 upload, and the bounded background behavior. **Build this with the verification check temporarily disabled in the pre-flight endpoint**, so every upload goes through. Get raw upload reliability solid in isolation; debugging it while also debugging the gate is twice as hard for no benefit.

**The worker skeleton and the `thumbnail_dims` job land in this phase too** (D-72, slice S-18a), right after the upload endpoints. The album filters on `processed_at` and only the worker sets it. Without them the album built here shows nothing until Phase 5, and the tempting stopgap is setting `processed_at` in Express.

**Phase 4 — location verification gating**
Add the on-device GPS check, the server-side re-validation, the queue gate, the per-sub-event Venue QR with offline scan recording, and the Force Verify override. Because the gate is on the person and not the photo, you avoid complex per-photo retry logic. If the user is not verified, the queue simply waits.

**Phase 5 — the AI worker and face blur**

**The warm-up job changed, because D-58 deleted the old one.** v3 started this phase with the `variant` job, which no longer exists. Start instead with a **thumbnail-and-dimensions job**, which D-72 moved into Phase 3 so it already exists by now: consume from `pgmq`, open the file from R2, write `width` and `height` onto the media row, write the 300px WebP if the client's upload failed to include one, bump `variant_version`, set `processed_at`. No ML, real output, and it proves the whole `pgmq` round trip plus the two rules that everything else depends on: `processed_at` written last (D-55) and the version bumped on every write (D-60). If those two are right here, they will be right in the job that matters.

**Retire it in the same PR that turns on `face_process`** (D-72). Once Do Not Publish users exist, `thumbnail_dims` is a publishing bug. It sets `processed_at` without blurring anything, and if it runs on the same upload as `face_process` it can publish the photo first or point the public keys back at the unblurred upload afterwards.

Then face detection and embedding. Then the blur pipeline: the public blurred file, one variant per Do Not Publish subject, a blurred thumbnail for each (D-69), the serving endpoint with its authorization check, the self-visible badge, and the manual correction flow with its threshold check against **curated** references (D-54).

**Write the serving endpoint's negative test before the endpoint** (§11). It is the most valuable test in the project and it is twenty lines.

**Do not skip the `reprocess` job.** It is easy to leave for later because nothing visibly depends on it during a happy-path test, and then three things break at once. It is what makes Do Not Publish retroactive over already-published photos (spec §4.11), what applies a confirmed manual blur across a user's other photos, and what the Admin's Revert action calls to undo a fraudulent request. Build it in the same pass as the blur pipeline, not in Phase 6.

**Verify the viewer-scoped filter with an actual test, not by inspection.** Spec §4.11 hides Do Not Publish faces from every viewer except the subject. The wrong implementation, a global exclusion, passes every test written from the other viewers' perspective and fails only for the subject, where it returns nothing. Write the positive case explicitly: a Do Not Publish user runs Find My Photos and gets their photos back.

Then run the calibration exercise in §11.

**Face blur has a real fallback ladder, and you should build the bottom rung early.** This is what makes it not a single point of demo-day risk:

1. **Full feature.** Automatic recognition against reference embeddings, personalized per-subject blur.
2. **If recognition is too slow or too inaccurate:** drop to *blur every detected face in this photo*, triggered manually per photo. This needs detection only, no reference embeddings, no matching, no thresholds. Detection is far more reliable than recognition, so this rung is much sturdier than the one above it.
3. **If detection itself is unusable on the server:** a manual blur box the user drags over a face. Pure image manipulation, no ML at all, cannot fail.

Build rung 3 first, in roughly half a day, before rungs 1 and 2. It is a useful feature in its own right, it is the escape hatch when automatic matching misses something in the demo, and building it after you need it is building it under pressure.

**Phase 6 — the rest**
Notifications (Approval Alerts and Album Lifecycle only). The Recognized Faces UI. Multi-select download, which routes through the same serving endpoint Phase 5 already built, because there is no separate download path and no compositing step (D-57). Theme and settings. The hard-coded constants. The formalized screens from spec §2.5: Join Confirmation, Pending Approval, Join Error, Forced Logout, Consent re-gate, Supabase Unavailable. The Close Album confirm dialog (spec §4.9), which is small and prevents the most likely real failure of the Photographer role.

**Phase 7 — buffer. Reserve it and defend it.**
Testing pass, performance pass (§16), UI polish, and demo rehearsal on real devices in the actual room. Reserve four weeks near your defense date and defend that reservation. It always gets tempting to fill with one more feature, and it is always a mistake. Build the seeded demo dataset here (spec §9), rehearse the nine-beat script, and only then, if the core is genuinely solid, consider a stretch goal from spec §7.

**This is also where the team reads the codebase** (D-68). Walk the subsystems in the order §14 built them, using `docs/ARCHITECTURE.md` and the decision log as the map. Ask an agent to explain anything unfamiliar; that is a good use of it and costs nothing.

**Four Phase 7 items that are not polish and will be skipped if they are not named:**
- **Judge devices** (D-61). The build installed on team-owned Android phones, accounts signed in, at least a week ahead. This is not testable on demo morning.
- **The offline fallback** (D-62). A recorded walkthrough of the full script on a USB stick and on a laptop in the room. The seeded dataset lives in Supabase, so a network failure takes it too.
- **The standby rehearsal** (D-79), per the criteria above.
- **The demo stack** (D-76, D-78). API and worker on the server against the stable project, up at the start of this phase.

Roughly: Phases 0 through 4 in the first semester, 5 through 7 in the second. A loose target, not a commitment.

**On building fast with AI and hardening afterwards.** The plan is reasonable and the buffer is imaginary until a date is attached to "feature complete." Two corrections worth internalising before you rely on it.

Generation speed helps most with the parts that were never the bottleneck: Express routes, Postgres schemas, RN screens, FastAPI handlers. It helps very little with the parts that actually consume months here, which are the viewfinder, background upload with `beginBackgroundTask` and an Android foreground service, the SQLite queue's retry and cancel semantics, deep links, push certificates, and RLS. Those fail at device and configuration boundaries rather than in code, and the debug loop is manual, on real hardware, one device at a time.

And "harden later" is false for anything with a shape. `variant_version` (D-60), the subject-versus-account split (D-63), the curated flag (D-54), and the `processed_at` predicate (D-55) are not hardening; they are schema. Get them wrong and the fix is a migration against live rows.

D-68 settled the review question that used to sit here: code comprehension is not a merge gate, and reading the codebase happens in this phase rather than continuously. What that does not change is where the surplus goes. Spend it on seed tooling, the tests in §11, reading the codebase, and rehearsal, not on more features. A feature generated in an afternoon still costs a rehearsal slot, a bug surface, and a question you have to answer.

---

## 15. UI design direction

The photos are the product. The chrome around them should recede, not compete.

**Typography.** Do not ship system defaults everywhere; it is the fastest way for an app to read as generic. A warm editorial serif for headings and event names (Fraunces has real personality and suits a celebration context without being twee) paired with a clean grotesk for body and UI (Inter or Manrope) gives an editorial feel for close to zero engineering effort. It is a font file and a few style definitions.

**Color.** A quiet warm neutral base, off-white in light mode and warm near-black in dark, so photos stay the visual focus. One or two accents used sparingly, for buttons, active states, and the Do Not Publish indicator, never as dominant chrome. A warm gold or marigold accent nods at the South Asian wedding context and reads as intentional rather than kitsch, as long as it stays an accent and never becomes a background competing with photos.

**Motion.** Purposeful, not decorative. Three worth doing well because they are cheap and high-impact: shutter press feedback (scale plus haptic via `expo-haptics`), a staggered fade-in for photos arriving via Realtime in the album grid, and a custom pull-to-refresh. Use Reanimated worklets (§16). Do not hand-roll screen transitions; Expo Router's native stack transitions already feel platform-correct for free.

**Do not neglect the unglamorous states.** A disproportionate amount of perceived polish comes from empty albums, loading states, offline banners, and errors. It is easy for a first-time team to skip because it is less fun than the main screens, and it is exactly the gap a demo audience notices.

**Dark mode, done once.** Define color tokens once and reference them everywhere. Never hardcode a hex in a component. Retrofitting dark mode onto scattered hardcoded colors is real, avoidable pain.

**Do Not Publish is not a toggle, and it has a precondition.** Spec §2.5 is deliberate: a switch implies reversibility this action does not have. Row shows "Off", tap opens a full explanation screen, a checkbox gates the confirm, and once active the row becomes a static "Active" badge with no chevron. This is the most sensitive UX decision in the app. Get it right early rather than leaving it as polish.

The precondition is new in v11 and it is a validation rule, not a nicety: activation is blocked unless the user has at least one reference photo or a profile photo (D-56). If they have neither, the screen says so and the confirm button stays disabled with a link to add reference photos. Without a reference embedding the pipeline has nothing to match on, so the activation would be permanent, irreversible, and protective of nobody, while the row displayed "Active." That is the same class of failure as calling a camera-roll folder "Private."

**One piece of UI that carries real weight: the self-visible marker.** When a Do Not Publish user views a photo they appear in, a small lock badge on the image and a line in the metadata overlay reading "visible only to you." Design this properly. Without it, a user cannot distinguish "the feature is working" from "the match failed and everyone can see me," and every missed match becomes a silent, unreportable privacy failure.

It is a **static badge on the photo**, not a box positioned over a crop region. v3 described the latter, because the subject saw an overlay; D-57 replaced that with a whole personalized file, so there is no region to anchor to and nothing that can drift out of alignment when the viewer zooms.

---

## 16. Performance: keeping the UI thread unblocked

**The current model, accurately.** React Native's New Architecture (JSI, Fabric, TurboModules) is mandatory as of RN 0.85; there is no legacy bridge to opt out of. This removes the old async, JSON-serializing bridge and allows direct synchronous calls, which meaningfully reduces cross-thread jank without eliminating it. Your app still has a separate JS thread from the native UI thread, and heavy synchronous JS work can still stall it.

**Mapped to this app:**

- **The album grid must use FlashList v2, never FlatList.** An album can reach the 2,000-photo cap in spec §4.17, and FlatList's virtualization is not close at that scale. Paginate the underlying TanStack Query too; do not fetch metadata for a 2,000-photo album in one request. Note that v2 is a breaking release: JS-only, New Architecture only, all size estimates removed, `MasonryFlashList` replaced by a `masonry` prop, and `FlashList<T>` refs renamed to `FlashListRef<T>`.
- **Sections in FlashList, not SectionList.** Flatten your sub-event sections into one array, mark headers with a `type` field, use `getItemType` to keep recycling pools clean, and pass `stickyHeaderIndices` for the sticky effect.
- **The grid renders square-cropped thumbnails on purpose.** Uniform heights mean the list computes total content height without measuring, so scroll position never needs correcting. If you ever switch to masonry, the packing math is trivial but the measurement is not, and you will need the `width`/`height` columns from spec §4.11 to avoid a collapse-then-expand reflow on every image load.
- **Gestures and animations use Reanimated worklets**, not the JS-driven `Animated` API. Worklets run on the UI thread and keep animating even when the JS thread is briefly busy handling an incoming Realtime update. This is a real difference for how a burst of arriving photos feels.
- **Keep Stage 1 image work in native modules** (`expo-image-manipulator`), never hand-rolled JS. HEIC conversion, EXIF handling, the 300px thumbnail, and the 4096px guard resize all run off the JS thread there.
- **SHA-256 is computed over the uploaded byte stream, not the thumbnail** (D-53). v3 hashed the thumbnail to keep the input small, and the cost of that was a hash that is not reproducible across platforms. Hashing 1 to 3MB is a few milliseconds. `expo-crypto`'s `digest()` takes the bytes and hashes them natively, so use it and stop worrying about it.
- **Give `expo-image` an explicit cache key that includes `variant_version`** (D-60), or a retroactive blur leaves the pre-blur image sitting in every client's disk cache. This is a correctness requirement wearing a performance costume.
- **`InteractionManager.runAfterInteractions`** for anything non-critical that would otherwise run during a screen transition.
- **Hermes v1** is Expo's default engine as of SDK 56 and precompiles to bytecode ahead of time. Faster startup, lower memory, nothing to configure.

**The same concern exists on the backend and is easy to violate accidentally.** Node's event loop is single-threaded for JS execution: any synchronous CPU-heavy work in an Express handler blocks *every other request that process is serving*, not just the one that triggered it. This is exactly why image and face processing lives in the Python worker behind `pgmq` and never inline in a route.

The way this gets violated on a real team: someone adds "just a quick" resize or format check directly in a route handler because the worker is not wired up for that case yet, it works fine in testing with one user, and it becomes a real problem the moment three people upload at once during a demo. Keep that boundary intact under deadline pressure. It is cheap to maintain and expensive to retrofit.

**The one place this rule is most concretely testable now:** the pre-flight endpoint runs two lookups on every single upload. Both are indexed equality checks, both must stay that way, and neither should ever quietly become something heavier as the codebase grows.

**There is no longer any endpoint that touches media bytes.** v3 described an authenticated download path that did a crop-and-paste composite in a request handler, which was CPU work inside Express on the box everything depends on and contradicted this section's own rule. D-57 removed it: every variant is pre-generated by the worker, so the serving endpoint does an authorization check and signs a URL. Keep it that way. If somebody proposes compositing anything in a route handler, that is this rule being violated again with a new name.

---

## 16.5 Implementing the navigation architecture (spec §2.5)

The two-tier navigation model is the most architecturally significant UI piece in the app.

**Global shell versus Event shell.** A nested layout in Expo Router: the root `_layout.tsx` defines the Global shell tabs (Events, Scan, Profile), and opening an event pushes into `event/[id]/_layout.tsx` which defines its own tab set. The Event shell's tabs differ by role (Guest: Home, My Media, Schedule; Admin adds Manage; Photographer gets My Media and Schedule only). Use a Zustand store reading the user's `membership.role` for the current event to conditionally render the correct tab set. Not three separate layout files.

**Persistent Event header.** A custom header component in the Event layout, not Expo Router's default stack header: event cover thumbnail, name, and a "‹ Events" back affordance, visible above the tabs the whole time.

**Camera FAB.** Not a tab. A positioned `Pressable` inside the My Media screen that launches a full-screen modal route. Its visibility is a derived boolean from the schedule data: is any sub-event currently In Progress, per spec §4.3's rule. Note that this rule now depends on the *next* sub-event's start time, not the current one's end time, so the derivation reads two rows, not one.

**Merged Home and Album with two-tier filtering.** Home is one screen, not a folder per sub-event. The sub-event chip row is local UI state in Zustand. The People/Uploader filter opens a bottom sheet; keep its active state in Zustand too and render it as a dismissible pill above the grid. The grid query takes `{ subEventId?, personId?, uploaderId? }` and is just an AND of whatever is active.

---

## 17. Quick reference: full library list

```text
Mobile (apps/mobile)
  expo, expo-router, expo-camera, expo-image, expo-image-picker,
  expo-image-manipulator, expo-location, expo-sqlite, expo-file-system,
  expo-notifications, expo-haptics, expo-crypto, expo-dev-client
  zustand, @tanstack/react-query
  nativewind (v4), tailwindcss (v3)
  react-native-mmkv
  react-hook-form, zod
  @shopify/flash-list          # v2
  react-native-reanimated, react-native-gesture-handler

API (apps/api)
  express, typescript
  @supabase/supabase-js
  @aws-sdk/client-s3           # presigned R2 upload URLs
  zod, @asteasolutions/zod-to-openapi
  pino, helmet
  tsx, esbuild                 # dev server, and the dist/index.js bundle (§13)

Worker (worker/)
  fastapi, uvicorn
  insightface, onnxruntime     # Phase 0 spike, rerun on the x86-64 server
  opencv-python-headless
  boto3
  psycopg or asyncpg
  pydantic

Tooling (root)
  pnpm, eslint, prettier, husky, lint-staged
  jest, @swc/jest, jest-expo, pytest, ruff
  maestro
  eas-cli, supabase (CLI)
```

No `imagehash`, no `Pillow`-based perceptual hashing. Deduplication is `expo-crypto`'s `digest()` over the upload bytes on the client, because Node's `crypto.createHash` does not exist in React Native, and an indexed lookup on the server.

---

## 18. Using AI coding tools without wrecking the project

You are three people with limited experience building something that would take a small experienced team several months, and you are going to lean on Opus 5 and Sol 5.6 heavily. That is a reasonable plan and I am not going to pretend otherwise. But it fails in specific, predictable ways, and a few of those failures are worse here than in a normal codebase.

**Ask for correct code, not for code that is easy to skim.**

Never instruct an agent to simplify for its own sake, and do not accept a rewrite that trades correctness or efficiency for a smaller diff. A model asked for "the simple version" will drop error handling, edge cases and the awkward branch that existed for a reason, and the result looks cleaner while being wrong. Ask for the correct implementation, then ask for an explanation of it if you want one (D-68).

Reading the codebase is a separate activity on its own schedule. Phase 7 reserves a month, and that is where it happens.

### The two rules

**Rule 1: the dangerous surfaces get read before they merge.**

The list: any RLS policy, the image-serving endpoint's authorization check, the upload queue's state machine, and auth or invite-token handling. Nothing outside that list requires it (D-68).

Agents write plausible SQL. Plausible RLS is the worst possible failure mode, because a policy that is subtly too permissive looks identical to a correct one and does not throw an error. It just quietly returns rows it should not. The same is true of an authorization check that derives identity from the wrong place.

The places where this matters most: the **image-serving endpoint's authorization check** (which file does this requester get for this photo), `media` (Photographers see only their own uploads), and `face_reference` (readable only by the owner and the worker's service role). Write an integration test for each that asserts the *negative* case. Serving the wrong file means a Do Not Publish user's face reaches someone it was specifically hidden from, which is the exact thing your app promises not to do.

Note that the serving check is application logic rather than SQL now that `dnp_crop` is gone (D-57). That makes it easier to test and no less dangerous to get wrong. An agent will happily write `if (isSubject) return subjectKey; return publicKey;` with `isSubject` derived from a client-supplied parameter, and it will look completely reasonable. The negative test is what catches that; nothing about how the code reads will.

**Rule 2: one architecture document with a named owner is the source of truth, not the agent's memory of the last session.**

Create `docs/ARCHITECTURE.md` in Phase 0. It holds: the data model with every table and its RLS intent, the upload pipeline and its R2 key families (D-70), the blur pipeline's stages, your calibrated similarity thresholds and the date you measured them, and the deployment layout. Ukasha owns it and decides every change; agents write the text (D-75). You paste it into context at the start of sessions that need it.

Without this, each agent session re-derives your design from whatever files it happened to read, and the derivations drift. Three weeks in you have two slightly different mental models of the same system living in two people's chat histories, and nobody notices until the field names stop matching.

### Managing context, practically

Context is the scarcest resource in an agent session and most people waste it on the wrong things.

**Give it the interface, not the implementation.** When asking for a screen that calls three endpoints, paste the zod schemas from `packages/shared-types`, not the Express handlers. The schemas are the contract; the handlers are noise. This is a large part of why `shared-types` exists.

**Start a fresh session per task, not per day.** A session that has been running for four hours contains three abandoned approaches, two files you no longer care about, and a bug you already fixed. All of it is competing for attention with your actual question. Finish a task, commit, start clean.

**Front-load the constraints.** "Expo SDK 57, RN 0.86, FlashList v2 with no size estimates, NativeWind, TanStack Query for server state, Zustand for UI state, no localStorage" at the top of a session prevents an entire category of wrong output. Models were trained on a lot of FlashList v1 and legacy-architecture React Native, and they will reach for `estimatedItemSize` and `MasonryFlashList` unless told not to.

**Ask for a plan before code on anything non-trivial.** "Before writing anything, describe how you would structure this and what you would touch." You catch a wrong approach in twenty seconds of reading instead of after reviewing 300 lines. This is also how you learn the reasoning, which is what you will need in the viva.

**Paste real errors, complete.** The whole stack trace, the whole failing test output, `journalctl` lines and all. Summarizing an error strips the detail that identifies it. Agents are unusually good at reading raw output and unusually bad at guessing what you paraphrased away.

**When it goes in circles, stop.** Two failed attempts at the same bug means the model is missing context you have not given it. Do not try a third prompt. Work out what it cannot see (a config file, the actual database schema, the real error) and give it that, or debug it yourself.

### What to delegate, and what not to

**Good delegation.** Boilerplate CRUD screens and endpoints. Zod schemas from a described shape. Test scaffolding. Converting a design description into NativeWind components. Explaining an unfamiliar API. Reviewing your code for bugs, which is one of the highest-value uses and the most underused. Writing the systemd units and nginx config in §13. Migration SQL, which you then read.

**Delegate carefully, and pair it with the negative test from §11.** Anything with RLS. The blur pipeline's box expansion and elliptical mask math, where an off-by-a-few-pixels error means a face is partly visible. The upload queue's state machine, where a wrong transition means photos silently vanish. Anything touching money or identity, which here means auth and invite tokens.

**Do not delegate.** The similarity thresholds; measure those (§11). The architecture decisions, which are the ones you defend. The demo script. This document.

### The version-drift problem, specifically

Your stack moves faster than model training data. Expo ships a major SDK roughly every four months and FlashList v2 was a breaking release. Expect confidently wrong output on: `estimatedItemSize` (removed in v2), `MasonryFlashList` (deprecated, now a prop), `expo-file-system`'s API (changed in SDK 54), legacy-architecture assumptions (there is no legacy architecture), and old `AsyncStorage` patterns.

The habit that fixes this: when an agent gives you an API you have not personally used, check the actual docs before building on it. Thirty seconds. A hallucinated prop that silently does nothing is much harder to debug than one that throws.

### Commit hygiene for agent-generated code

Commit in small pieces even when the agent produced 400 lines at once. The reason is `git bisect` and revert granularity, not review: a 400-line commit that broke the album gives you nothing to bisect against.

Write commit messages yourself. An agent-written message describes the diff; you want the message to describe the intent, and only you have that. Never put anyone's name in a collaboration list or include co-author attribution (no `Co-authored-by:` trailers) in commits.

If a PR is large because an agent generated a lot at once, split it along feature boundaries before requesting review.

### One thing that is easy to miss

One use of these tools is badly underrated here: **adversarial review of code that already works**. Paste your RLS policy and ask what could leak. Paste your queue state machine and ask what happens on a force-kill between two specific states. Ask what breaks if two clients bump `variant_version` concurrently.

That finds the class of bug this project is most exposed to, which is the kind that throws no error and passes every test written from the wrong angle. Generating one more feature does not.
