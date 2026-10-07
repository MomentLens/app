---
name: Work slice
about: One slice from docs/WorkSlices.md. One issue, one stack of PRs.
title: "S-XX: <slice name>"
---

<!-- The one place a person reads this slice (D-149): the explanation, the card, then the readiness record. Each stage posts one decision-ledger entry as a comment. What the feature does lives in the spec; this issue cites it. -->

**Spec:** §
**Handbook:** §
**Decisions:** D-
**Depends on:**
**Owner:**

## Explanation

<!-- The read-back writes this as the plan; the done stage answers it again with the evidence. Plain words for someone who reads nothing else (hb §18.7). Name a file, function or column only where the reader needs it to act or to check a claim, with its path. -->

- **What enters the system, and what can a person see when it works?**
- **Which component decides each step, where is progress stored, and what passes work on?**
- **What happens on a refusal, an interruption, a retry and two people acting at once?**
- **Which safety rules apply, and which checks show they hold?**
- **What needs a person's decision, and what does the recommended option cost?**

## Slice card

<!-- Written by the agent after the read-back is answered, and changed only when a person changes a decision, which raises the revision.
     Every later stage loads this section and nothing else from the issue. Ids and paths only, never copied doc text. Under about 900 tokens. -->

<details>
<summary>Slice card for agents</summary>

**Revision:** 1, <date>
**Goal:** one sentence.
**Decided at the read-back:**
- <question> → <answer> (who, date). Doc fixes: #<pr>
**Builds against:** <schema names and paths in packages/shared-types, endpoints and columns from the Depends on slices>
**Produces:** <schemas, endpoints, tables and columns, jobs, R2 keys, screens that later slices read>
**Schema stage:** <yes, or no because every schema it uses exists>
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

</details>

## Readiness

<!-- One row per item of the Definition of done in docs/WorkSlices.md. The done stage fills the ready-for-review rows after its last edit and final verification; cleanup fills Human read and Review, and refuses to merge while a row is missing, not met or stale (scripts/readiness.mjs).
     Result: met, not met, n/a: <reason>, or exception: <link to Ukasha's decision in this issue>. Head: the commit it applies to. -->

| Item | Result | Head | Evidence | By |
|---|---|---|---|---|
| Schema | | | | |
| RLS | | | | |
| Negative tests | | | | |
| States | | | | |
| Device | | | | |
| Unit tests | | | | |
| Dark mode | | | | |
| Architecture | | | | |
| PR descriptions | | | | |
| Verification | | | | |
| Human read | | | | |
| Review | | | | |
