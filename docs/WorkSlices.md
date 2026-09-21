# MomentLens work slices
> The assignable unit of work. One slice = one GitHub issue = one branch = one PR.

## What this file is and is not

This file names units of work and points at the spec sections that define them. **It never describes what a feature does.** If you want to know what Pending Approvals should look like, read spec §2.5, not this. That rule is what stops this file going stale: nothing in here can contradict the spec, because nothing in here repeats the spec.

Create one GitHub issue per slice from the **Work slice** issue template, titled with the slice ID and name, body containing only the spec references and the dependency list. The board (Backlog / In Progress / Review / Done) is per Handbook §12.

## Why a slice is not a screen

A screen is roughly 30% of a feature. "Pending Approvals" as a Figma frame gives you a list, rows, and two buttons. It does not tell you the zod schema, the Express route, the service-layer rule deciding who can approve, the query hook and what it invalidates, the empty state, the error state, or what happens when two Admins approve the same person at once. An agent handed only the image invents all of that, plausibly, and differently for each of the three of you. Three date formatters, three upload-progress components, three incompatible ideas of what the approvals endpoint returns.

**A slice is all six layers of one feature:** schema, endpoint, the authorization rule, query hook, screen, and the unglamorous states. Whoever owns the slice owns all six.

## The rule that makes parallel work possible

**The first PR of any slice is the zod schema alone, merged before anyone writes UI or handlers.**

Once the contract is in `packages/shared-types`, the person building the screen and the person building the endpoint work at the same time without blocking, because the types exist and can be mocked. This is your parallelization mechanism, and it is also what stops an agent inventing a field name, because the compiler already knows every field.

Corollary from the pre-Phase-0 setup: **an endpoint does not exist until its schema is in `shared-types`.**

## Definition of done

A slice is not done when the screen renders. It is done when all of these are true. The same list is in `.github/ISSUE_TEMPLATE/slice.md`, so every slice issue carries it as checkboxes.

- [ ] zod schema merged in `packages/shared-types`
- [ ] RLS policy written, or noted as not applicable. Only `media` and `event` have one; everything else is enforced in the service layer (D-73)
- [ ] **Read by a human before merging** if the slice touches any RLS policy, the image-serving endpoint's authorization check, the upload queue's state machine, or auth and invite-token handling (D-68)
- [ ] A negative test for each of those surfaces, and a negative authorization test for every new endpoint: another user, another event, the wrong role (D-73)
- [ ] Loading, empty, and error states exist, not just the happy path (Handbook §15)
- [ ] Works on a physical device, not only a simulator, if it touches camera, GPS, or the queue (Handbook §10)
- [ ] Unit test for any pure logic in it (Handbook §11)
- [ ] Dark mode uses tokens, no hardcoded hex
- [ ] Reviewed by one other person (Handbook §12)
- [ ] `docs/ARCHITECTURE.md` updated in the same PR if the slice added a table, a column, an R2 key, or a job type, with Ukasha reviewing that change (D-75)

## Ownership

**U** is Ukasha, **B** and **C** are the two teammates. Change the letters, keep the shape.

Two constraints drive this. Ukasha is on the M1, the fastest machine the team has measured for face processing (D-78), so the Python worker is his by default. And he did the planning, owns the docs, and will otherwise become the person everyone waits on, so the album and capture surfaces deliberately go elsewhere.

Owner means *builds it*. Review ownership is separate: every PR needs one of the other two, per Handbook §12.

---

# Phase 0 — all three together, not divided

Nobody works alone here. The point is that all three machines and the deployed stack are proven before anyone owns anything.

| ID | Slice | Reference |
|---|---|---|
| P0-1 | Repo scaffold, pnpm workspace, TS strict, ESLint rules, Prettier, Husky | HB §3, HB §11 |
| P0-2 | Server provisioned by `scripts/provision.sh`, nginx, TLS, both systemd units running something trivial | HB §13.3.2, HB §13.3.3, HB §13.3.4, D-39 |
| P0-3 | Supabase dev + stable projects, keep-alive for both as a GitHub Actions scheduled workflow, R2 buckets `momentlens-dev` and `momentlens-stable` | HB §13, D-67 |
| P0-4 | `GET /health` through to one Expo screen, on a phone, against the deployed API | HB §14.0 Phase 0 |
| P0-5 | **InsightFace spike on the server.** Blocking. If this fails the worker plan changes. Passed on ARM64 on 2026-09-15; rerun it on the x86-64 server | HB §14.0 Phase 0 |
| P0-6 | Figma tokens into `apps/mobile/tailwind.config.js`. Naming convention is settled: singular snake_case tables (`docs/ARCHITECTURE.md` §2). `docs/ARCHITECTURE.md` is owned by Ukasha (D-75) | HB §15 |
| P0-7 | Moved out of Phase 0. The demo stack goes up on the server at the start of Phase 7 (D-76, D-78) | D-76, D-78 |
| P0-8 | Sentry free tier on the app and the API | HB §11 |
| P0-9 | **Development build replaces Expo Go.** App name, URL scheme, bundle ID and Android package in `app.json`, `expo-dev-client`, first `expo run:android` on every machine and `expo run:ios` on the Mac, `eas init` | HB §10, HB §13.1 |

