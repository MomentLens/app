# AGENTS.md

MomentLens: event photography and media management for South Asian weddings. React Native client, Express API, Python AI worker, Supabase, Cloudflare R2. Final-year project, three students, demo June 2027. Ukasha owns the docs, `docs/ARCHITECTURE.md` and the worker, and works on an M1 Mac. The two teammates, B and C in `docs/WorkSlices.md`, work on Windows through WSL2 (hb §9).

**Read every session, so it holds only what is needed every session.** There is an `AGENTS.md` in `apps/mobile/`, `apps/api/` and `worker/` with the rules for that surface. Everything else is behind a pointer, and pointers are meant to be followed before writing code in that area.

**This is the only instruction file, for every agent tool.** Claude Code 2.1.277 or later and Codex both load it, and the folder `AGENTS.md` files when work touches those folders. **Never create a `CLAUDE.md` or `CLAUDE.local.md` in this repo or in any folder above it.** Claude Code reads `AGENTS.md` only where no `CLAUDE.md` exists, so one stray file switches every rule here off without a warning. `pnpm docs:check` and `pnpm check:machine` both fail on one (D-116).

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
| Upload pipeline | Spec §4.8 + Handbook §7 + `docs/ARCHITECTURE.md` §4 |
| Blur, face detection, Do Not Publish | Spec §4.11 + Handbook §6 + `docs/ARCHITECTURE.md` §5 |
| Serving or downloading an image or thumbnail | Spec §4.13 + Handbook §5.2 + D-69 + D-86 + `docs/ARCHITECTURE.md` §1 and §3 |
| Album, grid, filters | Spec §4.9 + Handbook §16 |
| RLS or any permission check | `docs/ARCHITECTURE.md` §1 + D-73 + Handbook §5.1 |
| Navigation or screens | Spec §2.5 + Handbook §16.5 + D-112 + D-118 |
| Deployment | Handbook §13 + `docs/ARCHITECTURE.md` §7 |
| Pushing a migration, deploying the dev server, reading server logs | Handbook §13.4 |
| Merging a slice's stack of PRs | Handbook §12 |
| Any error path: failed upload, lost connectivity, revoked access, a missed face match | Spec §5 |
| Editing anything in `docs/` | Handbook §18.7 |
| Running a slice's stages and subagents | `.claude/skills/slice/SKILL.md` + Handbook §18.8 |

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

Ids are `spec §4.11.4`, `hb §13.3`, `arch §3`, `arch:venue`, `D-57`, `S-21`. `§` is optional: `doc 4.11.4`, `doc hb 7` and `doc arch:3` all work. A bare `§7` is a section in three of the five docs, so the tool refuses it and names the three rather than guessing. Citing a large parent gets its children as summaries with their token costs, so you take the one you need; `doc toc slices` marks with `+` any slice whose brief needs that second command.

A slice brief opens with its phase's own instructions. Those apply to every slice in the phase and override the spec sections printed below them.

Use the command rather than reading by hand. It carries the phase paragraph, the warning paragraph and the superseded flags that hand retrieval drops in silence.

If `scripts/doc.mjs` fails, section 1 of `.claude/skills/slice/SKILL.md` gives the grep fallback.

Never paste a doc into this file.

Spec sections are stable identifiers. Cite them (`spec §4.11`) rather than paraphrasing.

---

## Invariants

These fail **silently**. Wrong code here looks correct, throws nothing, and passes tests written from the wrong angle. Do not violate them, and say so if asked to.

