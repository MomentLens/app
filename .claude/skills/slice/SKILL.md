---
name: slice
description: Start a MomentLens work slice (S-XX or P0-X) from docs/WorkSlices.md, reading only the doc sections that slice cites.
argument-hint: S-XX
disable-model-invocation: true
---

Start slice $ARGUMENTS.

## 1. Load the slice, not the docs

```
node scripts/doc.mjs slice $ARGUMENTS
```

It prints the phase's instructions where that phase has any, then the slice row with any
warning paragraph written about it, then every section and decision the row cites. A
superseded decision is never expanded, only flagged.

**Read the phase paragraph first** when there is one. It carries what applies to every slice
in the phase and to none of them in particular, which is where "build this with the
verification check disabled, Phase 4 adds the gate" lives. It contradicts the spec sections
below it on purpose. Phases 1, 4 and 6 have no such paragraph, so 11 briefs print none.

A section over 800 tokens with two or more subsections comes back as a menu of them with their
sizes and the command to read one. `doc toc slices` marks a slice whose brief holds a menu with
`+`, and none does today. When one does, run the second command; the menu is not the content.
Any other section prints in full, so a brief can be large without any menu in it.

The brief ends with a line of ids one hop further out. Fetch one only when the brief says
it matters: `doc D-55`.

Then, and only then:

1. Check every dependency has merged: `gh pr list --state merged --search "<id> in:title"` if
   `gh` works, otherwise ask. If one has not merged, stop and say which. Do not build against
   an interface you imagined.
2. Read the `CLAUDE.md` of every package the slice touches.
3. Read `packages/shared-types`. Reuse a schema that exists. Never redeclare one.

If the user attaches a design image, use it for layout only. The spec section decides behavior.

**If `doc.mjs` is unavailable**, read the sections the slice row cites directly: every one is
numbered, so `grep -n '^#### 4.11.4' docs/Idea.md` then `sed -n 'a,bp'`. Do not read a whole
doc, and do not trust `grep -n '^#'` to find headings; it also matches a `#` comment inside a
fenced code block. On Windows this needs Git Bash or WSL2.

## 2. Read the slice back before anything else

**Write nothing until this is done and the user has answered it.** Not a schema, not a file,
not a test. The point of this step is to find what the docs get wrong about *this* slice
while it is still cheap, instead of discovering it half-built.

Produce these six, in this order, and keep it short:

1. **What this slice is.** One paragraph in your own words: what someone can do when it is
   finished that they could not before. If you cannot write it without hedging, the brief is
   missing something; say what.
2. **How you would build it.** The shape, not the code. Tables and columns touched,
   endpoints, jobs, screens, and the order you would do them in. Name every file you would
   create or change.
3. **What it inherits, and what it owes.** Read the row of every slice in the "Depends on"
   column and say what interface you are building against. Then run
   `node scripts/doc.mjs why <this slice>` and say which later slices are reading what you
   are about to write, and what that obliges you to get right now rather than later.
4. **Every edge case you can find.** Start with `spec §5` if the brief carries it, then the
   warning paragraph, then the phase paragraph, then your own reading of the spec sections.
   For each one, say what the docs say to do, or say **"the docs do not say"**. Do not fill
   a gap with a guess here; naming the gap is the work.
5. **What the docs get wrong.** Every contradiction, stale line, missing field and wrong name
   you hit while doing the five above, with the section id for each. This is the most useful
   part of the step. An empty list is a suspicious list.
6. **What this touches that fails silently.** The numbered invariants in root `CLAUDE.md`
   and the human-read surfaces, by number.

Then **stop**. The user either says go or fixes the docs for this slice and the ones it
depends on first.

**The docs are a draft, not a contract.** They are written by the same agents that read them,
and every review of them so far has found something wrong. If two sections disagree, or one
describes something that cannot work, say so in step 5 and propose the wording. Do not bend
the build to match a document, and do not invent a reading that makes a contradiction go
away. Two things are different in kind: the numbered invariants in root `CLAUDE.md` and the
entries in `docs/DecisionLog.md` are decisions, not descriptions. Those you raise and the
team rules on; you do not quietly build the other thing. `docs/ARCHITECTURE.md` wins over the
spec and the handbook when they disagree (D-75), and it has been wrong too, so say when it
is the one that looks wrong.

## 3. Two stops after that

1. Propose the zod schema for this slice in `packages/shared-types`. Stop. Nothing else gets written until the user has reviewed and merged it.
2. Build it, in the order the read-back set out. For a human-read surface, write the negative test before the code it tests.

## 4. Done

Go through the Definition of done in `docs/WorkSlices.md` item by item and report each one as met or not met. If `docs/ARCHITECTURE.md` needs an update, say which section and what changes. Do not describe a slice as done while an item is unmet.