---

# Phase 1 — walking skeleton

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-01 | Auth: signup, login, password reset, session, forced logout | §4.1, §2.1.1, D-63, arch §1, D-73, arch:subject, arch:profile | C | P0 |
| S-02 | Event create wizard and Events list (Active/Upcoming/Past) | §4.3, §2.1.2 Phase B, spec §4.17 | B | S-01 |
| S-03 | Guest Link join: token resolve, Join Confirmation, approval modes | §2.3.1 Phase A, §2.4, §4.4, arch §1, spec §4.17 | U | S-02 |

**S-01 writes the first migration, and D-63 says what has to be in it.** The `subject` row with its nullable foreign key to the auth user is created there, not later. It is a column definition today and a migration against live rows once anyone has signed up. Nothing in §4.1 mentions it, which is why the decision is cited on the row.

---

# Phase 2 — event structure

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-04 | Sub-events CRUD, Schedule screen, **status computation** | §4.3, §4.6, §2.5.5, §4.10, spec §5 | U | S-02 |
| S-05 | Invite links and shortcodes, both roles, revoke and regenerate | §4.4, §2.1.3 Phase C | C | S-03 |
| S-06 | Attendees: search, filter, role change, block, remove | §4.4, §2.5.7 Manage | B | S-05 |
| S-07 | Pending Approvals queue, per-row and bulk actions | §4.4, §2.5.7 Manage | B | S-06 |
| S-08 | Two-tier navigation shell, role-based tab sets, persistent header | §2.5.1, §2.2, §4.10, HB §16.5, HB §4 | C | S-03 |

**S-04 carries a trap.** The status rule depends on the *next* sub-event's start time, not the current one's end (D-19). It reads two rows, not one. This is the slice most worth unit-testing, and an agent will get it wrong from the name alone.

**S-08 is infrastructure everyone builds on.** Do it early and do not let it drift.

**The Photographer role is six restrictions spread across six slices, not a slice of its own.** §4.10, which lists all six, is cited on every row that carries one; §2.2, the narrative, is on S-08 only: S-08 (which tabs the role gets), S-13 (they see only their own uploads), S-04 (Schedule read-only, no Delay), S-15 (exempt from the verification gate), S-23 (Recognized Faces strip suppressed on their own photos), S-28 (no download button). Read §4.10 before building any of them. Every rule in it is something the role must *not* see, and an omission throws nothing and fails no test written from the Admin's or a Guest's perspective.

---

# Phase 3 — capture and upload

Build this phase **with the verification check disabled** in the pre-flight endpoint (HB §14.3 Phase 3). Phase 4 adds the gate.

S-18a is the one worker slice in this phase. Only the worker sets `processed_at`, so S-18a is what lets S-13 show any photo without someone setting it in Express (D-72).

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-09 | Viewfinder: native aspect, Public/Local Only toggle, session strip, FAB visibility rule | §4.7, §2.5.4, D-21, D-20 | B | S-08 |
| S-10 | My Media: sectioned by sub-event, SQLite queue, status badges, "+ Add Media" | §2.5.3, HB §4, spec §5 | C | S-04, S-08 |
| S-11 | Client upload pipeline: EXIF strip, HEIC, 4096px guard, thumbnail, SHA-256 | §4.8.1 Stage 1, D-58, D-69, D-32, D-53, arch §4 | C | S-10 |
| S-12 | Pre-flight endpoint, dedup lookup, upload key function, presigned R2 URLs for photo and thumbnail, completion, pgmq enqueue | §4.8.2 and §4.8.3, HB §7, D-70, spec §4.11.1, arch §3, arch §4, spec §4.17, spec §5, D-73, arch:venue_verification | U | S-11 |
| S-18a | Worker skeleton: pgmq consumer loop, `/health`, `thumbnail_dims` job. No ML | HB §6, D-72, arch §5 | U | S-12 |
| S-13 | Home/Album: grid, sub-event chips, People/Uploader filter, Realtime | §4.9, §2.5.2, §4.10, D-22, D-55, D-60, HB §4, HB §16 | B | S-12, S-18a |
| S-14 | Background upload behavior: iOS background task, Android foreground service | §4.8.3 Stage 3 | C | S-12 |