1. **`processed_at` is written last**, after every variant is in R2. It is what makes a media row album-visible, and the album query filters on it. Write it early and an unblurred photo is published. (D-55)
2. **Every object key the worker writes carries `variant_version`**, bumped on every regeneration including the first. That includes blurred thumbnails. A media file's cache key must include it. The app caches under the key the serving endpoint returns, the signed object key plus `variant_version`. A stable key means clients keep serving the pre-blur image from disk cache after a retroactive blur. A cover or an avatar has no version, and its key carries its upload's id instead (arch §3). (D-60, D-86, D-118)
3. **The server decides which image file a requester gets.** Never derive "is this the subject" from client input. Never hand out a bucket URL. Media files have one endpoint: authorization check, then a presigned URL. A cover or an avatar is presigned by the endpoint that returns its event or profile, after that endpoint's check (arch §3). (D-57, D-110)
4. **The Do Not Publish filter is a read-time predicate parameterized by the viewer**, never a write-time exclusion. The wrong version passes every test written from another viewer's perspective and returns nothing for the subject, who is the one person who needs it. (D-29, D-46)
5. **Media bytes never pass through Express.** No compositing, resizing, or format inspection in a route handler, under any deadline. That includes the thumbnail. (Handbook §7)
6. **Every file the worker writes for a photo applies that photo's stored blur regions**, on every regeneration: `face_process`, `reprocess` and `blur_region` alike. A regeneration from the bare upload silently brings back a face somebody hid. (D-83)
7. **The dedup hash is SHA-256 over the exact bytes being uploaded**, after EXIF strip and HEIC conversion. Not the thumbnail; WebP encoders differ across platforms so that hash is not reproducible. (D-53)
8. **Do Not Publish activation is blocked without at least one accepted reference**, a reference photo for that event in which the worker found exactly one face, and the last one there cannot be deleted while Do Not Publish is on there. Both are per event: the flag on the membership, the references on `face_reference.event_id` (D-129, D-141). No reference embedding means the flag protects nobody while the UI reads "Active." (D-56, D-87, D-91)
9. **No client-side resize**, except a guard for anything over 4096px on the longest edge. One pipeline for all roles, no role branch. (D-58)
10. **Reprocessing compares stored embeddings and never re-runs detection.** Every face already has one. (D-66)
11. **N Do Not Publish subjects means N+1 files and N+1 thumbnails, never 2^N.** No viewer needs two subjects unblurred at once. (D-57)
12. **Each family of R2 keys has exactly one builder.** The API builds upload keys (the original and the client thumbnail) in one function and writes them onto the media row at pre-flight. The worker builds every derived key and writes those. Neither builds the other's, and whatever serves a file reads the column. (D-70)
13. **The client thumbnail is unblurred.** It is served only for a photo with no Do Not Publish face and no blur region. When the worker matches a subject it writes blurred thumbnails at new versioned keys, and `reprocess` regenerates thumbnails along with the full files. Nothing is overwritten in place. (D-69)
14. **RLS denies everything except `SELECT` on `media` and `event`, which Realtime needs.** The API uses the secret key and enforces every rule in its service layer, with a negative test per endpoint. Never add a policy to make a client query work; add an endpoint. A direct table query from the app returns empty rows, not an error. (D-73)

---

## Surfaces that get a human read before merging

Not a comprehension exercise. These four fail silently when they are wrong, so a person checks them and each is paired with a negative test. The code owners' review, which every PR into `main` from anyone else needs, covers them. On a code owner's own PR the code owner reads them, with `/code-review` and the negative test as the second check. Everything else gets an ordinary review. (D-68, D-117)

- Any RLS policy
- The image-serving endpoint's authorization check
- The upload queue's state machine
- Auth and invite-token handling

---

## Stack

Pinned. Do not upgrade to fix a problem; fix the problem. **Never add a dependency without naming it in the plan and getting a yes**, native or not, in any package: a native one costs every machine a rebuild, and any one is a version three people now share.

- **Mobile**: Expo SDK 57, RN 0.86, TypeScript, Expo Router, Zustand, TanStack Query, NativeWind v4, FlashList v2, Reanimated v4, `expo-sqlite`
- **API**: Express 5, TypeScript, zod, `@supabase/supabase-js`, `@aws-sdk/client-s3`
- **Worker**: Python 3.12, FastAPI (`/health` only; it is a pgmq consumer, not a web server), InsightFace via ONNX Runtime, OpenCV
- **Services**: Supabase (Postgres, Auth, Realtime, pgmq), Cloudflare R2
- **Tooling**: pnpm workspaces, ESLint + Prettier, Ruff, Jest (`jest-expo` preset in mobile only), pytest, Maestro

