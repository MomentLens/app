# CLAUDE.md

MomentLens: event photography and media management for South Asian weddings. React Native client, Express API, Python AI worker, Supabase, Cloudflare R2. Final-year project, three students, demo June 2027.

**Read every session, so it holds only what is needed every session.** There is a `CLAUDE.md` in `apps/mobile/`, `apps/api/` and `worker/` with the rules for that surface. Everything else is behind a pointer, and pointers are meant to be followed before writing code in that area.

---

## Where the answers are

| Question | Read |
|---|---|
| What should this feature do? | `docs/Idea.md`, the numbered section for that feature |
| How do I build it here? | `docs/EngineeringHandbook.md` |
| Why is it this way, and what was rejected? | `docs/DecisionLog.md`, entry `D-nn` |
| Current schema, data access, R2 keys, jobs, thresholds, deploy layout | `docs/ARCHITECTURE.md`, the living source of truth, owned by Ukasha (D-75) |
| Which unit of work, who owns it, what it waits on | `docs/WorkSlices.md` |

| Working on | Read first |
|---|---|
| Upload pipeline | Spec §4.8 + Handbook §7 |
| Blur, face detection, Do Not Publish | Spec §4.11 + Handbook §6 |
| Serving or downloading an image or thumbnail | Spec §4.13 + Handbook §2 + D-69 |
| Album, grid, filters | Spec §4.9 + Handbook §16 |
| RLS or any permission check | `docs/ARCHITECTURE.md` §1 + D-73 + Handbook §5 |
| Navigation or screens | Spec §2.5 + Handbook §16.5 |
| Deployment | Handbook §13 |
| Any error path: failed upload, lost connectivity, revoked access, a missed face match | Spec §5 |

**Read sections, never whole docs, and address them by id.** The spec alone is 21K tokens.

| Want | Run |
|---|---|
| A section, a decision, a table | `node scripts/doc.mjs spec §4.11.4 D-57 arch §3` |
| Everything a slice needs | `node scripts/doc.mjs slice S-21` |
| A section too large to print, once the brief lists its parts | `node scripts/doc.mjs spec §4.11.4.2` |
| What breaks if a decision is reopened | `node scripts/doc.mjs why D-57` |
| Which sections mention a term | `node scripts/doc.mjs grep variant_version` |
| What is in a doc at all | `node scripts/doc.mjs toc spec` (or `hb`, `dlog`, `arch`, `slices`) |
| Every slice and what its brief costs | `node scripts/doc.mjs toc slices` |

Ids are `spec §4.11.4`, `hb §13.3`, `arch §3`, `D-57`, `S-21`. A bare `§7` is a section in
three of the five docs; the tool refuses it and names the three rather than guessing. Citing a
large parent gets its children as summaries with their token costs, so you take the one you
need; a slice brief does the same, so two slices need one follow-up command.

A slice brief opens with its phase's own instructions. Those apply to every slice in the phase
and override the spec sections printed below them.

Use the command. On tokens it is level with hand retrieval by someone who already knows
every section number, and more expensive on 35 of the 41 taken one at a time. It wins on the things a token count does not show: half the
tool calls, and it carries the phase paragraph, the warning paragraph and the superseded
flags that hand retrieval drops in silence. `docs/WorkSlices.md` has the measurement.

**Typing ids.** `§` is optional: `doc 4.11.4`, `doc hb:7` and `doc arch:3` work and need no
special character. `doc 7` alone is refused, because §7 is a section in three of the five docs.

**If the scripts are broken**, every section is numbered, so `grep -n '^#### 4.11.4' docs/Idea.md`
then `sed -n 'a,bp'` gets you there. Do not trust `grep -n '^#'` to list headings:
`docs/EngineeringHandbook.md:542` is a shell comment inside a fenced block that it reads as
one. On Windows that fallback needs Git Bash or WSL2; `grep` and `sed` are not in PowerShell.

Never `@`-import a doc into this file.

Spec sections are stable identifiers. Cite them (`spec §4.11`) rather than paraphrasing.

---

## Invariants

These fail **silently**. Wrong code here looks correct, throws nothing, and passes tests written from the wrong angle. Do not violate them, and say so if asked to.

