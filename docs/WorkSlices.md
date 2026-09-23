# MomentLens work slices
> The assignable unit of work. One slice = one GitHub issue = one branch = one PR.

## What this file is and is not

This file names units of work and points at the spec sections that define them. **It never describes what a feature does.** If you want to know what Pending Approvals should look like, read spec §2.5, not this. That rule is what stops this file going stale: nothing in here can contradict the spec, because nothing in here repeats the spec.

Create one GitHub issue per slice from the **Work slice** issue template, titled with the slice ID and name, body containing only the spec references and the dependency list. The board (Backlog / In Progress / Review / Done) is per Handbook §12.

## Why a slice is not a screen

A Figma frame of "Pending Approvals" gives you a list, rows and two buttons. It does not give you the zod schema, the route, the rule deciding who can approve, the query hook and what it invalidates, the empty and error states, or what happens when the Admin approves the same person from two phones at once. An agent handed only the image invents all of that, differently for each of the three of you.

**A slice is all six layers of one feature:** schema, endpoint, the authorization rule, query hook, screen, and the unglamorous states. Whoever owns the slice owns all six.

## The rule that makes parallel work possible

**The first PR of any slice is the zod schema alone, merged before anyone writes UI or handlers.**

**The slice that first writes to a table owns its migration**, and its row cites that table's `arch:` heading. The two RLS policies belong to the slices that first need Realtime on them, and each gets a human read (D-68).

Once the contract is in `packages/shared-types`, the screen and the endpoint can be built at the same time against types that can be mocked, and no agent can invent a field name the compiler does not know. **An endpoint does not exist until its schema is in `shared-types`.**

## Definition of done

A slice is not done when the screen renders. It is done when all of these are true. The same list is in `.github/ISSUE_TEMPLATE/slice.md`, so every slice issue carries it as checkboxes.

- [ ] zod schema merged in `packages/shared-types`
- [ ] RLS policy written, or noted as not applicable. Only `media` and `event` have one; everything else is enforced in the service layer (D-73)
- [ ] **Read by a human before merging** if the slice touches any RLS policy, the image-serving endpoint's authorization check, the upload queue's state machine, or auth and invite-token handling (D-68)
- [ ] A negative test for each of those surfaces, and a negative authorization test for every new endpoint: another user, another event, the wrong role (D-73)
- [ ] Loading, empty, and error states exist, not just the happy path (Handbook §15)
- [ ] Works on a physical device, not only a simulator, if it touches camera, GPS, or the queue (Handbook §10)
- [ ] Unit test for any pure logic in it (Handbook §11.2)
- [ ] Dark mode uses tokens, no hardcoded hex
- [ ] Reviewed by one other person (Handbook §12)
- [ ] `docs/ARCHITECTURE.md` updated in the same PR if the slice added a table, a column, an R2 key, or a job type, written by the done stage as its own commit, with Ukasha reviewing that change (D-75, D-107)

## Ownership

**U** is Ukasha, **B** and **C** are the two teammates. Change the letters, keep the shape.

Two constraints drive this. Ukasha is on the M1, the fastest machine the team has measured for face processing (D-78), so the Python worker is his by default. And he did the planning, owns the docs, and will otherwise become the person everyone waits on, so the album and capture surfaces deliberately go elsewhere.

Owner means *builds it*. Review ownership is separate: every PR needs one of the other two, per Handbook §12.

---

# Phase 0 — all three together, not divided

Nobody works alone here. The point is that all three machines and the deployed stack are proven before anyone owns anything.

