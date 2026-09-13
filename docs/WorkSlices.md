# MomentLens work slices
> The assignable unit of work. One slice = one GitHub issue = one branch = one PR.

## What this file is and is not

This file names units of work and points at the spec sections that define them. **It never describes what a feature does.** If you want to know what Pending Approvals should look like, read spec §2.5, not this. That rule is what stops this file going stale: nothing in here can contradict the spec, because nothing in here repeats the spec.

Create one GitHub issue per slice, titled with the slice ID and name, body containing only the spec references and the dependency list. The board (Backlog / In Progress / Review / Done) is per Handbook §12.

## Why a slice is not a screen

A screen is roughly 30% of a feature. "Pending Approvals" as a Figma frame gives you a list, rows, and two buttons. It does not tell you the zod schema, the Express route, the RLS policy deciding who can approve, the query hook and what it invalidates, the empty state, the error state, or what happens when two Admins approve the same person at once. An agent handed only the image invents all of that, plausibly, and differently for each of the three of you. Three date formatters, three upload-progress components, three incompatible ideas of what the approvals endpoint returns.

**A slice is all six layers of one feature:** schema, endpoint, RLS policy, query hook, screen, and the unglamorous states. Whoever owns the slice owns all six.

## The rule that makes parallel work possible

**The first PR of any slice is the zod schema alone, merged before anyone writes UI or handlers.**

Once the contract is in `packages/shared-types`, the person building the screen and the person building the endpoint work at the same time without blocking, because the types exist and can be mocked. This is your parallelization mechanism, and it is also what stops an agent inventing a field name, because the compiler already knows every field.

Corollary from the pre-Phase-0 setup: **an endpoint does not exist until its schema is in `shared-types`.**

## Definition of done

A slice is not done when the screen renders. It is done when all of these are true. Put this list in your GitHub issue template so it is checked, not remembered.

- [ ] zod schema merged in `packages/shared-types`
- [ ] RLS policy written, or explicitly noted as not applicable, and **read by a human** if it touches `media`, `dnp_crop`, `face_reference`, or `membership` (D-45)
- [ ] Loading, empty, and error states exist, not just the happy path (Handbook §15)
- [ ] Works on a physical device, not only a simulator, if it touches camera, GPS, or the queue (Handbook §10)
- [ ] Unit test for any pure logic in it (Handbook §11)
- [ ] Dark mode uses tokens, no hardcoded hex
- [ ] Reviewed by one other person, who can explain what it does (Handbook §12, D-45)
- [ ] `docs/ARCHITECTURE.md` updated if the slice added a table, a column, or a job type

## Ownership

**U** is Ukasha, **B** and **C** are the two teammates. Change the letters, keep the shape.

Two constraints drive this. Ukasha is on the M1, which is ARM64 like the Oracle instance, so the Python worker is his by default (Handbook §9 explains why debugging aarch64 wheels from a Windows x86 machine is a bad time). And he did the planning, owns the docs, and will otherwise become the person everyone waits on, so the album and capture surfaces deliberately go elsewhere.

Owner means *builds it*. Review ownership is separate: every PR needs one of the other two, per Handbook §12.

---

# Phase 0 — all three together, not divided

Nobody works alone here. The point is that all three machines and the deployed stack are proven before anyone owns anything.

| ID | Slice | Reference |
|---|---|---|
| P0-1 | Repo scaffold, pnpm workspace, TS strict, ESLint rules, Prettier, Husky | HB §3, §11 |
| P0-2 | Oracle instance, nginx, TLS, both systemd units running something trivial | HB §13 |
| P0-3 | Supabase dev + stable projects, keep-alive cron | HB §13 |
| P0-4 | `GET /health` through to one Expo screen, on a phone, against the deployed API | HB §14 Phase 0 |
| P0-5 | **InsightFace ARM spike.** Blocking. If this fails the worker plan changes | HB §14 Phase 0 |
| P0-6 | `CLAUDE.md`, naming convention, Figma tokens into `tailwind.config.js`, `docs/ARCHITECTURE.md` skeleton | HB §18 |

---

