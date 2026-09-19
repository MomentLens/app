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

One command. It resolves the slice row, expands every spec section, handbook section and
decision that slice cites, stubs everything one hop further out with a one-line summary and
the command to expand it, and refuses to expand a superseded decision into the brief.

Expand a stub only when the brief tells you it matters: `doc D-55`. Before paying for a big
one, `doc explain slice $ARGUMENTS` prints the same chunk list with token costs and no bodies.

Then, and only then:

1. Check every dependency has merged: `gh pr list --state merged --search "<id> in:title"` if
   `gh` works, otherwise ask. If one has not merged, stop and say which. Do not build against
   an interface you imagined.
2. Read the `CLAUDE.md` of every package the slice touches.
3. Read `packages/shared-types`. Reuse a schema that exists. Never redeclare one.

If the user attaches a design image, use it for layout only. The spec section decides behavior.

**If `doc.mjs` is unavailable**, every doc carries a generated index at the top: `head -80
docs/Idea.md` lists every section with its id, token cost and a one-line summary. Read the
sections it names with `sed -n 'a,bp'`. Do not read a whole doc.

## 2. Three stops

1. Propose the zod schema for this slice in `packages/shared-types`. Stop. Nothing else gets written until the user has reviewed and merged it.
2. Describe the approach and list every file you would create or change. Name the root invariants and the human-read surfaces (root `CLAUDE.md`) this slice touches. Stop.
3. Build it. For a human-read surface, write the negative test before the code it tests.

## 3. Done

Go through the Definition of done in `docs/WorkSlices.md` item by item and report each one as met or not met. If `docs/ARCHITECTURE.md` needs an update, say which section and what changes. Do not describe a slice as done while an item is unmet.