| ID | Slice | Reference |
|---|---|---|
| P0-1 | Repo scaffold, pnpm workspace, TS strict, ESLint rules, Prettier, Husky | HB §3, HB §11.1 |
| P0-2 | Server provisioned by `scripts/provision.sh`, nginx, TLS, both systemd units running something trivial | HB §13.3.2, HB §13.3.3, HB §13.3.4, D-39 |
| P0-3 | Supabase dev + stable projects, keep-alive for both as a GitHub Actions scheduled workflow, R2 buckets `momentlens-dev` and `momentlens-stable` | HB §13.3.5, D-67 |
| P0-4 | `GET /health` through to one Expo screen, on a phone, against the deployed API | HB §14.0 Phase 0 |
| P0-5 | **InsightFace spike on the server.** Blocking. If this fails the worker plan changes. Passed on ARM64 on 2026-09-15; rerun it on the x86-64 server | HB §14.0 Phase 0 |
| P0-6 | Figma tokens into `apps/mobile/tailwind.config.js` | HB §15 |
| P0-7 | Moved out of Phase 0. The demo stack goes up on the server at the start of Phase 7 (D-76, D-78) | D-76, D-78 |
| P0-8 | Sentry on the app and the API, on the Education plan | HB §11.5 |
| P0-9 | **Development build replaces Expo Go.** App name, URL scheme, bundle ID and Android package in `app.json`, `expo-dev-client`, first `expo run:android` on every machine and `expo run:ios` on the Mac, `eas init` | HB §10, HB §13.1 |

---

# Phase 1 — walking skeleton

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-01 | Auth: signup, login, password reset, session, forced logout | §4.1, §2.1.1, D-63, arch §1, D-73, arch:subject, arch:profile, HB §5.3 | C | P0-4, P0-6, P0-9 |
| S-02 | Event create wizard and Events list (Active/Upcoming/Past) | §4.3, §2.1.2 Phase B, spec §4.17, D-88, arch:event, arch:venue, arch:sub_event | B | S-01 |
| S-03 | Guest Link join: both invite rows created with the event, the `momentlens://invite` link, token resolve, Join Confirmation, approval modes | §2.3.1 Phase A, §2.4, §4.4, arch §1, spec §4.17, arch:invite, arch:membership, D-101, D-102 | U | S-02 |

**S-01 writes the first feature migration, and D-63 says what has to be in it.** The `subject` table with its nullable foreign key to the auth user is created there, not later. It is a column definition today and a migration against live rows once anyone has signed up. The row itself is created lazily, when the user adds a first reference or profile photo (arch:subject), so onboarding never needs one. S-01 also writes the one function that presigns `profile.avatar_key`, which returns no URL for a user whose subject has Do Not Publish active (D-35); every later endpoint that returns a person calls it. Its dependencies are P0-4, which closed only once P0-1 to P0-3 worked end to end, the tokens (P0-6) and the development build (P0-9). P0-5's rerun (issue #7) blocks S-18, not this.

**S-02 writes the `event`, `venue` and `sub_event` migrations**, because the wizard creates all three (spec §2.1.2). The event has no dates of its own; its span comes from its sub-events (D-88). S-04 adds editing, status and Delay on top.

---

# Phase 2 — event structure

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-04 | Sub-events CRUD, Schedule screen, **status computation**, the Admin's Delay action | §4.3, §4.6, §2.5.5, §4.10, spec §4.17, arch:sub_event | U | S-02, S-08 |
| S-05 | Invite links and shortcodes, both roles, revoke and regenerate | §4.4, §2.1.3 Phase C | C | S-03 |
| S-06 | Attendees: search, filter, role change, block, remove | §4.4, §2.5.7 Manage, D-35, D-102 | B | S-05 |
| S-07 | Pending Approvals queue, per-row and bulk actions | §4.4, §2.5.7 Manage, D-35, spec §4.17, arch:membership | B | S-06 |
| S-07a | Manage hub screen and the Event Settings edit form, without its Danger Zone | §2.5.7 Manage, §4.3, spec §4.17 | B | S-02, S-08 |
| S-08 | Two-tier navigation shell, role-based tab sets, persistent header | §2.5.1, §2.2, §4.10, HB §16.5, HB §4 | C | S-03 |

**S-04 carries a trap.** A sub-event is In Progress from its start to its end (D-88), but two can overlap, when capture tags to the most recently started, and there can be gaps inside the event when none is In Progress and the FAB hides. The event's own span is computed from its sub-events, so it needs at least one. This is the slice most worth unit-testing. Deleting and editing follow D-100: delete only a sub-event with no photos and never the last one, and an edit moves nothing. Other phones see a Delay on their next fetch of the event, so there is no Realtime to build. The status function lives in `packages/shared-types`, one pure function the capture button and the API's scan-time check both call, with its unit tests in `apps/api`'s Jest suite.

**S-08 is infrastructure everyone builds on.** Do it early and do not let it drift.

