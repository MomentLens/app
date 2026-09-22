# AGENTS.md

This file exists for agent tools that read `AGENTS.md` rather than `CLAUDE.md`. The rules are the same for every agent on this project, and they live in one place so they cannot drift.

Before any work, read:

1. `CLAUDE.md` in this directory: the invariants, the doc routing and how the team works.
2. The `CLAUDE.md` in `apps/mobile/`, `apps/api/` or `worker/` for every package the task touches.

Slice work follows `.claude/skills/slice/SKILL.md` step by step, through the handoff template at the end of `docs/WorkSlices.md`. Read the docs with `node scripts/doc.mjs`, never whole files.