**S-11 is one pipeline with no role branch** (D-58, HB §7). Its thumbnail is made from the unblurred photo, so it goes to R2 by presigned PUT and never into the pre-flight JSON (D-69).

**S-12 builds upload keys and nothing else.** Derived keys belong to the worker (D-70).

---

# Phase 4 — location verification

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-15 | On-device GPS check, server re-validation, queue gate, `venue_verification` | §4.5, §4.14, §4.10, D-14, D-36, arch:venue_verification | U | S-12 |
| S-16 | Venue QR: one per **venue**, shared by the sub-events at it, print view, Scan tab, **offline scan record** | §4.5, §4.14, §2.5.1, D-17, arch:venue, arch:venue_verification | C | S-15 |
| S-17 | Force Verify (`admin_verified_at`), queue banner, "Ask the organizer to verify you" | §4.5, §2.5.3, arch:venue_verification | B | S-15, S-06 |

**S-15 is the security-sensitive one.** The client gates optimistically, the server is the authority, and nobody trusts a client-supplied `verified: true` (D-16). Say that in the handoff.

---

# Phase 5 — the AI worker and face blur

The heaviest phase. Ukasha owns most of it because the worker is his, so hand him nothing from Phase 6 until this lands.

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-18 | InsightFace model resident at startup, job dispatch for `face_process` and `reprocess` | HB §6, HB §14.5 Phase 5, D-40, arch §5 | U | S-18a, P0-5 |
| S-19 | **Manual blur box** (fallback rung 3). Build this before S-20 | HB §14.5 | B | S-13 |
| S-20 | Face detection, embeddings, matches stored on `face` rows, reference photo upload (up to 5), `reference_process` job | §4.11.2, §4.11.3, §4.2, D-74, D-29, arch §5, arch §6, arch:face_reference | U | S-18 |
| S-21 | Blur pipeline: public file and one variant per DNP subject (N+1), their blurred thumbnails, versioned keys on the rows, **image-serving endpoint**, retire `thumbnail_dims` | §4.11.4.1, §4.11.4.2, §4.11.4.3, §4.13, D-57, D-60, D-69, D-72, D-27, D-30, arch §3, arch §5, arch §6 | U | S-20 |
| S-22 | Single photo view: pager, metadata overlay, **self-visible marker**, pinch-zoom | §2.5.6, §4.11.4.2, D-77, D-60, HB §4 | B | S-21 |
| S-23 | Find My Photos and Recognized Faces strip from stored matches, **viewer-scoped filter** | §4.11.3, §4.11.4.2, §4.10, D-74, D-29 | C | S-20 |
| S-24 | Manual correction: tap own face, `manual_blur` job, Review Queue Confirm/Revert | §4.11.4.4, §2.5.7, D-74, D-24, D-25, D-47, D-52, arch §5, arch §6, arch:blur_request | C | S-22, S-23 |
| S-25 | `reprocess` job: retroactive DNP, cross-photo blur, revert, **thumbnails included** | §4.11.4.5, HB §6, D-69, D-27, D-66, arch §3, arch §5 | U | S-21 |
| S-26 | **Threshold calibration.** Not code. Measure on 30 real photos, write into ARCHITECTURE.md | HB §11, arch §6 | U | S-20 |

**S-19 first, before the ML work.** Half a day, cannot fail, and it is your escape hatch when automatic matching misses something live (HB §14.5).

**S-21 is the riskiest slice in the project.** It contains the image-serving endpoint, the most sensitive authorization check in the system (HB §5). Write its negative test before the endpoint (HB §11). The same PR removes the `thumbnail_dims` enqueue, because left in place it publishes unblurred photos (D-72).

**S-22's marker is a correctness requirement, not polish** (D-26). Without it a missed match is undetectable by the only person who could report it.

**S-23 fails silently if built wrong.** A global exclusion passes every test written from another viewer's perspective and returns nothing for the subject (D-46). Write the positive test: a DNP user runs Find My Photos and gets their photos.

**S-25 looks skippable and is not.** Three things break at once without it (HB §14.5 Phase 5). It regenerates thumbnails as well as full files. Forgetting them throws nothing and shows the face in the grid only (D-69).