**The Photographer role is six restrictions spread across six slices, not a slice of its own.** §4.10, which lists all six, is cited on every row that carries one; §2.2, the narrative, is on S-08 only: S-08 (which tabs the role gets), S-13 (they see only their own uploads), S-04 (Schedule read-only, no Delay), S-15 (exempt from the verification gate), S-23 (Recognized Faces strip suppressed on their own photos), S-28 (no download button). Read §4.10 before building any of them. Every rule in it is something the role must *not* see, and an omission throws nothing and fails no test written from the Admin's or a Guest's perspective.

---

# Phase 3 — capture and upload

Build this phase **with the verification check disabled** in the pre-flight endpoint (HB §14.3 Phase 3). Phase 4 adds the gate.

S-18a is the one worker slice in this phase. Only the worker sets `processed_at`, so S-18a is what lets S-13 show any photo without someone setting it in Express (D-72).

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-09 | Viewfinder: native aspect, Public/Local Only toggle, Public captures saved to the gallery, session strip, FAB visibility rule | §4.7, §2.5.4, D-21, D-20, D-90 | B | S-04, S-08, S-10 |
| S-10 | My Media: sectioned by sub-event, SQLite queue, status badges, "+ Add Media" | §2.5.3, HB §4, spec §5.2, spec §5.4 | C | S-04, S-08 |
| S-11 | Client upload pipeline: EXIF strip, HEIC, 4096px guard, thumbnail, SHA-256, and the **upload loop**: pre-flight, both PUTs, completion, and the queue state each answer leads to | §4.8.1 Stage 1, §4.8.2, §4.8.3, D-58, D-69, D-32, D-53, D-97, arch §4, HB §5.3, spec §5.4 | C | S-10, S-12 |
| S-12 | Pre-flight endpoint with every check and the resume path, dedup lookup, upload key function, presigned R2 URLs for photo and thumbnail, idempotent completion, pgmq enqueue | §4.8.2 and §4.8.3, D-70, D-82, spec §4.11.1, arch §3, arch §4, spec §4.17, spec §5.4, D-73, arch:venue_verification, arch:media, D-95, D-96, D-98, HB §5.3 | U | S-03, S-04 |
| S-18a | Worker skeleton: pgmq consumer loop, `/health`, `thumbnail_dims` job, and the worker CI job (Ruff, pytest). No ML | HB §6, D-72, D-103, arch §5 | U | S-12 |
| S-13 | Home/Album: grid, sub-event chips, the filter sheet with its Uploader half, Realtime, and the **image-serving endpoint** with the public file only | §4.9, §2.5.2, §4.10, §4.13, D-22, D-35, D-55, D-57, D-60, D-86, D-93, HB §4, HB §16, HB §5.2, HB §11.3, arch §1, arch §3 | B | S-12, S-18a |
| S-14 | Background upload behavior: iOS background task, Android foreground service | §4.8.3 Stage 3 | C | S-11 |

**S-11 is one pipeline with no role branch** (D-58, HB §7). Its thumbnail is made from the unblurred photo, so it goes to R2 by presigned PUT and never into the pre-flight JSON (D-69). S-11 also owns the loop that calls S-12's endpoints and moves each queued item by the table in arch §4 (D-97). That loop is the upload queue's state machine, so a human reads it before it merges.

**S-10's queue belongs to an account.** Each queued item uploads only under the session of the account that queued it, and My Media shows each account only its own (apps/mobile/CLAUDE.md). The team hands phones around at the demo.

**S-14 uploads in the background only under the account that queued the item**, the same rule as S-10's queue.

**S-12 builds upload keys and nothing else.** Derived keys belong to the worker (D-70). It writes the `media` migration and the `start_upload` and `complete_upload` SQL functions (D-95), and adds `@aws-sdk/s3-request-presigner`, the dependency the team approved for it. It depends on S-03 and S-04 for membership and sub-events, not on S-11, which calls it. Its album-open check ships switched off, because nothing can open an album until S-31, and the resume path is the one to test hardest: a photo killed between pre-flight and completion must upload on relaunch, not vanish as its own duplicate (D-82).

**S-13 writes the `media` SELECT policy** that Realtime needs, the first one after `health_check`. It checks membership through a `security definer` function (arch §1, D-73). A human reads it before it merges.

