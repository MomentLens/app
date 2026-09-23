# MomentLens engineering handbook — v4
> How to actually build it: stack, architecture, environment, workflow, and sequencing.
> Companion to `Idea.md` (the spec), `DecisionLog.md` and `WorkSlices.md`.

## 0. How to use this document

Read §1 (stack), §2 (architecture), §8 or §9 (environment setup), and **§18 (AI tools)** once. Get your machines working. Then go straight to §14 and pull other sections as reference when you actually touch that subsystem.

§18 is not optional reading and it is not last for a reason of importance. It is last because it makes more sense once you know the shape of the system. Read it before you write code, not after, because retrofitting a team policy on AI-generated code three weeks in is much harder than agreeing on one now.

One framing before anything else. Everything here assumes v11's scope. If building this starts taking meaningfully longer than planned, the answer is almost never "work faster." It is "cut more," and spec §6 and spec §7 already list what is cuttable. Revisit that list before you panic, and revisit it early rather than in April.

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

**Pin your versions and do not chase upgrades.** The project is pinned to Expo SDK 57 and RN 0.86 (root `CLAUDE.md`). Expo ships a major SDK roughly every four months, so at least two more land before June 2027. Do not upgrade unless something is actually broken; an SDK bump in month eight costs a week and buys nothing you need.

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
- **Every image request is authorized before it becomes a URL, and there is no exception to that.** The client never constructs a bucket URL. It asks Express for a photo's image; Express checks whether the requester is a Do Not Publish subject in that photo and mints a short-lived presigned R2 URL for the correct pre-generated file (spec §4.11, spec §4.13). Viewing and downloading use the same endpoint. **Media bytes still never pass through Express**, because the variants already exist in R2 and Express only signs a URL (D-57).

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
│       │   └── integration/   # the RLS + serving-endpoint negative tests (§11.3)
│       └── package.json
│
├── worker/                   # Python AI worker. Outside apps/ on purpose: see below.
│   ├── CLAUDE.md
│   ├── app/
│   │   ├── jobs/                 # one file per job in docs/ARCHITECTURE.md §5
│   │   │   ├── thumbnail_dims.py # Phase 3 warm-up (D-72), retired by S-21
│   │   │   ├── face_process.py   # detect, embed, match, write public + subject variants
│   │   │   ├── reference_process.py
│   │   │   ├── reprocess.py      # match only, never re-detect
│   │   │   └── blur_region.py    # regenerate a photo's files with its blur regions
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

**R2 keys have one builder per family** (D-70, root invariant 12). The API builds the upload keys, the original and the client thumbnail, in one function. The worker builds every derived key. Each writes its keys onto the row, and whatever serves a file reads the column. Two languages formatting the same versioned key would drift, and a drift there serves a 404 at best and the wrong file at worst.

There is no `dedup.py` and no `variant.py`. Deduplication is a SHA-256 lookup in Express (§7), and nobody resizes, so there is no display variant to generate (D-58).

`packages/shared-types` is worth having even though it starts small. Anything crossing the app-to-API boundary lives here once and is imported by both sides. The alternative is spending an hour debugging a bug that turns out to be "the app expected `guestCount`, the API sends `guest_count`."

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

**Image dimensions.** The worker writes `width` and `height` onto every media row. Nothing about privacy depends on them. A future masonry grid does, because FlashList v2 no longer estimates sizes and masonry without known heights reflows on every image load (D-22).

**Two rules the album query must follow, and both fail silently if you get them wrong.**
- Filter on `processed_at IS NOT NULL` (D-55). A row that exists but has not been processed has no blur variants yet, so showing it in the shared album shows an unblurred photo. The uploader sees their own unprocessed photo in My Media with a spinner; nobody else sees it anywhere.
- Never cache a photo by media ID alone, and never by URL. `expo-image` caches under the key the serving endpoint returns, which is built from the signed object key plus `variant_version` (D-60, D-86). A media-ID key keeps the pre-blur image in every client's disk cache after a retroactive blur, and on a shared phone it hands the next account the previous one's unblurred variant. Logging out clears the image cache.

**Native modules.** `apps/mobile/CLAUDE.md` lists every native package in the build and what each one is for, and §17 is the full library list. Two rules worth repeating here: Stage 1 image work goes through `expo-image-manipulator`, native and off the JS thread, and hashing uses `expo-crypto`'s `digest()`, because Node's `crypto` does not exist in React Native.

---

## 5. Backend architecture (Express API)

**Layering: route → controller → service.** Routes define the HTTP surface, controllers parse and validate with zod, services hold business logic and talk to Supabase. This is not ceremony. It means "is this event's guest limit reached" is testable without an HTTP server, and it is the difference between three people working on different features and three people colliding in one giant `routes.ts`.

**Auth middleware.** Every authenticated route verifies the Supabase JWT from the `Authorization` header using Supabase's server SDK. Do not hand-roll JWT verification. The middleware attaches the verified user to `req.user`; nothing downstream re-checks identity.

**API contract.** Generate an OpenAPI spec from your zod schemas with `zod-to-openapi` so every endpoint's shape is documented and machine-checkable rather than tribal knowledge.

### 5.1 Authorization and RLS

**Authorization lives in the service layer (D-73).** The API queries Supabase with the secret key, so RLS never applies to it, and every rule below is a service-layer check with a negative authorization test: another user, another event, the wrong role. A missing check throws nothing and returns someone else's data, and that test is the only thing that catches it. `docs/ARCHITECTURE.md` §1 is the full table.

**RLS is a backstop against the app, not against the API.** It is on for every table, and the only policies are `SELECT` on `media` and `event`, which Realtime needs. Those two check membership through a `security definer` function, because `membership` has no policy and a plain subquery inside a policy sees no rows. They exist for Realtime only: the app reads `media` and `event` through the API like everything else, because the API applies soft deletes, pagination and the viewer-scoped face rules that a policy cannot. Adding a policy to make a client query work is the mistake root `CLAUDE.md` names; add an endpoint.

The rules easiest to get wrong:

- **`media`**: an **active** member of the event, only **once `processed_at` is set**, or at any time the uploader (D-55). A Photographer sees only their own uploads (spec §4.10). A row without `uploaded_at` is shown to nobody (D-82). Update and delete by the uploader and the event's Admin. `uploader_role_at_upload` is display metadata that drives the Uploader filter and nothing else: never in an authorization check, never in a routing branch (D-13).
- **`event`**: **active** members only.
- **`membership`**: a user reads their own rows; the Admin reads every row for their events.
- **`face_reference`**: the owner sees their own reference photos. Embeddings never leave the database and the worker.
- **`face` and `dnp_subject`**: only through the viewer-scoped rule, root invariant 4. A Do Not Publish subject learns they are in a photo; no other viewer learns who is. An endpoint that returns faces for a photo omits the subject identity of a Do Not Publish face unless the requester is that subject, and the People filter leaves those subjects out the same way (spec §4.11.3). Implement it as a predicate parameterized by the requesting user, never by omitting the row at write time. The wrong version throws nothing and returns nothing to Find My Photos for exactly the users the feature exists for (D-46).
- **`subject`**: the person a blur applies to, with a **nullable** foreign key to the auth user, from the first migration (D-63).

There is no `PlanTier` table. The hard-coded constants in spec §4.17 are plain conditionals in the relevant service functions, not a database lookup.

### 5.2 The image-serving endpoint

**The image-serving endpoint is the most sensitive authorization check in the system**, and it is application logic. It first drops every media id the requester may not see under the media rule in `docs/ARCHITECTURE.md` §1. For the rest it answers "which file does this requester get for this photo": the subject's own variant if a `dnp_subject` row on that media points at the requester's subject, the public file otherwise, each read from its column. It takes a batch of media ids, and returns with each URL the cache key and the own-variant flag that `docs/ARCHITECTURE.md` §3 describes (D-86). Get it wrong and a subject's unblurred variant reaches somebody else, which is the one thing the app promises not to do. Write the negative test before the endpoint (§11.3). It is built in two steps: S-13 in Phase 3 with the visibility check and the public file only, then S-21 in Phase 5 adds the subject's file and the own-variant flag (D-93).