1. **`processed_at` is written last**, after every variant is in R2. It is what makes a media row album-visible, and the album query filters on it. Write it early and an unblurred photo is published. (D-55)
2. **Every object key the worker writes carries `variant_version`**, bumped on every regeneration including the first. That includes blurred thumbnails. Image cache keys must include it. A stable key means clients keep serving the pre-blur image from disk cache after a retroactive blur. (D-60)
3. **The server decides which image file a requester gets.** Never derive "is this the subject" from client input. Never hand out a bucket URL. One endpoint: authorization check, then a presigned URL. (D-57)
4. **The Do Not Publish filter is a read-time predicate parameterized by the viewer**, never a write-time exclusion. The wrong version passes every test written from another viewer's perspective and returns nothing for the subject, who is the one person who needs it. (D-29, D-46)
5. **Media bytes never pass through Express.** No compositing, resizing, or format inspection in a route handler, under any deadline. That includes the thumbnail. (Handbook §7)
6. **The manual-blur abuse check compares against curated references only**, never auto-added ones. (D-54)
7. **The dedup hash is SHA-256 over the exact bytes being uploaded**, after EXIF strip and HEIC conversion. Not the thumbnail; WebP encoders differ across platforms so that hash is not reproducible. (D-53)
8. **Do Not Publish activation is blocked without at least one reference image.** No reference embedding means the flag protects nobody while the UI reads "Active." (D-56)
9. **No client-side resize**, except a guard for anything over 4096px on the longest edge. One pipeline for all roles, no role branch. (D-58)
10. **Reprocessing compares stored embeddings and never re-runs detection.** Every face already has one. (D-66)
11. **N Do Not Publish subjects means N+1 files and N+1 thumbnails, never 2^N.** No viewer needs two subjects unblurred at once. (D-57)
12. **Each family of R2 keys has exactly one builder.** The API builds upload keys (the original and the client thumbnail) in one function and writes them onto the media row at pre-flight. The worker builds every derived key and writes those. Neither builds the other's, and whatever serves a file reads the column. (D-70)
13. **The client thumbnail is unblurred.** It is served only for a photo with no Do Not Publish face. When the worker matches a subject it writes blurred thumbnails at new versioned keys, and `reprocess` regenerates thumbnails along with the full files. Nothing is overwritten in place. (D-69)
14. **RLS denies everything except `SELECT` on `media` and `event`, which Realtime needs.** The API uses the secret key and enforces every rule in its service layer, with a negative test per endpoint. Never add a policy to make a client query work; add an endpoint. A direct table query from the app returns empty rows, not an error. (D-73)

---

## Surfaces that get a human read before merging

Not a comprehension exercise. These four fail silently when they are wrong, so a person checks them and each is paired with a negative test. Everything else gets an ordinary review. (D-68)

- Any RLS policy
- The image-serving endpoint's authorization check
- The upload queue's state machine
- Auth and invite-token handling

---

## Stack

Pinned. Do not upgrade to fix a problem; fix the problem.

- **Mobile**: Expo SDK 57, RN 0.86, TypeScript, Expo Router, Zustand, TanStack Query, NativeWind v4, FlashList v2, Reanimated v4, `expo-sqlite`
- **API**: Express 5, TypeScript, zod, `@supabase/supabase-js`, `@aws-sdk/client-s3`
- **Worker**: Python 3.12, FastAPI (`/health` only; it is a pgmq consumer, not a web server), InsightFace via ONNX Runtime, OpenCV
- **Services**: Supabase (Postgres, Auth, Realtime, pgmq), Cloudflare R2
- **Tooling**: pnpm workspaces, ESLint + Prettier, Ruff, Jest (`jest-expo` preset in mobile only), pytest, Maestro

---

## Layout

```
apps/mobile/     Expo app        → see apps/mobile/CLAUDE.md
apps/api/        Express         → see apps/api/CLAUDE.md
worker/          Python worker   → see worker/CLAUDE.md
packages/shared-types/           zod schemas, the app↔API contract (TS only)
supabase/migrations/
e2e/             Maestro flows
docs/            spec, handbook, decision log, work slices, ARCHITECTURE.md
.claude/skills/  /slice, which starts a work slice
.env.example     every variable, no values, committed
```