**S-13 also builds the image-serving endpoint, without the subject's file** (D-93). It takes a batch of media ids, leaves out any the requester may not see under arch §1's media rule, presigns the public file or public thumbnail from its column, and returns the cache key (D-86). Write its negative test first (HB §11.3), and get it a human read: it is the serving check. S-21 adds the subject's own file and the own-variant flag to this endpoint; nothing else serves an image.

---

# Phase 4 — location verification

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-15 | On-device GPS check, server re-validation, queue gate, `venue_verification`, and switching on pre-flight's verification check | §4.5, §4.14, §4.10, D-14, D-36, D-89, arch:venue_verification | U | S-12 |
| S-16 | Venue QR: one per **venue**, shared by the sub-events at it, print view, Scan tab, **offline scan record** with its scan time | §4.5, §4.14, §2.5.1, D-17, D-85, arch:venue, arch:venue_verification | C | S-15 |
| S-17 | Force Verify (`admin_verified_at`), queue banner, "Ask the organizer to verify you" | §4.5, §2.5.3, arch:venue_verification | B | S-15, S-06 |

**S-15 is the security-sensitive one.** The client gates optimistically, the server is the authority, and nobody trusts a client-supplied `verified: true` (D-16). Photos carry no location: the device keeps one reading per sub-event when its check passes and sends it with the next pre-flight (D-89). The event response also carries the user's server-side verification state, so a Force Verify or a verification on another device unlocks this device's queue (spec §4.5).

---

# Phase 5 — the AI worker and face blur

