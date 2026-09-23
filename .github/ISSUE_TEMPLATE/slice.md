---
name: Work slice
about: One slice from docs/WorkSlices.md. One issue, one branch, one PR.
title: "S-XX: <slice name>"
---

<!-- References only. What the feature does lives in the spec, never in this issue (docs/WorkSlices.md). -->

**Spec:** §
**Handbook:** §
**Decisions:** D-
**Depends on:**
**Owner:**

## Read-back, before any code

<!-- Paste the agent's read-back here, or write your own, before work starts. -->

- **What this slice is:**
- **How it gets built, and which files:**
- **What it inherits from its dependencies, and what later slices read from it:**
- **Edge cases by category (roles, Do Not Publish viewer, offline and crashes, concurrency, limits, time, Realtime), each with what the docs say or "the docs do not say":**
- **What the docs got wrong, with the two section ids that disagree, and what was checked and found consistent:**
- **Invariants and human-read surfaces touched, each with the negative test that covers it:**
- **Decisions needed from the team, each with a recommendation:**

The docs are a draft, not a contract. Fix what this list turned up, here and in the slices
this one depends on, before starting. If it turned up nothing, look again.

## Slice card

<!-- Written by the agent after the read-back is answered, and edited only when a person changes a decision.
     Every later stage (/slice S-XX schema, build, done) loads this and nothing else from the read-back.
     Ids and paths only, never copied doc text. Under about 900 tokens. -->

**Goal:** one sentence.
**Decided at the read-back:**
- <question> → <answer> (who, date). Doc fixes: #<pr>
**Builds against:** <schema names and paths in packages/shared-types, endpoints and columns from the Depends on slices>
**Produces:** <schemas, endpoints, tables and columns, jobs, R2 keys, screens that later slices read>
**Build order and files, one build session per package:**
1. `apps/api`: <paths>
2. `apps/mobile`: <paths>
**Negative tests:**
- <endpoint>: another user, another event, wrong role; Do Not Publish subject vs another viewer where it returns faces or images
**Invariants touched:** <numbers> · **Human-read surfaces:** <names, or none> · **Physical phone needed:** <yes/no>
**Edge cases:**
- <case> → <rule id>
**Read only these ids while building:** <spec §…, arch §…, D-…>
**Open:** <anything still undecided. The build stops here until it is answered>

## Definition of done

- [ ] zod schema merged in `packages/shared-types` before any UI or handler
- [ ] RLS policy written, or noted here as not applicable. Only `media` and `event` have one (D-73)
- [ ] Human read before merge if this touches any RLS policy, the image-serving authorization check, the upload queue state machine, or auth and invite-token handling (D-68). If it touches none, say so here
- [ ] A negative test for each human-read surface touched, and a negative authorization test for every new endpoint: another user, another event, the wrong role (D-68, D-73)
- [ ] Loading, empty and error states, not only the happy path (Handbook §15)
- [ ] Tested on a physical device if it touches camera, GPS or the queue (Handbook §10)
- [ ] Unit test for any pure logic (Handbook §11.2)
- [ ] Dark mode through tokens, no hardcoded hex
- [ ] Reviewed by one of the other two (Handbook §12)
- [ ] `docs/ARCHITECTURE.md` updated in this PR if it added a table, column, R2 key or job, and Ukasha has reviewed that change (D-75)
