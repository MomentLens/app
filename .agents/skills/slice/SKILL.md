---
name: slice
description: Run a MomentLens work slice (S-XX or P0-X) from docs/WorkSlices.md in stages, reading only the doc sections that slice cites and shipping it as a stack of PRs.
argument-hint: S-XX [schema|build <package>|done|cleanup]
disable-model-invocation: true
---

The words after the skill name are the slice id, then the stage: `/slice S-12 build api` in Claude Code, `$slice S-12 build api` in Codex. With no stage, the stage is the read-back. The build stage takes a third word, the package: `api`, `mobile` or `worker`. If it is missing, ask which package; never pick one.

| Stage | Command | Reads | Ends at |
|---|---|---|---|
| Read-back | `/slice S-12` | `stages/readback.md` | the slice card written to the issue, and the doc-fix PR if the read-back fixed docs |
| Schema | `/slice S-12 schema` | `stages/schema.md` | the schema PR open on the stack |
| Build | `/slice S-12 build api`, then `build mobile` | `stages/build.md` | that package's PR open on the stack |
| Done | `/slice S-12 done` | `stages/done.md` | every Definition of done item reported, the discussion log in the top PR, the review requested |
| Cleanup | `/slice S-12 cleanup` | `stages/cleanup.md` | the stack merged, the issue closed, the machine back on an up-to-date `main` |

**Read `.claude/skills/slice/stages/<stage>.md` for the stage the arguments name, and no other stage file.** This file holds what every stage shares; the stage file holds that stage's steps.

**Each stage starts in a fresh session** (`/clear`). Two things cross from one stage to the next: the slice card in the slice's GitHub issue, which a person approved, and the stack's branches on GitHub. Never carry a stage's conversation into the next one (Handbook §18.8).

**No stage asks anyone to merge anything.** The slice ships as a stack of PRs that nobody merges until the done stage has finished and the stack has been reviewed.

These steps are the same for every developer and every agent. Codex runs this skill as `$slice` from its copy in `.agents/skills/slice/`, reads the same stage files, and has its own copies of the two slice agents in `.codex/agents/`. An agent tool that cannot run skills follows this file through the handoff template in `docs/WorkSlices.md`, doing the subagents' work itself.

Find the slice's issue once and reuse its number: `gh issue list --state all --search "<id> in:title" --json number,title,state`, the one whose title starts with `<id>:`.

## The stack

One branch and one PR for each stage that writes code or docs. Each branch is cut from the branch below it, and each PR targets that branch:

| Order | Branch | PR title | PR base |
|---|---|---|---|
| 1, only if the read-back fixed docs | `docs/<id>-rulings` | `<id>: doc fixes from the read-back` | `main` |
| 2 | `feat/<id>-schema` | `<id>: schema` | the branch below, or `main` |
| 3 on, one per package in the card's build order | `feat/<id>-<package>` | `<id>: <package>` | the branch below |

The id is lower case in branch names: `feat/s-12-schema`, `feat/s-12-api`.

- **Every stage starts with `git fetch origin`** and then cuts its branch from the one below: `git switch -c feat/s-12-api origin/feat/s-12-schema`. Only the bottom branch is cut from `origin/main`. If the branch below is not on GitHub, stop and say which stage has not run.
- **A rerun stage reuses its branch.** If the branch already exists, switch to it and carry on; never recreate it.
- **Push and open the PR at the end of the stage**: `git push -u origin <branch>`, then `gh pr create --base <branch below> --head <branch> --title "<title>" --body-file .slices/<id>/pr-<stage>.md`, with that file written to the sections of `.github/pull_request_template.md`. The bottom PR's body holds `Closes #<issue>`, because the bottom PR is the last one to reach `main`.
- **A fix that belongs lower in the stack goes lower.** If the api build finds the schema missing a field, stop and ask. The fix is a commit on the lowest branch it belongs to, and every branch above it is then rebased onto it (`git rebase origin/<branch below>`, then `git push --force-with-lease`). That is a force push, so it needs the developer's yes each time.
- **Work in the checkout the session starts in**, whether that is the developer's clone or a worktree the app made for the session. Never switch the branch of a checkout whose Metro is serving another branch (a listener on port 8081 or 8082); add a worktree instead, `git worktree add ../MomentLens-<id> <branch>`, and copy the two `.env` files into it.

Review and merging happen once, after the done stage, as Handbook §12 describes. GitHub requests the code owners' review on every PR from `.github/CODEOWNERS`, and `main` takes a PR only with a code-owner approval and a green CI run. A code owner's own stack needs green CI and `/code-review` instead. The stack merges from the top down with Rebase and merge, which keeps every commit.

**Check once per session whether the developer is a code owner** (D-117): they are when `gh api orgs/MomentLens/teams/maintainers/members -q '.[].login'` lists their login, `gh api user -q .login`. Several steps below differ for one. A code owner's merge to `main` uses `--admin`, which works only for a repository admin; if GitHub refuses it, treat the stack like anyone else's and ask a code owner to approve.

## Discussion log

The code owners read each slice's story in its final PR. A session's conversation is gone after `/clear`, so every stage writes down what mattered while it happens, not from memory at the end. Every slice keeps one, a code owner's own included (D-120).

Each stage keeps `.slices/<id>/discussion-<stage>.md` (the folder is gitignored) and adds to it as the conversation goes:

- The developer's instructions that steered the work, quoted word for word. Remove only secrets.
- Every question you asked and its answer, word for word.
- Every decision and who made it: the developer, Ukasha, or you as a routine call.
- What you tried and dropped, and why.
- Where the work departed from the card, and who agreed.
- What the developer reported from the phone or the dev server.
- Anything you pushed back on, and how it ended.

Never tool output, logs or code. The file opens with `## Discussion log: <stage>, <date>, <developer's GitHub login>` (`gh api user -q .login`). Before the stage ends, post it to the slice's issue with `gh issue comment <n> --body-file .slices/<id>/discussion-<stage>.md`. The done stage copies every one of them into the top PR.