`worker/` sits outside `apps/` because pnpm's workspace globs expect a `package.json` in everything they find.

---

## Commands

```bash
pnpm install
pnpm check:machine                # scripts/doctor.mjs: node, pnpm, python, java, Android SDK, Xcode vs the pins
pnpm --filter mobile android      # build and install the development build; `ios` on the Mac
pnpm --filter mobile start        # Metro, serving JS to the installed development build
pnpm --filter api dev
pnpm lint && pnpm typecheck && pnpm test
cd worker && .venv/bin/python -m app.main
```

Development and the demo run on one Netcup server set up by `scripts/provision.sh`. The demo stack, against the stable Supabase project, goes up on it one month before the demo. Until 2026-10-15 development runs on an interim server, and `docs/ARCHITECTURE.md` §7 says which. Handbook §13, D-76, D-78.

---

## Model traps in this stack

Training data is older than these. Check real docs before building on an API you have not personally used.

- **Expo SDK 57**: docs at https://docs.expo.dev/versions/v57.0.0/. Read the package page before using any Expo API.
- **FlashList v2**: no `estimatedItemSize` (removed), no `MasonryFlashList` (now a `masonry` prop), `FlashListRef<T>` for refs. New Architecture only.
- **RN 0.86**: New Architecture is mandatory. There is no legacy bridge.
- **No Node APIs in the app.** `crypto.createHash` does not exist in React Native; hash bytes with `expo-crypto`'s `digest()`.
- **NativeWind v4** uses `tailwind.config.js`. v5 is a release candidate with a different config model; ignore its docs.
- `expo-file-system` changed its API in SDK 54.
- No `AsyncStorage` patterns.
- **Never invent a similarity threshold.** The numbers in the spec are placeholders. Use `docs/ARCHITECTURE.md`, or say the measurement has not been done yet.

---

## How to work with this team

- **Correctness and efficiency come first.** Do not simplify for readability, do not drop error handling or an edge case to shorten a diff, and do not offer a "simpler version" as an alternative unless it is also correct. If something is genuinely complex, write it correctly and explain it in the response instead of flattening the code. (D-68)
- **Plan before code** on anything non-trivial. Describe the approach and what you would touch, then wait.
- **Push back.** If a request is a bad idea, contradicts an entry in the decision log, or is scope creep against a locked spec, say so before doing it. Do not agree by default, and do not invent a justification for something you were told to do. This applies to us as much as to you: we forget our own decisions.
- **The spec is locked.** New features go to spec §6.2 as designed-and-deferred, not into the build.
- If a decision here looks wrong, say which `D-nn` you think should be reopened and why. Do not quietly build the other thing.
- Slice work starts with `/slice S-XX`, and the first thing it produces is a read-back: what the slice builds, how, what it inherits from the slices it depends on and owes the ones that depend on it, every edge case, and **what the docs get wrong about it**. Nothing is written until that has been answered. The point is to find the gaps for one slice while it is cheap.
- **The docs are a draft, not a contract.** They are written by the same agents that read them, and every review of them has found something wrong. When two sections disagree, or one describes something that cannot work, say so and propose the wording. Do not bend the build to match a document, and do not invent a reading that makes a contradiction go away. The invariants below and the entries in `docs/DecisionLog.md` are different in kind: those are decisions, not descriptions, so raise them and let the team rule rather than quietly building the other thing.
- **`docs/ARCHITECTURE.md` belongs to Ukasha.** Change it only to record a decision Ukasha made or what merged code does, in the same PR. If code and that file disagree, stop and ask; never edit the file to match the code. Ask about anything undecided instead of guessing. (D-75)
- Conventional commits (`feat:`, `fix:`, `chore:`). Trunk-based, short-lived branches, one reviewer per PR. Small commits even when a lot was generated at once. Never put anyone's name in a collaboration list or include co-author trailers (`Co-authored-by:`) in commits. PR titles and descriptions carry no tool attribution either, such as a "Generated with Claude Code" line.