**S-24's revert deletes the auto-added reference the request created.** Left in place, a fraudulent request keeps pulling the requester's matching toward someone else's face (D-54).

---

# Phase 6 — the rest

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-27 | Push notifications, two channels only, deep links | §4.16, §2.5.10 | C | S-07 |
| S-28 | Download: multi-select, save to gallery, through the image-serving endpoint with no separate path (D-57) | §4.15, §4.13, §4.10 | U | S-21 |
| S-29 | Settings, theme, and the **Do Not Publish activation flow** | §4.19, §2.5.9, D-35, D-56 | B | S-01 |
| S-30 | Local Only mode: app-sandbox storage, no gallery sync, viewer in My Media | §4.12, D-34 | C | S-09 |
| S-31 | Formalized screens, consent screens, the album open/close **toggle** with its confirm dialog and the Realtime event that flips the banner, hard-coded limits | §2.5.8, §4.18, §4.9, §4.17, §2.5.2, arch §1, D-33 | B | S-08, S-13 |

**S-29's DNP flow is the most sensitive UX in the app** (D-31, HB §15). Not a toggle. Get it right in this slice rather than polishing it later.

---

# Phase 7 — nobody owns slices

Testing pass, performance pass, seeded demo dataset, standby rehearsal (D-79), demo script rehearsal on real devices in the actual room. Four weeks, defended (HB §14). The demo stack goes up on the server at the start of it (D-76, D-78).

---

# Spec coverage

Every numbered section of `docs/Idea.md` is either cited by a slice above, listed below, or
listed under "Not in any slice yet". `pnpm docs:check` fails when one is none of those, so a
spec section cannot exist without someone having decided who builds it. A section nothing
points at is behaviour nobody is assigned, and an agent asked to build near it invents it.

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

**Deferred on purpose.** spec §6.1 is permanently out of scope, spec §6.2 is post-FYP, and
spec §7 is stretch goals. The spec is locked; new features go to spec §6.2 (D-44).

**Built from the handbook instead.** spec §4.20 is deployment and hosting. The P0 rows build
it from HB §13, D-76 and D-78, which are current where spec §4.20 is not.

**Decisions and `docs/ARCHITECTURE.md`.** The same audit was run over those and is not
gated, because the decision log is appended to constantly and a gate there would fire on
every new entry. Run it by hand when a phase starts: a decision or an architecture section
that no slice reaches is a rule nobody will be shown. Three findings from the first pass,
all now fixed in the table above. `docs/ARCHITECTURE.md` §3, the exact R2 key format for
every file, reached no brief at all, which is root invariant 12 unbuildable. §6, the
similarity thresholds, reached none either, while root `CLAUDE.md` says never to invent one.
And D-36, which says the GPS reading is validated and never written to a row, did not reach
S-15, the slice that builds the check; storing it would have made S-31's consent screen a
lie. Sixteen decisions still reach no brief and should stay that way: cut scope, deferred
work, superseded entries, and the four Photographer rules, whose content spec §4.10 restates
in full for the six slices that cite it.

**The one to watch.** spec §5, edge cases and exception handling, is about 1,100 tokens of
what the app does when an upload fails, connectivity drops, a join duplicates, access is
revoked or a face match misses. Its rows belong to a dozen different slices, so it is not
one unit of work and splitting it is a real decision nobody has made. It is now cited by
S-04, S-10 and S-12, the three slices with rows in it that an implementer would otherwise
get wrong: capture tags to the most recently started sub-event when two overlap, a photo
from a never-verified guest waits in the local queue with a clock badge rather than failing,
and an exact duplicate is rejected silently before any file transfer, with no prompt. That
is not full coverage. **Read spec §5 before building any error path, whatever your slice
cites, and treat a row in it as a requirement.** Root `CLAUDE.md` routes to it.

---

# Not in any slice yet

The spec describes these and no slice above owns them. Fold each into a slice or give it its own before its phase starts.

- The photo Flag action and the flagged-photos half of the Review Queue (spec §2.5, Single photo view and Manage)
- Photo soft delete by the uploader, and Admin remove and restore (§2.1.4 Phase D, §4.9, §4.21)
- Delete and archive event (§4.3, §4.21)
- The retention job that permanently deletes media from R2 and rows from Postgres (§4.21). No demo beat uses it (D-44). If it gets built, `pg_cron` enqueues a daily pgmq message and the worker deletes (`docs/ARCHITECTURE.md` §5)
- Delay a sub-event (spec §4.3). Probably S-04; confirm

---

# The handoff template