# Phase 1 — walking skeleton

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-01 | Auth: signup, login, password reset, session, forced logout | §4.1 | C | P0 |
| S-02 | Event create wizard and Events list (Active/Upcoming/Past) | §4.3, §2.1 Phase B | B | S-01 |
| S-03 | Guest Link join: token resolve, Join Confirmation, approval modes | §2.3 Phase A, §2.4, §4.4 | U | S-02 |

---

# Phase 2 — event structure

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-04 | Sub-events CRUD, Schedule screen, **status computation** | §4.3, §4.6 | U | S-02 |
| S-05 | Invite links and shortcodes, both roles, revoke and regenerate | §4.4, §2.1 Phase C | C | S-03 |
| S-06 | Attendees: search, filter, role change, block, remove | §4.4, §2.5 Manage | B | S-05 |
| S-07 | Pending Approvals queue, per-row and bulk actions | §4.4, §2.5 Manage | B | S-06 |
| S-08 | Two-tier navigation shell, role-based tab sets, persistent header | §2.5, HB §16.5 | C | S-03 |

**S-04 carries a trap.** The status rule depends on the *next* sub-event's start time, not the current one's end (D-19). It reads two rows, not one. This is the slice most worth unit-testing, and an agent will get it wrong from the name alone.

**S-08 is infrastructure everyone builds on.** Do it early and do not let it drift.

---

# Phase 3 — capture and upload

Build this phase **with the verification check disabled** in the pre-flight endpoint (HB §14 Phase 3). Phase 4 adds the gate.

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-09 | Viewfinder: native aspect, Public/Local Only toggle, session strip, FAB visibility rule | §4.7, §2.5 | B | S-08 |
| S-10 | My Media: sectioned by sub-event, SQLite queue, status badges, "+ Add Media" | §2.5 | C | S-04, S-08 |
| S-11 | Client upload pipeline: EXIF strip, HEIC, resize, thumbnail, SHA-256, **role branch** | §4.8 Stage 1 | C | S-10 |
| S-12 | Pre-flight endpoint, dedup lookup, presigned R2 URL, completion, pgmq enqueue | §4.8 Stage 2-3, HB §7 | U | S-11 |
| S-13 | Home/Album: grid, sub-event chips, People/Uploader filter, Realtime | §4.9, §2.5 | B | S-12 |
| S-14 | Background upload behavior: iOS background task, Android foreground service | §4.8 Stage 3 | C | S-12 |

**S-11 is one function with a role branch, not two copies** (HB §7 has the table). Unit-test the branch.

---

# Phase 4 — location verification

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-15 | On-device GPS check, server re-validation, queue gate, `VenueVerification` | §4.5, §4.14 | U | S-12 |
| S-16 | Venue QR: per-sub-event generation, print view, Scan tab, **offline scan record** | §4.5, §4.14, §2.5 | C | S-15 |
| S-17 | Force Verify (`admin_verified_at`), queue banner, "Ask the organizer to verify you" | §4.5, §2.5 | B | S-15, S-06 |

**S-15 is the security-sensitive one.** The client gates optimistically, the server is the authority, and nobody trusts a client-supplied `verified: true` (D-16). Say that in the handoff.

---

# Phase 5 — the AI worker and face blur

The heaviest phase. Ukasha owns most of it because of the ARM alignment, so hand him nothing from Phase 6 until this lands.

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-18 | Worker skeleton, pgmq consumer loop, `/health`, model resident at startup, `variant` job | HB §6, §14 Phase 5 | U | S-12, P0-5 |
| S-19 | **Manual blur box** (fallback rung 3). Build this before S-20 | HB §14 Phase 5 | B | S-13 |
| S-20 | Face detection, embedding, reference photo upload (up to 5) | §4.11, §4.2 | U | S-18 |
| S-21 | Blur pipeline: public blurred variant, per-face crops, `dnp_crop` RLS | §4.11 | U | S-20 |
| S-22 | Client overlay: crop layered on blurred image, **self-visible marker** | §4.11, §2.5 | B | S-21 |
| S-23 | Find My Photos and Recognized Faces strip, **viewer-scoped filter** | §4.11 | C | S-20 |
| S-24 | Manual correction: tap own face, threshold check, Review Queue Confirm/Revert | §4.11, §2.5 | C | S-22, S-23 |
| S-25 | `reprocess` job: retroactive DNP, cross-photo blur, revert | §4.11, HB §6 | U | S-21 |
| S-26 | **Threshold calibration.** Not code. Measure on 30 real photos, write into ARCHITECTURE.md | HB §11 | U | S-20 |