### 5.3 API conventions

Every endpoint follows these, so the app has one way to read an answer. They exist before S-01 writes its first schema (D-94).

- **Paths** are plural nouns under the resource that owns them: `GET /events/{eventId}/media`, `POST /events/{eventId}/media/preflight`, `POST /media/{mediaId}/complete`. Ids are uuids in the path, never in a query string.
- **Bodies** are JSON, with camelCase fields named as the zod schema in `packages/shared-types` names them, as `HealthResponse` has `checkedAt`. A schema is named for its endpoint and ends in `Request` or `Response`.
- **Errors** have one body, `{ "error": { "code": "album_closed", "message": "..." } }`. Its schema is `ErrorResponse` in `packages/shared-types`, written in S-01's schema PR. The app switches on `code`, which is snake_case. `message` is for logs and is never shown to a user as it stands.
- **A 403 on an event** is how the app learns its user was removed or blocked, and it shows Access Removed (spec §4.1).
- Anything the table does not cover is a 500, which Sentry reports.

| Status | Means | `code` values so far |
|---|---|---|
| 200, 201 | Done; 201 when a row was created | |
| 400 | The body or path failed validation | `invalid_request` |
| 401 | No session, or it expired | `no_session` |
| 403 | Not an active member of this event, or the wrong role | `not_member`, `wrong_role`, `not_uploader` |
| 404 | Not found, or soft-deleted | `not_found` |
| 409 | A state conflict | `duplicate`, `album_closed`, `unverified`, `upload_missing` |
| 422 | A limit reached | `event_full`, `too_many_references` |
| 503 | A dependency is down | `GET /health` only, with its own body |

---

## 6. AI worker architecture (FastAPI)

This is a **queue consumer**, not a web server written in FastAPI. The distinction shapes how you build it. The main loop polls `pgmq`, dispatches to a job handler, writes results to Postgres and R2, and moves on. The HTTP surface is `/health` so nginx and you can ping it.

**Why this shape protects you.** Python's GIL means one process cannot truly run two CPU-bound tasks in parallel on threads; you need multiple processes. If the worker served live HTTP, a face-detection job would stall every other request that process was handling. As a queue consumer it is off the user-facing path entirely: the upload succeeds and returns the moment the file lands in R2, processing happens after, and the user finds out via Supabase Realtime. Run **one** worker process (`docs/ARCHITECTURE.md` §5) and leave headroom for Express, Postgres connections and nginx. ONNX Runtime already spreads one inference across threads, and D-78 measured that scaling; set the thread count from a measurement on the server, not from this paragraph.

**Load the model once, at startup.** Cold-loading InsightFace per job costs several seconds; a warm model takes well under a second for a photo with a few faces and several seconds for a large group, because every face gets its own recognition pass (D-78 has the measured numbers). Lazy-loading is the single most likely reason your demo feels slow, and it is entirely avoidable. Note that input resolution barely moves this number, because InsightFace resizes internally to `det_size` for detection and crops to 112x112 for recognition; what full-size input actually costs you is JPEG decode time, roughly 100 to 200ms.

**Job types.** Five pgmq jobs: `thumbnail_dims`, `face_process`, `reference_process`, `reprocess` and `blur_region`. Their triggers and work are in `docs/ARCHITECTURE.md` §5 and nowhere else, so this section does not repeat them. `face_process` matches every face against every subject with references who is an active member of the event, Do Not Publish or not, because Find My Photos reads the same matches (D-74).

**Three rules inside `face_process` that are easy to get subtly wrong:**

- **`processed_at` is written last, after every variant is in R2.** It is what makes the row album-visible (D-55). Write it early and you publish an unblurred photo for the length of the rest of the job.
- **Bump `variant_version` on every write, including the first** (D-60). The object key carries it. A stable key means clients serve the pre-blur image from their own cache after a retroactive blur.
- **N Do Not Publish subjects means N+1 files and N+1 thumbnails, never 2^N.** No viewer ever needs two subjects unblurred at once, so there is no combination to enumerate. A photo with no Do Not Publish face and no blur region produces no extra files at all.

**Blur implementation** is specified in spec §4.11.4.3 (D-65): the box expanded 30 to 40 percent with an elliptical mask, then downsample, upsample and a box blur. Thumbnails are cut from the blurred output.

**Use ONNX-exported models**, which InsightFace ships, rather than the full PyTorch runtime. Meaningfully faster CPU inference and a much smaller install, both of which matter on a CPU-only server.

**Model.** `buffalo_l`, with the detection and recognition modules only (D-92). Rerun D-78's benchmark on the server the day it is provisioned.

---

## 7. The upload pipeline, architecturally

Worth its own section because getting this wrong is the easiest way to make a small server the bottleneck for the entire app.

**Do not route media bytes through Express.** If every photo flows through Node, you pay for that bandwidth and CPU twice, once receiving and once forwarding, on a box you are specifically keeping light. Instead:

1. **Pre-flight** (small JSON, this *does* go through Express): content hash, sub-event ID, and any GPS reading or Venue QR scan the device holds for verification, each with its time; the photo carries no location (D-89). No image bytes, the thumbnail included (D-69). The checks and their order are `docs/ARCHITECTURE.md` §4: membership and album state; then the hash, where the caller's own unfinished row resumes and any other match is silently rejected; then, for a new row, the cap and verification. Every one is an indexed lookup, so none risks blocking the event loop.
2. **Presigned URLs.** If it passes, Express builds the upload keys for the photo and its thumbnail in its one key function, writes them onto the new media row (D-70), and presigns a PUT URL for each with `@aws-sdk/s3-request-presigner` over `@aws-sdk/client-s3` (R2 is S3-API-compatible), living 15 minutes (D-105). The cap check and the insert run in the `start_upload` SQL function, with the event row locked (D-95).
3. **Direct upload.** The client PUTs the photo and its thumbnail straight to R2. Express is not in this path.
4. **Completion.** The client tells Express "done." Express checks both objects with a HEAD, then calls the `complete_upload` SQL function, which sets `uploaded_at` where it is null and enqueues the `pgmq` job in the same transaction, so a retried completion enqueues nothing (D-82, D-95). supabase-js holds no transaction, so this cannot be two calls.

**The same rule covers every other image.** Event covers, profile photos and reference photos also go to R2 by presigned PUT, with a key the API builds (`docs/ARCHITECTURE.md` §3). No route handler ever receives image bytes.

**One client pipeline for every role.** v3 had two, split on the resize. D-58 removed the resize, so the only thing left that differs by role is the location gate, and that is a server-side check in pre-flight rather than a client behaviour.

| Step | Every role |
|---|---|
| EXIF strip | Yes. Timestamp and orientation survive; everything else, including GPS, is stripped. |
| HEIC to JPEG | Yes, and any other format that is not JPEG (D-105) |
| Client resize | **None**, unless the longest edge exceeds 4096px, in which case resize to 4096px. Never fires on a phone photo. |
| Thumbnail | WebP, 300px on the long edge, for the grid. Unblurred, so it goes to R2 by presigned PUT and is served only for photos with no Do Not Publish face and no blur region (D-69, D-83) |
| Hash | SHA-256 over the **exact byte stream about to be uploaded**, after EXIF strip and HEIC conversion |
| Location gate | Server-side in pre-flight. Photographers pass automatically. |

**Do not hash the thumbnail.** v3 did, and it does not work: WebP encoders differ across iOS, Android and library versions, so the same source photo hashes differently on two devices and after any dependency bump. Hash the bytes you are actually PUTting (D-53).