In Claude Code, type `/slice S-XX` instead. The skill in `.claude/skills/slice/` follows the same order and reads only the sections the slice cites. Use the template below with any other tool. Fill the blanks. Nothing else.

```
Building slice S-XX: <name>, from MomentLens.

Read only these sections, in this order:
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

Order of work:
1. Read the slice back to me first, before anything is written: what it is in
   one paragraph, how you would build it and which files that touches, what
   interface you are building against from the slices it depends on, every
   edge case you can find with "the docs do not say" where that is the honest
   answer, and everything the docs get wrong about it. Stop. I will either say
   go or fix the docs first.
2. Propose the zod schema for this slice. Stop. I will review and merge it
   before you write anything else.
3. Then build it, in the order your read-back set out.

The docs are a draft, not a contract. If two sections disagree or one cannot
work, say so instead of picking one. The numbered invariants in CLAUDE.md and
the decision log are decisions rather than descriptions: raise those, do not
route around them.

Done means: schema merged, RLS policy written or N/A (only `media` and `event`
have one, D-73), loading +
empty + error states, unit test for any pure logic, dark mode via tokens,
a negative authorization test for every endpoint.

[paste the Figma frame here]
```

**Why the two stops.** You catch a wrong approach in twenty seconds of reading instead of after reviewing 300 lines, and you learn the reasoning, which is what you need in June 2027 when an examiner points at a function (HB §18).

**Why the Figma frame goes last.** An image at the top of a session dominates everything after it, and the agent designs from the picture and backfills the logic. Constraints first, picture last.

---

# How to load a slice, and what it costs

**Use `node scripts/doc.mjs slice <id>`.** `doc toc slices` lists every slice with what its
brief costs, so you can see the price before you pay it.

Measured over all 41 slices with a real tokenizer, counting the tool-call framing as well as
the text. A Bash call costs 90 to 112 tokens of envelope and command before any output, so the
number of calls matters as much as the size of them.

| Loading all 41 slices | Tokens | Tool calls |
|---|---|---|
| `doc slice`, plus a second command for the 2 slices that get a menu | 91,000 | 43 |
| By hand, knowing every section number, one batched command per document | 89,000 | 105 |
| By hand, also fetching the phase paragraph and the dependency rows the brief carries | 118,000 | 146 |
| By hand, listing headings first, then reading each section | 180,000 | 313 |

**Read the second row honestly: on tokens the command and expert hand retrieval are level,
and slice by slice the command is the more expensive one on 35 of the 41.** Every brief
carries a phase paragraph, a `--- id · file:lines · ~N tok` line per section, the rows of the
slices it depends on, and a trailing list of ids one hop out. On a small slice that fixed
scaffolding is a large fraction. The briefs also grew as the coverage gaps closed, and that
growth is content somebody has to read either way.

So the case for the command is not the token count. It is:

1. **Two and a half times fewer tool calls**, which is latency and failure surface.
2. **Three things hand retrieval drops without telling you**: the phase paragraph above the
   table, which contradicts the spec sections below it on purpose; the warning paragraph
   written under the table; and the refusal to expand a decision that has been superseded.
3. **The hand baseline above assumes you already know every section number.** The recipe
   someone actually falls back to costs 180,000 and 313 calls, twice the command.

**The menu rule.** When `doc toc slices` marks a slice `+`, a section it cites is too large to
print, so the brief lists the parts with their sizes and you read one. That is cheaper than
printing the parent unless you need nearly all of it. If you find yourself fetching most of the
parts, the citation in the table is too wide; narrow it there instead. That is what S-16 and
S-17 got wrong and now get right.

---

# Things that will go wrong with this routine

**Three people will build the same component three times.** Date formatting, upload progress, avatar, empty state, section header. Agree in week one that shared components live in `apps/mobile/src/components/ui/` and that adding one is a five-line PR anyone can review in a minute. Cheaper than deduplicating in month six.

**Someone will be blocked and not say so.** The dependency column exists so this is visible. If a slice's dependency is not merged, pick a different slice, do not build against an imagined interface.

**An agent will add something nobody asked for.** Small PRs are the defense. D-68 dropped the rule that someone must be able to explain every line, so PR size is what keeps a review meaningful. A slice that produces a 900-line PR was scoped too big; split it along feature boundaries and re-review (HB §18).

**Ukasha will become the bottleneck.** He owns the worker, the docs, and most of Phase 5, and S-18a adds one more slice to his Phase 3. Watch the board. If two slices are waiting on him for more than a few days, move S-25 or S-28 to someone else even though it is slower for them, because a team moving at one person's speed is the failure mode this whole file exists to prevent.