The heaviest phase. Ukasha owns most of it because the worker is his, so hand him nothing from Phase 6 until this lands.

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-18 | InsightFace model resident at startup, job dispatch for `face_process` and `reprocess` | HB §6, HB §14.5 Phase 5, D-40, arch §5 | U | S-18a, P0-5 |
| S-19 | **Blur regions**: drawing a rectangle on a photo (Guests and the Admin), the endpoints and `manual_blur_region`, removal by the drawer or the Admin. Build this before S-20 | §4.11.4.4, D-83, HB §14.5, arch:manual_blur_region | B | S-13 |
| S-19a | `blur_region` job: regenerate a photo's files and thumbnails with every stored blur region, at new versioned keys | §4.11.4.4, D-83, D-60, D-69, arch §5, arch:manual_blur_region | U | S-18a, S-19 |
| S-20 | Face detection, embeddings, matches stored on `face` rows, reference photo upload (up to 5, one face each, rejected otherwise), `reference_process` job | §4.11.2, §4.11.3, §4.2, D-74, D-29, D-91, arch §5, arch §6, arch:face_reference, arch:face | U | S-18 |
| S-21 | Blur pipeline: public file and one variant per DNP subject (N+1), their blurred thumbnails, every stored blur region applied, versioned keys on the rows, the subject's file and own-variant flag added to S-13's **image-serving endpoint**, retire `thumbnail_dims` | §4.11.4.1, §4.11.4.2, §4.11.4.3, §4.13, D-57, D-60, D-69, D-72, D-83, D-86, D-27, D-30, arch §1, arch §3, arch §5, arch §6, arch:subject, arch:dnp_subject, D-93 | U | S-13, S-19a, S-20 |
| S-22 | Single photo view: pager, metadata overlay, **self-visible marker**, pinch-zoom, the action bar with Flag, Blur a region (opening S-19's screen), Delete and the Admin's Remove | §2.5.6, §4.11.4.2, §4.21, D-77, D-60, HB §4, arch:photo_flag | B | S-21 |
| S-23 | Find My Photos, the People half of the filter sheet, and the Recognized Faces strip, from stored matches, **viewer-scoped filter** | §4.11.3, §4.11.4.2, §2.5.2, §4.10, D-74, D-29, D-35 | C | S-20, S-13 |
| S-24 | Review Queue: blur regions (Keep / Remove), flagged photos (Keep / Remove), removed photos (Restore) | §2.5.7, §4.11.4.4, §4.21, D-83, D-24, arch:manual_blur_region, arch:photo_flag | U | S-19a, S-22 |
| S-25 | `reprocess` job: retroactive DNP, reference changes, late joiners, blur regions kept, **thumbnails included** | §4.11.4.5, D-69, D-27, D-66, D-83, D-84, arch §3, arch §5 | U | S-21 |
| S-26 | **Threshold calibration.** Not code. Measure on 30 real photos, write into ARCHITECTURE.md | HB §11.4, arch §6 | U | S-20 |

**S-19 first, before the ML work.** No ML, and it is the escape hatch when automatic matching misses something live (HB §14.5). S-19 is the screen, the endpoints and the table; S-19a, Ukasha's, is the worker job, so worker code stays with the worker owner. Before S-21 there are no subject files, so S-19a regenerates the public file and thumbnail only; S-21 and S-25 then apply every stored region to the files they write (root invariant 6). The rectangle is stored as fractions of the upright stored image, the frame the worker's face boxes use (D-99). Its real entry point is S-22's action bar; until S-22 lands, reach the drawing screen through a development-only route, and S-22 deletes that route.

**S-21 is the riskiest slice in the project.** It adds the subject branch to S-13's image-serving endpoint, the most sensitive authorization check in the system (HB §5.2, D-93). Write its negative test before the endpoint (HB §11.3). The same PR removes the `thumbnail_dims` enqueue, because left in place it publishes unblurred photos (D-72). When it merges, wipe the dev project's photos and reseed them through the real pipeline: photos `thumbnail_dims` processed have no `face` rows, so `reprocess` can never blur them (root invariant 10). Until S-26 records thresholds, the worker blurs every face and matches nobody (D-104).

**S-22's marker is a correctness requirement, not polish** (D-26). Without it a missed match is undetectable by the only person who could report it.

**S-23 fails silently if built wrong.** A global exclusion passes every test written from another viewer's perspective and returns nothing for the subject (D-46). Write the positive test: a DNP user runs Find My Photos and gets their photos.

**S-25 looks skippable and is not.** Three things break at once without it (HB §14.5 Phase 5). It regenerates thumbnails as well as full files; forgetting them throws nothing and shows the face in the grid only (D-69). It adds the enqueue to S-03's and S-07's join paths, so a Do Not Publish user who joins late is blurred in the photos already there (D-84). And it applies every stored blur region to what it regenerates, or a region someone drew disappears on the next run (root invariant 6).

**S-24's Remove on a blur region** deletes the row and enqueues `blur_region`, which rebuilds the photo without it. Restoring a removed photo clears `deleted_at` and nothing else, because its files never changed.

---

# Phase 6 — the rest

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-27 | Push notifications, two channels only, deep links | §4.16, §2.5.10, arch:push_token, arch:profile | C | S-07, S-31 |
| S-28 | Download and Share: multi-select, save to gallery, the share sheet, through the image-serving endpoint with no separate path (D-57) | §4.15, §4.13, §4.10, §2.5.6 | C | S-21, S-22 |
| S-29 | Settings, theme, and the **Do Not Publish activation flow**. Reference photo management is S-20's | §4.19, §2.5.9, D-35, D-56, D-87 | B | S-01, S-20, S-25 |
| S-30 | Local Only mode: app-sandbox storage, no gallery sync, viewer in My Media | §4.12, D-34 | C | S-09 |
| S-31 | The §2.5.8 screens no earlier slice builds (Access Removed, Consent re-gate, Supabase unavailable), consent screens, the Manage live status card, the album open/close **toggle** with its confirm dialog and the Realtime event that flips the banner, and switching on pre-flight's album-open check | §2.5.8, §4.18, §4.9, §2.5.2, §2.1.4 Phase D, arch §1, D-82, arch:event, arch:consent | B | S-08, S-13, S-12 |
| S-31a | Delete and archive event from Event Settings' Danger Zone, with the Album Lifecycle push each sends | §4.3, §4.21, §4.16, §2.5.7 | C | S-27, S-07a |

**S-31 writes the `event` SELECT policy** for the Realtime event that flips the album banner, the same way S-13 wrote the one on `media` (arch §1). A human reads it before it merges.

**S-29's DNP flow is the most sensitive UX in the app** (D-31, HB §15). Not a toggle. Get it right in this slice rather than polishing it later. "Upload over Mobile Data" and the default Viewfinder mode live on the phone in MMKV; the push toggles are `profile.notify_approval` and `profile.notify_album`, which S-27's sender checks.

---

# Phase 7 — nobody owns slices

Testing pass, performance pass, seeded demo dataset, standby rehearsal (D-79), demo script (spec §9) rehearsal on real devices in the actual room. Four weeks, defended (HB §14). The demo stack goes up on the server at the start of it (D-76, D-78). The seed goes through the real upload path so `face_process` blurs it; a script that inserts rows with `processed_at` set publishes unblurred photos (root invariant 1).

---

# Spec coverage

Every numbered section of `docs/Idea.md` is either cited by a slice above, listed below, or listed under "Not in any slice yet". `pnpm docs:check` fails when one is none of those, so a spec section cannot exist without someone having decided who builds it. A section nothing points at is behaviour nobody is assigned, and an agent asked to build near it invents it.

**Read, not built.** Narrative and reference. Real, but not units of work.

| Section | Why no slice owns it |
|---|---|
| spec §0 | What changed in v11. A changelog. |
| spec §1 | User roles overview. Context for every slice, built by none. |
| spec §3 | Event lifecycle end to end. The narrative the phases implement. |
| spec §2.1.5 | Admin journey, post-event. Narrative over slices that already exist. |
| spec §2.3.2 | Guest journey, pre-event. Same. |
| spec §2.3.3 | Guest journey, event day. Same. |
| spec §2.3.4 | Guest journey, post-event. Same. |
| spec §8 | Known limitations. For the report, not the build. |

**Deferred on purpose.** spec §6.1 is permanently out of scope, spec §6.2 is post-FYP, and spec §7 is stretch goals. The spec is locked; new features go to spec §6.2 (D-44).

**Built from the handbook instead.** spec §4.20 is deployment and hosting, now a summary. The P0 rows build it from HB §13 and `docs/ARCHITECTURE.md` §7, which carry the detail.

**Decisions and `docs/ARCHITECTURE.md`** get the same audit by hand when a phase starts, not in the gate, because the log is appended to constantly and a gate there would fire on every new entry. A decision or an architecture section no slice reaches is a rule nobody will be shown. The ones that reach no brief on purpose are cut scope, deferred work, superseded entries, and the four Photographer rules, whose content spec §4.10 restates for the six slices that cite it.

**The one to watch.** spec §5, edge cases and exception handling, belongs to a dozen slices, so it is not one unit of work. It is split by area, spec §5.1 to §5.6, so a slice cites the part it builds: S-10 cites §5.2 and §5.4, and S-12 cites §5.4. S-04 does not cite §5.3: its two rows, a sub-event running late and two overlapping, are in spec §4.3, which it cites. That is not full coverage. **Read the spec §5 subsections for your area before building any error path, whatever your slice cites, and treat a row in them as a requirement.** Root `CLAUDE.md` routes to it.

---

# Not in any slice yet

The spec describes these and no slice above owns them. Fold each into a slice or give it its own before its phase starts.

- The retention job that permanently deletes media from R2 and rows from Postgres, and the visibility-window warning that depends on it (§4.21, §4.16). No demo beat uses either (D-44). If it gets built, `pg_cron` enqueues a daily pgmq message and the worker deletes (`docs/ARCHITECTURE.md` §5)

---

# The handoff template

In Claude Code, type `/slice S-XX` instead. Use the template below with any other agent tool; it points at the same skill file, so every developer's agent runs the same steps. Fill the blanks from `node scripts/doc.mjs slice S-XX`, which lists the sections to read. Nothing else.

```
Building slice S-XX: <name>, from MomentLens.

Run `node scripts/doc.mjs slice S-XX` and read what it prints, phase paragraph
first. If you cannot run commands, read only these sections, in this order:
What to build:    docs/Idea.md, sections <§X, §Y>
How to build it:  docs/EngineeringHandbook.md, sections <§X>
Rules:            CLAUDE.md, plus the CLAUDE.md of each package this touches
Contracts:        packages/shared-types. Do not duplicate a type.

Stack constraints that override your training data:
Expo SDK 57 (docs: https://docs.expo.dev/versions/v57.0.0/), RN 0.86, New
Architecture only. FlashList v2 (no estimatedItemSize, no MasonryFlashList).
TanStack Query for server state, Zustand for UI state only, expo-sqlite for
the upload queue. NativeWind v4 tokens, no hardcoded hex. No localStorage or
AsyncStorage anywhere. No Node APIs in the app.

Order of work: follow sections 1 to 5 of .claude/skills/slice/SKILL.md
exactly, the same stages the /slice command runs, each in a fresh session
that starts from the slice card in the issue (Handbook §18.8).
0. Check that the issue of every slice in "Depends on" is closed. If one is
   open, stop and say which.
1. Read the slice back: the seven items in section 2, every one required.
   Stop. I will either say go or fix the docs first. Then write the card.
2. Write the zod schema alone and open it as its own PR. Stop until I merge it.
3. Build one package per session in the order the card sets out, each
   negative test first.
4. Report every Definition of done item with its evidence.

The docs are a draft, not a contract. If two sections disagree or one cannot
work, say so instead of picking one. The numbered invariants in CLAUDE.md and
the decision log are decisions rather than descriptions: raise those, do not
route around them.

Done means: every item of the Definition of done in docs/WorkSlices.md, each
reported as met or not met with its evidence.

[paste the Figma frame here]
```

**Why the two stops.** You catch a wrong approach in twenty seconds of reading instead of after reviewing 300 lines, and you learn the reasoning, which is what you need in June 2027 when an examiner points at a function (HB §18).

**Why the Figma frame goes last.** An image at the top of a session dominates everything after it, and the agent designs from the picture and backfills the logic. Constraints first, picture last.

---

# How to load a slice, and what it costs

**Use `node scripts/doc.mjs slice <id>`.** `doc toc slices` lists every slice with what its brief costs, so you can see the price before you pay it.

Measured over all 41 slices with `cl100k_base`, counting the tool-call framing as well as the text: a Bash call costs 90 to 112 tokens of envelope before any output (D-80). The briefs have changed since, and no brief holds a menu now; `doc toc slices` prints what each one costs today.

| Loading all 41 slices | Tokens | Tool calls |
|---|---|---|
| `doc slice`, plus a second command for the 2 slices that get a menu | 91,000 | 43 |
| By hand, knowing every section number, one batched command per document | 89,000 | 105 |
| By hand, also fetching the phase paragraph and the dependency rows the brief carries | 118,000 | 146 |
| By hand, listing headings first, then reading each section | 180,000 | 313 |

**On tokens the command and expert hand retrieval are level, and slice by slice the command costs more on 35 of the 41.** Every brief carries a phase paragraph, a provenance line per section and the rows of the slices it depends on, and on a small slice that scaffolding is a large fraction. The command earns its place on three other things:

1. **Two and a half times fewer tool calls**, which is latency and failure surface.
2. **What hand retrieval drops without telling you**: the phase paragraph above the table, which overrides the spec sections below it on purpose; the warning paragraph under the table; and the refusal to expand a superseded decision.
3. **The hand baseline assumes you already know every section number.** The recipe someone actually falls back to costs 180,000 tokens and 313 calls, twice the command.

**The menu rule.** When `doc toc slices` marks a slice `+`, a section it cites is too large to print, so the brief lists the parts with their sizes and you read one. That is cheaper than printing the parent unless you need nearly all of it. If you find yourself fetching most of the parts, the citation in the table is too wide; narrow it there instead. That is what S-16 and S-17 got wrong and now get right.

---

# Things that will go wrong with this routine

**Three people will build the same component three times.** Date formatting, upload progress, avatar, empty state, section header. Agree in week one that shared components live in `apps/mobile/src/components/ui/` and that adding one is a five-line PR anyone can review in a minute. Cheaper than deduplicating in month six.

**Someone will be blocked and not say so.** The dependency column exists so this is visible. If a slice's dependency issue is still open, pick a different slice, do not build against an imagined interface.

**An agent will add something nobody asked for.** Small PRs are the defense. D-68 dropped the rule that someone must be able to explain every line, so PR size is what keeps a review meaningful. A slice that produces a 900-line PR was scoped too big; split it along feature boundaries and re-review (HB §18).

**Ukasha will become the bottleneck.** Ukasha owns the worker, the docs and most of Phase 5, including S-19a's `blur_region` job and S-25's `reprocess` job, and S-18a adds one more slice in Phase 3. Watch the board. S-28 was already moved to C to keep worker jobs on U; if two slices are waiting on him for more than a few days, reassign a non-worker slice, because a team moving at one person's speed is the failure mode this whole file exists to prevent.