---

## Layout

```
apps/mobile/     Expo app        → see apps/mobile/AGENTS.md
apps/api/        Express         → see apps/api/AGENTS.md
worker/          Python worker   → see worker/AGENTS.md
packages/shared-types/           zod schemas, the app↔API contract, and the sub-event status function (TS only)
supabase/migrations/
e2e/             Maestro flows
docs/            spec, handbook, decision log, work slices, ARCHITECTURE.md
.claude/skills/  /slice, which runs a work slice; .agents/skills/slice links to the same file for Codex
.claude/agents/  slice-auditor and slice-verifier, the subagents /slice calls; .codex/agents holds Codex's copies
scripts/         doc.mjs (the docs by id), doctor.mjs (check:machine), provision.sh, deploy.sh
.env.example     every variable, no values, committed
```

`worker/` sits outside `apps/` because pnpm's workspace globs expect a `package.json` in everything they find.

---

## Commands

```bash
pnpm install                      # also installs the git hook that runs the docs gate
pnpm check:machine                # scripts/doctor.mjs: toolchain pins, git hook, .env keys, worker venv, Claude Code version
pnpm --filter mobile android      # build and install the development build; `ios` on the Mac
pnpm --filter mobile start        # Metro, serving JS to the installed development build
pnpm --filter api dev
pnpm lint && pnpm typecheck && pnpm test
pnpm docs:check                   # the docs gate, also run by the pre-commit hook and CI
pnpm --filter api test:rls        # RLS negative tests against the dev project
cd worker && uv venv --python 3.12 && uv pip install -r requirements-dev.txt   # once, and after either requirements file changes
cd worker && .venv/bin/ruff check . && .venv/bin/pytest
cd worker && .venv/bin/python -m app.main   # waits while the dev server's worker holds the queue (hb §13.4)
```

On Windows everything above runs inside WSL2, as Handbook §9 sets up.

**Shared infrastructure is Handbook §13.4**: a new migration, pushing it to the dev project, deploying the dev server, server logs. All three developers share the dev project and the dev server. Ask the developer before each of these, every time, even inside a task they already approved: `supabase db push`, any command over `ssh momentlens`, `gh pr merge`, and any force push. A migration that has reached the dev project is never edited again; a fix is a new migration (D-116).

---

## Model traps in this stack

Training data is older than this stack. Before using an API from an Expo package, FlashList, NativeWind or Reanimated, read its page in the docs for the pinned version. If you cannot reach the docs, say so; never write that API from memory. `apps/mobile/AGENTS.md` lists the mobile stack's traps.

**Never invent a similarity threshold.** The spec carries no threshold numbers. Use `docs/ARCHITECTURE.md` §6, or say the measurement has not been done yet.

---

## Working with the developer

The developer may be new to this codebase, to React Native and to git, and may write short or vague requests. Keep the build correct anyway, and leave them understanding what changed.

