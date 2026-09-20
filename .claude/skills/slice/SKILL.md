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

One command. It prints the slice row with any warning paragraph written about it, expands
every section and decision the row cites, and refuses to expand a superseded decision, showing
it with a banner instead.

The brief ends with a line of ids one hop further out. Fetch one only when the brief says
it matters: `doc D-55`.

Then, and only then:

1. Check every dependency has merged: `gh pr list --state merged --search "<id> in:title"` if
   `gh` works, otherwise ask. If one has not merged, stop and say which. Do not build against
   an interface you imagined.
2. Read the `CLAUDE.md` of every package the slice touches.
3. Read `packages/shared-types`. Reuse a schema that exists. Never redeclare one.

If the user attaches a design image, use it for layout only. The spec section decides behavior.

**If `doc.mjs` is unavailable**, `node scripts/doc.mjs toc <file>` is the map when it works,
and failing that read the sections the slice row cites with `sed -n 'a,bp'`. Do not read a
whole doc, and do not trust `grep -n '^#'` to find headings; several docs have `#` comments
inside fenced blocks.

## 2. Three stops

1. Propose the zod schema for this slice in `packages/shared-types`. Stop. Nothing else gets written until the user has reviewed and merged it.
2. Describe the approach and list every file you would create or change. Name the root invariants and the human-read surfaces (root `CLAUDE.md`) this slice touches. Stop.
3. Build it. For a human-read surface, write the negative test before the code it tests.

## 3. Done

Go through the Definition of done in `docs/WorkSlices.md` item by item and report each one as met or not met. If `docs/ARCHITECTURE.md` needs an update, say which section and what changes. Do not describe a slice as done while an item is unmet.