There is no role branch left to unit-test here. The pre-flight checks are worth a test each, and the resume branch most of all: kill the app between pre-flight and completion, relaunch, and assert the photo uploads rather than disappearing as its own duplicate.

**Why the client-side check is not a security hole.** Spec §4.5 has the client compare GPS against cached coordinates on-device so the queue can unlock without connectivity, which matters at venues with bad WiFi. The client is optimistic; the server is the authority. The pre-flight submits the reading, the server re-validates it against the sub-event's stored coordinates, and only the server writes the `venue_verification` row. Do not let anyone "simplify" this by trusting a client-supplied `verified: true` boolean.

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
9. **Python 3.12 through uv**, the version in `worker/.python-version`: `brew install uv`, `uv python install 3.12`, then from `worker/` run `uv venv --python 3.12 && uv pip install -r requirements.txt`. `pnpm check:machine` looks for Python through uv, so a Python installed any other way reads as missing.
10. **EAS CLI**: `npm install -g eas-cli`, then `eas login`.
11. **VS Code** with ESLint, Prettier, Tailwind CSS IntelliSense, Python, and Expo Tools.
12. **Check the machine** with `pnpm check:machine` (not `pnpm doctor`, which is pnpm's own command). It compares Node, pnpm, Python, Java, the Android SDK and Xcode against the repo pins, and checks the git hook, the worker's venv, and both env files: `apps/mobile/.env` must set `EXPO_PUBLIC_API_URL` on every machine, while the root `.env` keys matter only if you run the API or worker locally. `.env.example` says which key goes in which file. Get the `.env` values from a teammate over a private channel or from the Supabase and R2 dashboards; never paste them into a commit, an issue or an agent chat that is shared.

**One thing that changed.** Your M1 is ARM64 and the server is x86-64 (D-78), so local and production no longer share an architecture. InsightFace 2.0 installs as pure Python and its dependencies ship wheels for both, which keeps that gap small. If a wheel behaves differently on the server, debug it there, not on your Mac. The M1 is still the fastest machine the team has measured for face processing, which is one reason the worker is yours.

**What the M1 is not.** Since D-78 it is not the demo runtime. The API and worker run on the server for the demo, so anything the demo needs has to work there, not only on your Mac.

---

## 9. Development environment — Windows (x86, no GPU)

Same Node/pnpm/Android Studio/Python/EAS/VS Code steps as §8, with these differences:

- Use **WSL2** (Ubuntu 24.04, the server's release) for the backend (Express and FastAPI), general Node tooling and the agent. It avoids a long tail of path-handling and native-module-compilation quirks. Clone the repo into the WSL2 filesystem (`~/`), not `/mnt/c`, where file watching and installs are slow; `pnpm check:machine` warns when it sees `/mnt/`.
- Install Node, pnpm, uv and Python **inside WSL2**, not the Windows-native versions, so the toolchain stays consistent. Ubuntu has no Homebrew, so two of §8's steps change: install fnm with `curl -fsSL https://fnm.vercel.app/install | bash` and uv with `curl -LsSf https://astral.sh/uv/install.sh | sh`, open a new shell, then carry on from `fnm install` and `uv python install 3.12`.
- **Test Android on a physical phone over USB**, running the development build. Builds are arm64-v8a only (`apps/mobile/CLAUDE.md`), and the Android emulator on an x86 Windows machine runs x86_64 images, so it cannot install them. A phone is also what §10 recommends for the camera and GPS. Never Expo Go: since P0-9 the app needs native modules Expo Go does not ship, among them MMKV, the invite-link URL scheme and background upload. B and C run it on their own 64-bit Android phones, the arm64-v8a devices the build targets. **Open, to settle later:** whether the build is compiled on the Windows side or by EAS in the cloud, and how `adb` reaches the phone when Metro runs in WSL2.
- **The iOS Simulator does not exist on Windows.** Apple ships it only with Xcode. This is not workaround-able. Practically:
  - You can write and test 100% of the Android side locally, on a physical phone.
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

Linting, tests, the threshold calibration and CI, each in its own subsection so a slice cites only the one it needs.

### 11.1 Linting, formatting and hooks

**Linting and formatting:** ESLint and Prettier for TypeScript, Ruff for Python. Ruff replaces flake8, black, and isort with one much faster tool.

**Pre-commit hooks:** Husky and `lint-staged`, so issues are caught before a commit lands rather than in CI ten minutes later. `lint-staged` runs Prettier on the staged code files, `.tsx` included. When a markdown file or a doc script is staged, `.husky/pre-commit` copies the staged docs into `.slices/precommit/` and runs the docs gate there, so it checks what the commit holds rather than the working tree.

### 11.2 Unit and end-to-end tests

Testing proportionate to your timeline.

- **Unit tests, most of your test effort.** Pure logic, no UI, no network: Haversine distance for GPS verification, hard-coded limit checks, the pre-flight verification branch (§7), sub-event status computation from timestamps (spec §4.3: overlaps, the gaps between sub-events, and the event's span computed from its sub-events, D-88). Jest with the `jest-expo` preset for the app and plain Jest for the API, since `jest-expo` is an Expo preset with no place on an Express server; `pytest` for the worker.
  - There is no pHash Hamming distance test any more. Deduplication is a hash equality check.
  - There is no client-pipeline role branch to test any more either (D-58).
- **E2E tests, few, and only for flows that would be genuinely bad to break.** Maestro against a handful of critical paths: sign up, join event, capture, see it in the album. Verify a Do Not Publish face is blurred for a second viewer. Verify photos sit in the local queue when location permission is denied and only upload after a QR scan. Do not try to E2E everything.

### 11.3 Integration tests, and the one to write first

Some integration tests, and one of them is the most valuable test in the project.

**Write this one first, before the endpoint it tests exists.** Authenticate as user A. Request the image for a photo where user B is a Do Not Publish subject. Assert that what comes back is the public file and not B's variant, that no response to A contains B's variant key, and that an unsigned GET of that key on the bucket returns 403. Roughly twenty lines. If this project has exactly one test, that is the one, because a too-permissive authorization check throws no error and looks identical to a correct one; it just returns the wrong file (§18).

Then the negative API tests (D-73): a Photographer cannot read another user's media, one user cannot read another's `face_reference` rows, and no endpoint returns a Do Not Publish subject's identity to anyone else. The two RLS policies, `SELECT` on `media` and `event`, get a Realtime test: a non-member receives nothing, and a member receives no unprocessed row they did not upload.

Also worth an integration test, because it fails silently in the other direction: does the album query exclude rows with `processed_at` null (D-55), and does a Do Not Publish user's Find My Photos return their own photos (spec §4.11, the viewer-scoped filter).

### 11.4 Calibrating the similarity thresholds

**One calibration task that is not a test but belongs here.** The spec gives no similarity thresholds, and `docs/ARCHITECTURE.md` §6 records them as not measured. Before Phase 5 ends, take roughly 30 photos of the three of you in varied lighting and angles, compute the cosine similarity distribution for same-person and different-person pairs, and pick your production match threshold from **your own data**. Write the numbers and the date into `docs/ARCHITECTURE.md`. Shipping thresholds someone wrote down as an example is how the blur silently fails in the demo.

Two honesty notes that belong with the numbers rather than in the viva prep, because this is where they will be forgotten. Thirty photos of three people is a small and unrepresentative sample, so the thresholds are overfitted to your demo set; say that yourself rather than being asked.

### 11.5 CI and error reporting

**CI (GitHub Actions):** on every PR, lint, typecheck, and unit tests for the app and the API, plus the authorization test above. The worker gets its job, Ruff and pytest, with S-18a. Keep it under a few minutes. A CI pipeline nobody waits for is a CI pipeline that gets ignored. **Sentry** (the Education plan, `docs/ARCHITECTURE.md` §7) goes in during Phase 0 as well; when something breaks in demo week you want a stack trace rather than a guess.

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

### 13.1 Mobile app

**EAS Build profiles** in `eas.json`:
- `development`: includes the dev client, for §10's iteration loop.
- `preview`: internal distribution, for "here, try this build" moments without the dev client attached.
- `production`: what you demo from at your defense. It builds an APK with internal distribution, because the demo phones get the app by sideload (D-61) and Android's store format, an app bundle, cannot be sideloaded.

### 13.2 Backend: one server for development and the demo

**Development and the demo run on one Netcup RS 1000 G12 root server from 15 October 2026.** D-78 explains why. In short, what the team develops and tunes against is what the panel sees, and demo morning no longer depends on a laptop booting and a tunnel connecting. Until the switch, development runs on an interim server that `docs/ARCHITECTURE.md` §7 names.

**Two environments, one server.** Development uses the dev Supabase project and the dev bucket. The demo stack uses the stable project and bucket and goes up one month before the demo (D-76). How the two sit side by side on one server is open until Phase 7 (`docs/ARCHITECTURE.md` §7).

**What the server does not buy you.** It removes the laptop, not the network dependency. Supabase, R2, and the phones are all still on the network. If campus WiFi dies, the demo dies with it, which is why the fallback in §14's Phase 7 is a recorded walkthrough on local storage rather than a seeded dataset that lives in Supabase (D-62).

**Bus factor.** All three developers reach the same server over HTTPS, so nobody tunnels into anybody's laptop, and demo morning has no single machine in the room that has to boot.

### 13.3 The server: one Netcup root server, no containers

#### 13.3.1 Why no Docker

**Why no Docker** (D-39). Not because it is slow: on Linux, containers are namespaces and cgroups, the runtime overhead is near zero, and saying otherwise in a viva gets you corrected. Docker buys portability between environments and there is exactly one. For a team that has never deployed, it is one more layer between a failure and its stack trace. Repeatability comes from pinned dependencies and `scripts/provision.sh` instead.

#### 13.3.2 Ordering and provisioning

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

#### 13.3.3 The two systemd units

**Two systemd units**, `momentlens-api.service` and `momentlens-worker.service`, both run as the `momentlens` user from `/srv/momentlens` with `EnvironmentFile=/srv/momentlens/.env`. `scripts/provision.sh` writes them to `/etc/systemd/system/` and is the only copy of their text, so change them there.

**Two lines in the API unit do more than start it.** `--import ./dist/instrument.js` starts Sentry before `dist/index.js` imports express, because an ESM module's imports run before its own code (`apps/api/src/instrument.ts`). `Environment=NODE_ENV=production` keeps stack traces out of responses. Without it, Express answers an unhandled error with a 500 page that holds the full stack trace and file paths. `deploy.sh` never rewrites units, so a server whose unit predates either line keeps running without it and says nothing. Run `provision.sh` once there. It pulls and builds before it writes the unit, so `dist/instrument.js` exists by the time systemd restarts the API.

`Restart=always` is the whole reason to use systemd rather than `nohup` and hope. If the worker crashes on a malformed image at 3am, it comes back.

The worker answers `/health` on `127.0.0.1:8000`, and nginx does not proxy it. Ping it from the box with `curl http://127.0.0.1:8000/health`.

#### 13.3.4 nginx and TLS

**nginx as reverse proxy**, in `/etc/nginx/sites-available/momentlens`, written by `provision.sh`. It proxies to the API on `127.0.0.1` at the `PORT` in `.env`, 3000 by default, with `client_max_body_size 1m`. Media goes to R2, so the small limit is on purpose: it is a guardrail against anyone adding a route that proxies files (root invariant 5).

**TLS**: `sudo certbot --nginx -d api.yourdomain.com`. Certbot installs its own renewal timer; verify it with `systemctl list-timers | grep certbot`. The domain is `api.momentlens.me` (`docs/ARCHITECTURE.md` §7). HTTPS is not optional, because iOS App Transport Security refuses plaintext.

#### 13.3.5 Deploying an update

**Deploying an update** is `ssh SERVER 'sudo bash /srv/momentlens/scripts/deploy.sh'`. The script pulls, installs the API's dependencies, builds and restarts the API. It reinstalls and restarts the worker only if something under `worker/` changed between the old commit and the new one; `--skip-worker` leaves it alone regardless. It never rewrites the units, so a unit change needs `provision.sh`.

**Logs**: `journalctl -u momentlens-worker -f`. Learn this command in week one. It is where every mysterious failure will be explained.

**Secrets**: EAS environment variables, which replaced EAS Secrets, one set per build profile. Only `EXPO_PUBLIC_` values reach the app and anyone holding the APK can read them, so no secret belongs in a mobile build at all. A `.env` on the server, owned by the `momentlens` user with `chmod 600`, referenced by both systemd units via `EnvironmentFile`. Never commit either.

**Supabase environments**: exactly two projects, which is the free-tier limit. A **dev** project (your daily database, fine to break) and a **stable** project (what the demo points at, treated carefully). Do not develop against the project you will demo from.

**Keep-alive**: free Supabase projects pause after 7 days of inactivity, so `.github/workflows/keepalive.yml` reads `health_check` in both projects daily from GitHub Actions, not from the server it protects (D-67). `docs/ARCHITECTURE.md` §7 has what it checks and the one trap: GitHub disables scheduled workflows after 60 days with no repository activity.

**Fallback.** The team's Azure for Students, AWS and GCP credits, used in that order, with a standby VM created only for the Phase 7 rehearsal and for demo week (D-79).

A credit sitting unused is not a standby. To make it one, three things must exist before Phase 7:
1. `scripts/provision.sh`, the §13 setup sequence above as a runnable script rather than a list you follow by hand.
2. A written record of the DNS change: which registrar, which A record, and the TTL (set it low, 300s, at least a week before your defense so a swap propagates in minutes rather than hours). That record is in `docs/ARCHITECTURE.md` §7.
3. **One rehearsal.** Spin the standby VM up once on whichever credit is current, run `provision.sh`, point a staging subdomain at it, confirm the app works, then tear it down. An untested fallback is a story you tell yourself. Budget half a day in Phase 7.

Both R2 and Supabase are external, so a compute swap moves no data. That is the whole reason this fallback is cheap, and it is worth saying out loud in a viva.

---

## 14. Things to build first

The single most important idea here: **build one thin slice through the entire system before building any one piece deeply.** The biggest risk for a team that has never shipped past three screens is not "is the UI polished." It is discovering late that the pieces do not connect the way you assumed. Auth tokens not reaching the API, environment variables differing between local and deployed, CORS, a field name mismatch. These surface only when things are wired together, so wire them together first, ugly.

### 14.0 Phase 0 — plumbing (days, not weeks)
Environment on all three machines (§8/§9). Repo scaffolded (§3). Server provisioned with `scripts/provision.sh`, nginx and TLS up, both systemd units running something trivial. Supabase projects created, keep-alive cron running. Express has one route, `GET /health`, that queries one table. The Expo app has one screen that calls it and displays the result, from a phone, over the internet, against the real deployed API. Nothing here is a feature. The entire goal is proving the wiring.

Also in Phase 0: **Sentry** and the **GitHub Actions keep-alive** for both Supabase projects (D-67). There is no tunnel, because the server has a public hostname with TLS (D-78). `docs/ARCHITECTURE.md` exists and Ukasha owns it (D-75); updating it is part of the PR that changes what it describes.

Also in Phase 0, and it is not optional: **spike InsightFace on the server.** Prove that InsightFace, `onnxruntime` and OpenCV import and run one detection on one photo. If this fails, it changes your worker plan, and you want to know in week one rather than month seven. The spike passed on an ARM64 server and on the M1 on 2026-09-15; run it again on the x86-64 server the day it is provisioned.

### 14.1 Phase 1 — walking skeleton
Auth (sign up, log in via Supabase Auth), create an event with bare-minimum fields, join via a Guest Link, see it in a list. No QR, no camera, no AI, no offline handling, no polish. This proves the full stack end to end on the real feature set rather than a toy.

### 14.2 Phase 2 — event structure
The informational schedule with the §4.3 status computation, both role-specific invite links, attendee management. Force Verify waits for Phase 4, where the gate it overrides arrives (S-17). Still mostly CRUD, and that is the point: this is where the service-layer authorization checks and their negative tests become routine before the hard parts arrive (D-73).

### 14.3 Phase 3 — capture & upload
The Viewfinder (native aspect, 1x fixed, no gallery picker), My Media with its SQLite queue, the single upload pipeline (D-58), SHA-256 pre-flight, presigned direct-to-R2 upload, and the bounded background behavior. **Build this with the verification check temporarily disabled in the pre-flight endpoint**, so every upload goes through. Get raw upload reliability solid in isolation; debugging it while also debugging the gate is twice as hard for no benefit.

**The image-serving endpoint starts here** (D-93, S-13): the visibility check, the public file and the cache key, with its negative test written first. The album needs it to show anything, and a second serving path is exactly what root invariant 3 forbids.

**The worker skeleton and the `thumbnail_dims` job land in this phase too** (D-72, slice S-18a), right after the upload endpoints. The album filters on `processed_at` and only the worker sets it. Without them the album built here shows nothing until Phase 5, and the tempting stopgap is setting `processed_at` in Express.

### 14.4 Phase 4 — location verification gating
Add the on-device GPS check, the server-side re-validation, the queue gate, the Venue QR (one per venue, D-85) with offline scan recording, and the Force Verify override. Because the gate is on the person and not the photo, you avoid complex per-photo retry logic. If the user is not verified, the queue simply waits.

### 14.5 Phase 5 — the AI worker and face blur

<!-- abstract: Build order for the worker: thumbnail_dims is already running from Phase 3 and is retired in the same PR that turns on face_process; then detection, embedding, the blur pipeline and the serving endpoint, whose negative test is written first, reprocess, and the fallback ladder. -->

**The warm-up job already exists.** `thumbnail_dims` shipped in Phase 3 (D-72, S-18a). It proves the `pgmq` round trip and the two rules everything else depends on: `processed_at` written last (D-55) and the version bumped on every write (D-60). If those two are right there, they will be right in the job that matters.

**Retire it in the same PR that turns on `face_process`** (D-72). Once Do Not Publish users exist, `thumbnail_dims` is a publishing bug. It sets `processed_at` without blurring anything, and if it runs on the same upload as `face_process` it can publish the photo first or point the public keys back at the unblurred upload afterwards.

Then face detection and embedding. Then the blur pipeline: the public blurred file, one variant per Do Not Publish subject, a blurred thumbnail for each (D-69), the subject's branch of the serving endpoint Phase 3 built (D-93), and the self-visible badge. Every file it writes applies the blur regions S-19 already stores (root invariant 6).

**Write the serving endpoint's negative test before the endpoint** (§11.3). It is the most valuable test in the project and it is twenty lines.

**Do not skip the `reprocess` job.** It is easy to leave for later because nothing visibly depends on it during a happy-path test, and then three things break at once. It is what makes Do Not Publish retroactive over already-published photos (spec §4.11), what carries a change in someone's reference photos to every photo, and what matches a user who joins an event late against the photos already there (D-84). It also has to apply every stored blur region, or a region disappears on its next run (root invariant 6). Build it straight after the blur pipeline, as S-25 in Phase 5, not in Phase 6.

**Verify the viewer-scoped filter with an actual test, not by inspection.** Spec §4.11 hides Do Not Publish faces from every viewer except the subject. The wrong implementation, a global exclusion, passes every test written from the other viewers' perspective and fails only for the subject, where it returns nothing. Write the positive case explicitly: a Do Not Publish user runs Find My Photos and gets their photos back.

Then run the calibration exercise in §11.4.

**Face blur has a real fallback ladder, and you should build the bottom rung early.** This is what makes it not a single point of demo-day risk:

1. **Full feature.** Automatic recognition against reference embeddings, personalized per-subject blur.
2. **If recognition is too slow or too inaccurate:** drop to *blur every detected face in this photo*, triggered manually per photo. This needs detection only, no reference embeddings, no matching, no thresholds. Detection is far more reliable than recognition, so this rung is much sturdier than the one above it.
3. **If detection itself is unusable on the server:** a manual blur box the user drags over a face. Pure image manipulation, no ML at all, cannot fail.

Build rung 3 first, in roughly half a day, before rungs 1 and 2. It is a useful feature in its own right, it is the escape hatch when automatic matching misses something in the demo, and building it after you need it is building it under pressure. Spec §4.11.4.4 specifies it (D-83): any Guest or the Admin draws a rectangle, it blurs every file of the photo, and it is stored so no regeneration drops it.

### 14.6 Phase 6 — the rest
Notifications (Approval Alerts and Album Lifecycle only). Multi-select download, which routes through the same serving endpoint Phase 3 built and Phase 5 extended, because there is no separate download path and no compositing step (D-57). Theme and settings. The rest of the formalized screens in spec §2.5.8: Access Removed, Consent re-gate and Supabase Unavailable. Join Confirmation, Pending Approval and Join Error arrive with the join flow in Phase 1 (S-03), and Forced Logout with auth (S-01). The album toggle with its Close Album confirm dialog (spec §4.9), which is small and prevents the most likely real failure of the Photographer role, and which switches on the album-open check pre-flight has carried since Phase 3 (D-82). The hard-coded limits are not here: each is enforced by the slice where it can be crossed (spec §4.17).

### 14.7 Phase 7 — buffer. Reserve it and defend it
Testing pass, performance pass (§16), UI polish, and demo rehearsal on real devices in the actual room. Reserve four weeks near your defense date and defend that reservation. It always gets tempting to fill with one more feature, and it is always a mistake. Build the seeded demo dataset here (spec §9), and load it through the real pre-flight, upload and completion path so `face_process` blurs it; a seed script that inserts media rows with `processed_at` already set publishes unblurred photos (root invariant 1). Rehearse the nine-beat script, and only then, if the core is genuinely solid, consider a stretch goal from spec §7.

**This is also where the team reads the codebase** (D-68). Walk the subsystems in the order §14 built them, using `docs/ARCHITECTURE.md` and the decision log as the map. Ask an agent to explain anything unfamiliar; that is a good use of it and costs nothing.

**Four Phase 7 items that are not polish and will be skipped if they are not named:**
- **Judge devices** (D-61). The build installed on team-owned Android phones, accounts signed in, at least a week ahead. This is not testable on demo morning.
- **The offline fallback** (D-62). A recorded walkthrough of the full script on a USB stick and on a laptop in the room. The seeded dataset lives in Supabase, so a network failure takes it too.
- **The standby rehearsal** (D-79), with the three things §13.3.5 says must exist before it.
- **The demo stack** (D-76, D-78). API and worker on the server against the stable project, up at the start of this phase.

Roughly: Phases 0 through 4 in the first semester, 5 through 7 in the second. A loose target, not a commitment.

**On building fast with AI and hardening afterwards.** The plan is reasonable and the buffer is imaginary until a date is attached to "feature complete." Two corrections worth internalising before you rely on it.

Generation speed helps most with the parts that were never the bottleneck: Express routes, Postgres schemas, RN screens, FastAPI handlers. It helps very little with the parts that actually consume months here, which are the viewfinder, background upload with `beginBackgroundTask` and an Android foreground service, the SQLite queue's retry and cancel semantics, deep links, push certificates, and RLS. Those fail at device and configuration boundaries rather than in code, and the debug loop is manual, on real hardware, one device at a time.

And "harden later" is false for anything with a shape. `variant_version` (D-60), the subject-versus-account split (D-63), the blur-region table (D-83), and the `processed_at` predicate (D-55) are not hardening; they are schema. Get them wrong and the fix is a migration against live rows.

D-68 settled the review question that used to sit here: code comprehension is not a merge gate, and reading the codebase happens in this phase rather than continuously. What that does not change is where the surplus goes. Spend it on seed tooling, the tests in §11, reading the codebase, and rehearsal, not on more features. A feature generated in an afternoon still costs a rehearsal slot, a bug surface, and a question you have to answer.

---

## 15. UI design direction

The photos are the product. The chrome around them should recede, not compete.

**Typography.** Do not ship system defaults everywhere; it is the fastest way for an app to read as generic. A warm editorial serif for headings and event names (Fraunces has real personality and suits a celebration context without being twee) paired with a clean grotesk for body and UI (Inter or Manrope) gives an editorial feel for close to zero engineering effort. It is a font file and a few style definitions.

**Color.** A quiet warm neutral base, off-white in light mode and warm near-black in dark, so photos stay the visual focus. One or two accents used sparingly, for buttons, active states, and the Do Not Publish indicator, never as dominant chrome. A warm gold or marigold accent nods at the South Asian wedding context and reads as intentional rather than kitsch, as long as it stays an accent and never becomes a background competing with photos.

**Motion.** Purposeful, not decorative. Three worth doing well because they are cheap and high-impact: shutter press feedback (scale plus haptic via `expo-haptics`), a staggered fade-in for photos arriving via Realtime in the album grid, and a custom pull-to-refresh. Use Reanimated worklets (§16). Do not hand-roll screen transitions; Expo Router's native stack transitions already feel platform-correct for free.

**Do not neglect the unglamorous states.** A disproportionate amount of perceived polish comes from empty albums, loading states, offline banners, and errors. It is easy for a first-time team to skip because it is less fun than the main screens, and it is exactly the gap a demo audience notices.

**Dark mode, done once.** Define color tokens once and reference them everywhere. Never hardcode a hex in a component. Retrofitting dark mode onto scattered hardcoded colors is real, avoidable pain.

**Two pieces of UI carry real weight, and both are specified in the spec rather than here.** The Do Not Publish activation flow (spec §2.5.9) is the most sensitive UX in the app: not a toggle, blocked without an accepted reference, and a permanent "Active" badge once confirmed (D-31, D-56). The self-visible marker (spec §4.11.4.2) is a static lock badge, drawn from the serving endpoint's own-variant flag, and it is the only way a subject can tell working blur from a missed match (D-26, D-86). Design both properly and early; neither is polish.

---

## 16. Performance: keeping the UI thread unblocked

**The current model, accurately.** React Native's New Architecture (JSI, Fabric, TurboModules) is mandatory as of RN 0.85; there is no legacy bridge to opt out of. This removes the old async, JSON-serializing bridge and allows direct synchronous calls, which meaningfully reduces cross-thread jank without eliminating it. Your app still has a separate JS thread from the native UI thread, and heavy synchronous JS work can still stall it.

**Mapped to this app:**

- **The album grid must use FlashList v2, never FlatList.** An album can reach the 2,000-photo cap in spec §4.17, and FlatList's virtualization is not close at that scale. Paginate the underlying TanStack Query too; do not fetch metadata for a 2,000-photo album in one request. Note that v2 is a breaking release: JS-only, New Architecture only, all size estimates removed, `MasonryFlashList` replaced by a `masonry` prop, and `FlashList<T>` refs renamed to `FlashListRef<T>`.
- **Sections in FlashList, not SectionList.** Flatten your sub-event sections into one array, mark headers with a `type` field, use `getItemType` to keep recycling pools clean, and pass `stickyHeaderIndices` for the sticky effect.
- **The grid renders square-cropped thumbnails on purpose.** Uniform heights mean the list computes total content height without measuring, so scroll position never needs correcting. If you ever switch to masonry, the packing math is trivial but the measurement is not, and you will need the `width`/`height` columns from spec §4.11 to avoid a collapse-then-expand reflow on every image load.
- **Gestures and animations use Reanimated worklets**, not the JS-driven `Animated` API. Worklets run on the UI thread and keep animating even when the JS thread is briefly busy handling an incoming Realtime update. This is a real difference for how a burst of arriving photos feels.
- **Keep Stage 1 image work in native modules** (`expo-image-manipulator`), never hand-rolled JS. HEIC conversion, EXIF handling, the 300px thumbnail, and the 4096px guard resize all run off the JS thread there.
- **SHA-256 over the uploaded bytes costs a few milliseconds** with `expo-crypto`'s native `digest()` (D-53). Never hash the thumbnail to save time; that hash is not reproducible across platforms.
- **Cache images under the key the serving endpoint returns** (§4, D-86), or a retroactive blur leaves the pre-blur image in every client's disk cache. This is a correctness requirement wearing a performance costume.
- **`InteractionManager.runAfterInteractions`** for anything non-critical that would otherwise run during a screen transition.
- **Hermes v1** is Expo's default engine as of SDK 56 and precompiles to bytecode ahead of time. Faster startup, lower memory, nothing to configure.

**The same concern exists on the backend and is easy to violate accidentally.** Node's event loop is single-threaded for JS execution: any synchronous CPU-heavy work in an Express handler blocks *every other request that process is serving*, not just the one that triggered it. This is exactly why image and face processing lives in the Python worker behind `pgmq` and never inline in a route.

The way this gets violated on a real team: someone adds "just a quick" resize or format check directly in a route handler because the worker is not wired up for that case yet, it works fine in testing with one user, and it becomes a real problem the moment three people upload at once during a demo. Keep that boundary intact under deadline pressure. It is cheap to maintain and expensive to retrofit.

**The one place this rule is most concretely testable now:** pre-flight runs its lookups on every single upload (§7). Every one is an indexed lookup, every one must stay that way, and none should ever quietly become something heavier as the codebase grows.

**No endpoint touches media bytes.** The worker pre-generates every variant, so the serving endpoint checks authorization and signs a URL (D-57). A proposal to composite anything in a route handler is this rule being broken under a new name.

---

## 16.5 Implementing the navigation architecture (spec §2.5)

The two-tier navigation model is the most architecturally significant UI piece in the app.

**Global shell versus Event shell.** A nested layout in Expo Router: the root `_layout.tsx` defines the Global shell tabs (Events, Scan, Profile), and opening an event pushes into `event/[id]/_layout.tsx` which defines its own tab set. The Event shell's tabs differ by role (Guest: Home, My Media, Schedule; Admin adds Manage; Photographer gets My Media and Schedule only). The role is server state, so it comes from the TanStack Query that fetches the user's membership for this event, and the layout renders the tab set from it (§4). Not three separate layout files, and not a copy of the role in Zustand.

**Persistent Event header.** A custom header component in the Event layout, not Expo Router's default stack header: event cover thumbnail, name, and a "‹ Events" back affordance, visible above the tabs the whole time.

**Camera FAB.** Not a tab. A positioned `Pressable` inside the My Media screen that launches a full-screen modal route. Its visibility is a derived boolean from the schedule data: is any sub-event currently In Progress, per spec §4.3's rule. A sub-event is In Progress from its start to its end (D-88), so between sub-events the FAB is hidden; overlapping ones tag a capture to the most recently started.

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

Three people are building with agents something that would take a small experienced team several months. That works, and it fails in specific, predictable ways, some of them worse here than in a normal codebase.

**Ask for correct code, not for code that is easy to skim.**

Never instruct an agent to simplify for its own sake, and do not accept a rewrite that trades correctness or efficiency for a smaller diff. A model asked for "the simple version" will drop error handling, edge cases and the awkward branch that existed for a reason, and the result looks cleaner while being wrong. Ask for the correct implementation, then ask for an explanation of it if you want one (D-68).

Reading the codebase is a separate activity on its own schedule. Phase 7 reserves a month, and that is where it happens.

### 18.1 The two rules

**Rule 1: the dangerous surfaces get read before they merge.**

The list: any RLS policy, the image-serving endpoint's authorization check, the upload queue's state machine, and auth or invite-token handling. Nothing outside that list requires it (D-68).

Agents write plausible SQL. Plausible RLS is the worst possible failure mode, because a policy that is subtly too permissive looks identical to a correct one and does not throw an error. It just quietly returns rows it should not. The same is true of an authorization check that derives identity from the wrong place.

The places where this matters most: the **image-serving endpoint's authorization check** (which file does this requester get for this photo), `media` (Photographers see only their own uploads), and `face_reference` (the owner's photos only; embeddings never leave the database and the worker). Write an integration test for each that asserts the *negative* case. Serving the wrong file means a Do Not Publish user's face reaches someone it was specifically hidden from, which is the exact thing your app promises not to do.

Note that the serving check is application logic rather than SQL now that `dnp_crop` is gone (D-57). That makes it easier to test and no less dangerous to get wrong. An agent will happily write `if (isSubject) return subjectKey; return publicKey;` with `isSubject` derived from a client-supplied parameter, and it will look completely reasonable. The negative test is what catches that; nothing about how the code reads will.

**Rule 2: one architecture document with a named owner is the source of truth, not the agent's memory of the last session.**

`docs/ARCHITECTURE.md` holds the data access rules, every table, the R2 key families (D-70), the upload pipeline, the worker jobs, the calibrated similarity thresholds with the date they were measured, and the deployment layout. Ukasha owns it and decides every change; agents write the text (D-75). Load the sections a task needs with `node scripts/doc.mjs arch §3`, not the whole file (D-80).

Without this, each agent session re-derives your design from whatever files it happened to read, and the derivations drift. Three weeks in you have two slightly different mental models of the same system living in two people's chat histories, and nobody notices until the field names stop matching.

### 18.2 Managing context, practically

Context is the scarcest resource in an agent session and most people waste it on the wrong things.

**Give it the interface, not the implementation.** When asking for a screen that calls three endpoints, paste the zod schemas from `packages/shared-types`, not the Express handlers. The schemas are the contract; the handlers are noise. This is a large part of why `shared-types` exists.

**Start a fresh session per task, not per day.** A session that has been running for four hours contains three abandoned approaches, two files you no longer care about, and a bug you already fixed. All of it is competing for attention with your actual question. Finish a task, commit, start clean.

**Front-load the constraints.** "Expo SDK 57, RN 0.86, FlashList v2 with no size estimates, NativeWind, TanStack Query for server state, Zustand for UI state, no localStorage" at the top of a session prevents an entire category of wrong output. Models were trained on a lot of FlashList v1 and legacy-architecture React Native, and they will reach for `estimatedItemSize` and `MasonryFlashList` unless told not to.

**Ask for a plan before code on anything non-trivial.** "Before writing anything, describe how you would structure this and what you would touch." You catch a wrong approach in twenty seconds of reading instead of after reviewing 300 lines. This is also how you learn the reasoning, which is what you will need in the viva.

**Paste real errors, complete.** The whole stack trace, the whole failing test output, `journalctl` lines and all. Summarizing an error strips the detail that identifies it. Agents are unusually good at reading raw output and unusually bad at guessing what you paraphrased away.

**When it goes in circles, stop.** Two failed attempts at the same bug means the model is missing context you have not given it. Do not try a third prompt. Work out what it cannot see (a config file, the actual database schema, the real error) and give it that, or debug it yourself.

### 18.3 What to delegate, and what not to

**Good delegation.** Boilerplate CRUD screens and endpoints. Zod schemas from a described shape. Test scaffolding. Converting a design description into NativeWind components. Explaining an unfamiliar API. Reviewing your code for bugs, which is one of the highest-value uses and the most underused. Writing the systemd units and nginx config in §13. Migration SQL, which you then read.

**Delegate carefully, and pair it with the negative test from §11.3.** Anything with RLS. The blur pipeline's box expansion and elliptical mask math, where an off-by-a-few-pixels error means a face is partly visible. The upload queue's state machine, where a wrong transition means photos silently vanish. Anything touching money or identity, which here means auth and invite tokens.

**Do not delegate.** The similarity thresholds; measure those (§11.4). The architecture decisions, which are the ones you defend. The demo script. This document.

### 18.4 The version-drift problem, specifically

The stack moves faster than model training data. Root `CLAUDE.md` lists the traps under "Model traps in this stack." The habit that fixes them: when an agent gives you an API you have not personally used, check the real docs before building on it. A hallucinated prop that silently does nothing is much harder to debug than one that throws.

### 18.5 Commit hygiene for agent-generated code

Commit in small pieces even when the agent produced 400 lines at once. The reason is `git bisect` and revert granularity, not review: a 400-line commit that broke the album gives you nothing to bisect against.

Write commit messages yourself. An agent-written message describes the diff; you want the message to describe the intent, and only you have that. Attribution rules are in §12.

If a PR is large because an agent generated a lot at once, split it along feature boundaries before requesting review.

### 18.6 One thing that is easy to miss

One use of these tools is badly underrated here: **adversarial review of code that already works**. Paste your RLS policy and ask what could leak. Paste your queue state machine and ask what happens on a force-kill between two specific states. Ask what breaks if two clients bump `variant_version` concurrently.

That finds the class of bug this project is most exposed to, which is the kind that throws no error and passes every test written from the wrong angle. Generating one more feature does not.

### 18.7 Writing the docs so an agent can use them

Agents read `docs/` through `scripts/doc.mjs`, which addresses every heading by id and resolves every citation. These conventions keep that working and keep agents from citing something that is not there. `pnpm docs:check` enforces the ones marked gated.

- **One paragraph per line.** No hard wraps in prose, so `grep` and `doc grep` find a whole sentence. Tables and code blocks keep their own line structure.
- **A numbered heading's depth is its number's depth plus one**: `## 5`, `### 5.2`, `#### 5.2.1`. A section a slice might cite gets a number. The one exception is Handbook `## 16.5`, a sibling of §16 rather than its child. `docs/ARCHITECTURE.md`'s per-table headings are unnumbered by design and cited as `arch:<table>`.
- **Every cross-document citation carries its prefix**: `spec §4.11`, `hb §7`, `arch §3`. A bare `§7` inherits a prefix written within the previous 60 characters, and otherwise resolves to its own document, then the spec, which can land in the wrong document without an error.
- **Decisions are `### D-nn: Title`.** Older entries use an em dash where the colon goes; both parse, and neither gets rewritten. Never renumber one. Retire one only by adding `~~(SUPERSEDED by D-nn)~~` or `~~(VOID, see D-nn)~~` to its heading; those are the two forms `doc` masks, so any other wording leaves the entry expandable into a brief. Change an entry by appending an "Amended (see D-nn)" line (gated: a `D-nn` heading the parser cannot read fails).
- **Slice rows are machine-read.** A Phase 0 row has three cells and every other row five. Never put a `|` inside a cell. The "Depends on" cell holds slice ids and nothing else, because the brief prints exactly those rows. A warning note is its own paragraph, opening with the slice id in bold (gated: a note naming no slice fails).
- **Cite a section id, never a line number.** `EngineeringHandbook.md:542` went stale in one PR. Ids survive edits and the gate checks them (gated: a dangling citation fails).
- **Renaming a heading changes its id.** Before renaming one, `doc why` it, or grep for `arch:<slug>` if it is a table heading, and update what cites it.
- **Say the date on anything that will stop being true**, such as a server that goes away on 2026-10-15, so the next reader can tell a stale line from a current one.

### 18.8 Running a slice with subagents

The procedure is `.claude/skills/slice/SKILL.md`; the two subagents are in `.claude/agents/`. Both are committed, so every developer runs the same ones. This section is why they are shaped that way, and the cheat-sheet.

**What a session costs before anyone types.** Estimated on 2026-09-23 with the token counter in `scripts/docindex.mjs`, not counting Claude Code's own system prompt and tool definitions: root `CLAUDE.md` 3,333 tokens, loaded into every session and every custom subagent. A package `CLAUDE.md` loads when work touches that package: `apps/api` 2,282, `apps/mobile` 2,706, `worker` 1,549. The skill is 2,953. Across the 44 slice briefs the median is about 2,240 and the p90 3,988, and the largest, S-21, is 7,233 (`doc toc slices` has each one). Repeated fixed files are served from the prompt cache, so they cost less money than their token count, but they still fill the window.

**A subagent is not free.** Each one starts by loading root `CLAUDE.md`, its own prompt (about 620 tokens for the auditor, 790 for the verifier) and the package file it works in, so a call costs about 4,000 to 6,800 tokens before it does anything, on top of the session that started it. It earns that only by keeping noise out of the session, where reasoning degrades as history piles up. The rule: delegate work that would put more than about 5,000 tokens into the session that the session will not need again. Do the rest inline.

**Why these two, and not more.** This is the smallest set that passes that rule, not a proven optimum; the first three slices measure it.

| Candidate | What it keeps out of the session | Verdict |
|---|---|---|
| `slice-auditor` | The doc lookups behind the read-back's hunt: every entity checked in `ARCHITECTURE.md`, every decision's `why`, spec §5. An estimated 5,000 to 15,000 tokens on a large brief, in the session that also carries the discussion with the developer | Kept, for briefs over about 1,500 tokens, 29 of the 44. Below that a brief names too few ids to repay 4,000 tokens of overhead. Runs on the session's model at high effort, once per slice, because the read-back is where a silent bug is cheapest to catch |
| `slice-verifier` | Lint, typecheck and test output, repeated on every fix round. A failing Jest suite or a `tsc` cascade runs to hundreds of lines | Kept. Sonnet, since it runs commands and summarizes failures; its invariant checks are suspicions a person confirms, and the four human-read surfaces still get a person |
| Built-in `Explore` | Whole files read to answer "what already exists" | Kept. It loads no `CLAUDE.md`, so it is the cheapest call there is |
| An implementer subagent | A package's code, in a build session that holds nothing else anyway | Dropped. A fresh build session per package isolates the same work for one root `CLAUDE.md` load instead of two, and the agent that builds is the one the developer answers, with no questions relayed |
| A schema author | Nothing; the schema is small and the developer reviews it in the same session | Not built |
| A reviewer | Nothing a teammate's review and `/code-review` do not already cover | Not built |

A model set in an agent file wins over `CLAUDE_CODE_SUBAGENT_MODEL` unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set. That does not make the two agents run the same model on every machine. `slice-auditor` inherits whatever model the developer's session runs. `slice-verifier`'s `sonnet` is the session's own Sonnet when the session runs one, and the default Sonnet otherwise. Both agents drop Edit and Write but keep Bash, which can still write; their prompts forbid it and nothing enforces it.

**Where context bloats, and what stops it.**

| Source | What happens | What stops it |
|---|---|---|
| The read-back conversation | Brief, follow-up sections and discussion ride into the build as history nobody needs | A fresh session per stage; only the approved card crosses |
| Test, lint, typecheck and build output | A failing run is hundreds of lines, repeated on every retry | `slice-verifier` writes full logs to `.slices/<id>/` and returns at most 20 lines per failure |
| Reading files to find one function | Whole files enter the context to answer a one-line question | `Explore` returns paths and names only |
| Fix loops | Each attempt appends a diff and an error | Two rounds per failure, then stop and ask (§18.2) |
| Several packages in one session | Each package's `CLAUDE.md` and code pile up together | One build session per package |
| Native build and device logs | Gradle and `adb logcat` run to thousands of lines | A person runs the device check and reports the result; never paste the log |

**The stages, and what each holds.** Token figures are estimates from the measured sizes above; replace them with the real numbers from the first three slices.

| Stage | Session holds | Delegated | Person decides | Hands forward |
|---|---|---|---|---|
| Read-back, `/slice S-12` | fixed files, brief, auditor and Explore reports, the read-back, the discussion: about 14,000 to 20,000 | `slice-auditor` on larger briefs, `Explore` | go, the decisions, doc fixes | the slice card in the issue, under 900 |
| Schema, `/slice S-12 schema` | fixed files, card, `packages/shared-types`: about 9,000 | nothing | merge the schema PR | the merged schema, by path |
| Build, `/slice S-12 build api`, one session per package | fixed files, card, the package's `CLAUDE.md` and code, verifier reports under 800 each: about 15,000 to 40,000, set by how much code it reads | `slice-verifier` | every question the card cannot answer, the phone check | commits; the last package opens the PR |
| Done, `/slice S-12 done` | fixed files, card, verifier report, the checklist: about 9,000 | `slice-verifier` | review, the human reads, `ARCHITECTURE.md` (Ukasha) | the merged slice, its issue closed |

**Handoffs are artifacts, never transcripts.**

- **The slice card** is the read-back after a person answered it: goal, decisions with who made them, what the slice builds against and produces, files in build order, negative tests, invariant numbers, edge cases with their rule ids, the doc ids to read while building, and anything still open. It lives in the slice's GitHub issue, so all three developers' agents load the same one. It is written once and changed only when a person changes a decision.
- **Schemas pass by path.** Once the schema PR merges, the card names the file in `packages/shared-types` and the exported names, and a build session reads that one file. Nothing pastes handler or screen code between sessions; the compiler checks the contract.
- **Invariants pass by number.** Root `CLAUDE.md` already reaches every session and every custom subagent, so nobody pastes it. The card lists the invariant numbers the slice touches and the negative test for each, and `slice-verifier` checks the diff for each numbered violation. What it flags is a suspicion for a person, not a verdict.
- **Subagent reports have a fixed shape and a size cap**, set in each agent file. A subagent never asks a person anything, and cannot: the auditor returns its questions under `DECISIONS NEEDED`, and the session asks them.

**When to start over.** `/clear` and reload the card at every stage boundary and between packages, after two failed fixes of the same problem, after a large log reached the context by accident, and when `/context` shows the window more than half full. Prefer that to `/compact` whenever a card exists: the card was reviewed by a person and the compaction summary was not. Never build two packages at once in one working tree; for a genuine alternative, use a separate git worktree.

**Other agent tools** follow the same stages through the handoff template in `docs/WorkSlices.md`. Without subagents, run the audit and the verification as separate sessions too, each starting from the card.

#### Cheat-sheet, for every slice

1. **Pick** a slice whose "Depends on" issues are all closed. If it has no issue, create one from the Work slice template, titled `S-12: <name>`.
2. **`/slice S-12`** in a fresh session. Read the read-back, starting with what the docs get wrong and the decisions list. **You decide:** answer every decision, fix the docs in their own PR if needed, then say go. The agent writes the card into the issue. `/clear`.
3. **`/slice S-12 schema`.** Review the schema PR. **You decide:** merge it. `/clear`.
4. **`/slice S-12 build api`**, `/clear`, then **`/slice S-12 build mobile`**, in the card's order. Answer every question yourself; never tell the agent to guess. **You decide:** run the phone check if the card says one is needed. The last package opens the PR. `/clear`.
5. **`/slice S-12 done`.** **You decide:** get one teammate's review, read any of the four human-read surfaces yourself, and send `ARCHITECTURE.md` changes to Ukasha. Merge, and close the issue.

Never carry a stage's session into the next, never paste a log into a session, and never let an agent answer its own question.