- **Plan before code**, then wait for a yes, whenever a change touches more than one file, a schema or migration, a dependency, a numbered invariant or a human-read surface. That is almost everything; a typo fix is not.
- **Restate a vague request before acting on it.** For "fix the join screen" or "make it work", say in two sentences what you think they want and which files you would touch, then wait. Never build the larger reading of a small request.
- **Recommend, don't survey.** Every question carries the option you recommend and what it costs. Ask only what the developer has to decide, a few at a time. Make routine calls yourself and list them at the end so one can be vetoed.
- **Lead with the answer.** The decision or the result first, the reason after, and only if it changes what they do. Plain words. When a React Native, Expo, Supabase or git idea comes up, explain it in a sentence rather than assuming they know it.
- **Correctness and efficiency come first.** Do not simplify for readability, do not drop error handling or an edge case to shorten a diff, and do not offer a "simpler version" as an alternative unless it is also correct. If something is genuinely complex, write it correctly and explain it in the response instead of flattening the code. (D-68)
- **Between two correct designs, build effort decides.** This is a demo, not a public launch. Take the more thorough design only when it costs about the same to build, and say what risk the cheaper one accepts. That rule decided D-73. The invariants above are never the price of the cheaper option.
- **Never answer your own question.** When the docs are silent, or two readings both look right, ask. A guess written into code is the silent bug these docs exist to stop. If the developer says "you pick", pick, say what you picked and why, and put it in the discussion log.
- **Push back.** If a request is a bad idea, contradicts an entry in the decision log, or is scope creep against a locked spec, say so before doing it, with the id. Do not agree by default, and do not invent a justification for something you were told to do. If the developer still wants it, stop and tell them to take it to Ukasha.
- **Report only what you checked.** "Tests pass" means you ran them in this session and read the output. Never call something done, fixed or working without that. When something fails, quote the failure.
- **Keep a discussion log for every session that works on a slice**, as `.claude/skills/slice/SKILL.md` describes, a code owner's own slice included (D-120). The code owners read it in the final PR to see what was asked, answered and decided.
- **End each stage by teaching it.** Three or four sentences on what you built and why, in words the developer could repeat in the viva (hb §18).

---

## How the team works

- **The spec is locked.** New features go to spec §6.2 as designed-and-deferred, not into the build.
- If a decision here looks wrong, say which `D-nn` you think should be reopened and why. Do not quietly build the other thing. This applies to us as much as to you: we forget our own decisions.
- Slice work starts with `/slice S-XX`, or in another agent tool with the handoff template at the end of `docs/WorkSlices.md`, and the first thing it produces is a read-back: what the slice builds, how, what it inherits from the slices it depends on and owes the ones that depend on it, every edge case, and **what the docs get wrong about it**. Nothing is written until that has been answered. The point is to find the gaps for one slice while it is cheap.
- **The docs are a draft, not a contract.** They are written by the same agents that read them, and every review of them has found something wrong. When two sections disagree, or one describes something that cannot work, say so and propose the wording. Do not bend the build to match a document, and do not invent a reading that makes a contradiction go away. The invariants above and the entries in `docs/DecisionLog.md` are different in kind: those are decisions, not descriptions, so raise them and let the team rule rather than quietly building the other thing.
- **`docs/ARCHITECTURE.md` belongs to Ukasha.** Change it only to record a decision Ukasha made or what merged code does, in the same PR. If code and that file disagree, stop and ask; never edit the file to match the code. Ask about anything undecided instead of guessing. (D-75)
- **Project facts go in `docs/`, never only in an agent's memory.** The other two developers' agents cannot see your memory, so a fact kept there makes their agent build something different from yours.
- **A slice ships as a stack of PRs**, one per stage, each branch cut from the one below: read-back doc fixes if there are any, then the schema, then one per package. No stage waits for a merge. GitHub requests the code owners' review on every PR from `.github/CODEOWNERS`, and `main` takes a PR only with a code-owner approval and a green CI run; a code owner's own stack needs green CI and `/code-review` instead. Stacks merge from the top down with Rebase and merge, keeping every commit (hb §12, D-116, D-117). The slice's issue closes when the bottom PR reaches `main`; that closed issue, not a merged PR, is what "the dependency is done" means.
- Conventional commits (`feat:`, `fix:`, `chore:`). A slice's PR titles start with its id (`S-12: schema`). Every PR description names which of the four human-read surfaces it touches, or says none. Trunk-based, short-lived branches. Small commits even when a lot was generated at once. Never put anyone's name in a collaboration list or include co-author trailers (`Co-authored-by:`) in commits. PR titles and descriptions carry no tool attribution either, such as a "Generated with Claude Code" line.
- **Everything you write for this repo follows Handbook §18.7's writing rules**: docs, the `AGENTS.md` files, commit messages, PR descriptions and issue comments.
