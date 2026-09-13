---
name: slice
description: Start a MomentLens work slice (S-XX or P0-X) from docs/WorkSlices.md, reading only the doc sections that slice cites.
argument-hint: S-XX
disable-model-invocation: true
---

Start slice $ARGUMENTS.

## 1. Load the slice, not the docs

The four docs in `docs/` run 8K to 32K tokens each. Reading one whole burns context the slice needs. Read sections.

1. `grep -n "$ARGUMENTS" docs/WorkSlices.md`. Read that table row and any bold note under the phase that names $ARGUMENTS. The row gives the spec sections, the owner and the dependencies.
2. Check every dependency has merged: `gh pr list --state merged --search "<id> in:title"` if `gh` works, otherwise ask. If one has not merged, stop and say which. Do not build against an interface you imagined.
3. Read each cited section and nothing else:
   - Spec: `grep -n '^#' docs/Idea.md`, then read from the section's heading to the next heading at the same level.
   - Handbook: `grep -n '^##' docs/EngineeringHandbook.md`, same rule.
   - Decision log: `grep -n '^### D-57' docs/DecisionLog.md`, read to the next `###`. Follow a D-entry only when a section you read cites it.
4. Read the `CLAUDE.md` of every package the slice touches, and the `docs/ARCHITECTURE.md` sections for any table, R2 key or worker job it touches.
5. Read `packages/shared-types`. Reuse a schema that exists. Never redeclare one.

If the user attaches a design image, use it for layout only. The spec section decides behavior.

## 2. Three stops

1. Propose the zod schema for this slice in `packages/shared-types`. Stop. Nothing else gets written until the user has reviewed and merged it.
2. Describe the approach and list every file you would create or change. Name the root invariants and the human-read surfaces (root `CLAUDE.md`) this slice touches. Stop.
3. Build it. For a human-read surface, write the negative test before the code it tests.

## 3. Done

Go through the Definition of done in `docs/WorkSlices.md` item by item and report each one as met or not met. If `docs/ARCHITECTURE.md` needs an update, say which section and what changes. Do not describe a slice as done while an item is unmet.