**S-19 first, before the ML work.** Half a day, cannot fail, and it is your escape hatch when automatic matching misses something live (HB §14).

**S-22's marker is a correctness requirement, not polish** (D-26). Without it a missed match is undetectable by the only person who could report it.

**S-23 fails silently if built wrong.** A global exclusion passes every test written from another viewer's perspective and returns nothing for the subject (D-46). Write the positive test: a DNP user runs Find My Photos and gets their photos.

**S-25 looks skippable and is not.** Three things break at once without it (HB §14 Phase 5).

---

# Phase 6 — the rest

| ID | Slice | Spec | Owner | Depends on |
|---|---|---|---|---|
| S-27 | Push notifications, two channels only, deep links | §4.16, §2.5 | C | S-07 |
| S-28 | Download: multi-select, save to gallery, **authenticated composite endpoint for DNP photos** | §4.15, §4.13 | U | S-21 |
| S-29 | Settings, theme, and the **Do Not Publish activation flow** | §4.19, §2.5 | B | S-01 |
| S-30 | Local Only mode: app-sandbox storage, no gallery sync, viewer in My Media | §4.12 | C | S-09 |
| S-31 | Formalized screens, consent screens, album open/close confirm dialog, hard-coded limits | §2.5, §4.18, §4.9, §4.17 | B | S-08 |

**S-29's DNP flow is the most sensitive UX in the app** (D-31, HB §15). Not a toggle. Get it right in this slice rather than polishing it later.

---

# Phase 7 — nobody owns slices

Testing pass, performance pass, seeded demo dataset, Azure fallback rehearsal, demo script rehearsal on real devices in the actual room. Four weeks, defended (HB §14).

---

# The handoff template

This is what a teammate pastes at the start of a session. Fill the four blanks. Nothing else.

```
Building slice S-XX: <name>, from MomentLens.

Read first, in this order:
- Idea_V10.md sections <§X, §Y>  — what to build
- Engineering_Handbook_V3.md sections <§X>  — how, and the stack constraints
- CLAUDE.md  — pinned versions and conventions
- packages/shared-types  — existing contracts, do not duplicate a type

Stack constraints that override your training data:
Expo SDK 56, RN 0.85, New Architecture only. FlashList v2 (no
estimatedItemSize, no MasonryFlashList). TanStack Query for server state,
Zustand for UI state only, expo-sqlite for the upload queue. NativeWind
tokens, no hardcoded hex. No localStorage or AsyncStorage anywhere.

Order of work:
1. Propose the zod schema for this slice. Stop. I will review and merge it
   before you write anything else.
2. Then describe how you'd structure the rest and what files you'd touch.
   Stop. I will read the plan.
3. Then build it.

Done means: schema merged, RLS policy written or explicitly N/A, loading +
empty + error states, unit test for any pure logic, dark mode via tokens.

[paste the Figma frame here]
```

**Why the two stops.** You catch a wrong approach in twenty seconds of reading instead of after reviewing 300 lines, and you learn the reasoning, which is what you need in June 2027 when an examiner points at a function (HB §18, D-45).

**Why the Figma frame goes last.** An image at the top of a session dominates everything after it, and the agent designs from the picture and backfills the logic. Constraints first, picture last.

---

# Things that will go wrong with this routine

**Three people will build the same component three times.** Date formatting, upload progress, avatar, empty state, section header. Agree in week one that shared components live in `apps/mobile/components/ui/` and that adding one is a five-line PR anyone can review in a minute. Cheaper than deduplicating in month six.

**Someone will be blocked and not say so.** The dependency column exists so this is visible. If a slice's dependency is not merged, pick a different slice, do not build against an imagined interface.

**An agent will add something nobody asked for.** This is what D-45 exists for. Small PRs, and nothing merges if none of you can explain it. A slice that produces a 900-line PR is a slice that was scoped too big; split it and re-review.

**Ukasha will become the bottleneck.** He owns the worker, the docs, and most of Phase 5. Watch the board. If two slices are waiting on him for more than a few days, move S-25 or S-28 to someone else even though it is slower for them, because a team moving at one person's speed is the failure mode this whole file exists to prevent.
