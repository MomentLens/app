---
name: slice
description: Run a MomentLens work slice (S-XX or P0-X) from docs/WorkSlices.md in stages, reading only the doc sections that slice cites and shipping it as a stack of PRs.
argument-hint: S-XX [schema|build <package>|done|cleanup]
disable-model-invocation: true
---

The words after the skill name are the slice id, then the stage: `/slice S-12 build api` in Claude Code, `$slice S-12 build api` in Codex. With no stage, the stage is the read-back. The build stage takes a third word, the package: `api`, `mobile` or `worker`. If it is missing, ask which package; never pick one.

| Stage | Command | Reads | Ends at |
|---|---|---|---|
| Read-back | `/slice S-12` | `stages/readback.md` | the explanation and the card written to the issue, the ledger entry posted, and the doc-fix PR if the read-back fixed docs |
| Schema | `/slice S-12 schema` | `stages/schema.md` | the schema PR open on the stack, for a slice whose card gives it a schema stage |
| Build | `/slice S-12 build api`, then `build mobile` | `stages/build.md` | that package's PR open on the stack |
| Done | `/slice S-12 done` | `stages/done.md` | the last edits made and verified, the explanation answered with evidence, the readiness record written, the review requested |
| Cleanup | `/slice S-12 cleanup` | `stages/cleanup.md` | the readiness record checked, the stack merged, the issue closed, the evidence posted, the machine back on an up-to-date `main` |

**Read `.claude/skills/slice/stages/<stage>.md` for the stage the arguments name, and no other stage's instructions.** This file holds what every stage shares; the stage file holds that stage's steps. **After a compaction, read the stage file again** before the next step: a compaction keeps only part of a skill and none of a file read during the session.

**Each stage starts in a fresh session** (`/clear`). Two things cross from one stage to the next: the slice card in the slice's GitHub issue, which a person approved, and the stack's branches on GitHub. Never carry a stage's conversation into the next one (Handbook §18.8).

**No stage before cleanup merges anything or asks anyone to.** The slice ships as a stack of PRs that nobody merges until the done stage has finished, the stack has been reviewed and its readiness record is current. Cleanup merges, on the developer's yes.

These steps are the same for every developer and every agent. Codex runs this skill as `$slice` from its copy in `.agents/skills/slice/`, reads the same stage files, and has its own copies of the two slice agents in `.codex/agents/`. An agent tool that cannot run skills follows this file through the handoff template in `docs/WorkSlices.md`, doing the subagents' work itself.

**Keep work inline by default** (D-151). A large brief or log is only a candidate for delegation. Before spawning for an independent audit, interface lookup or verification pass, read `.claude/skills/slice/stages/delegation.md` and establish at least a 30% saving in total raw tokens, including child startup, reasoning, retries and the main agent's dispatch and read-back. When the estimate is uncertain, do the work yourself. The same audit and verification checks apply either way. Schema writing, package implementation, final review, readiness decisions and cleanup stay with the main agent.

Find the slice's issue once and reuse its number: `gh issue list --state all --search "<id> in:title" --json number,title,state`, the one whose title starts with `<id>:`.

**After the read-back, load the card, not the issue.** The issue body holds the explanation, the card and the readiness record, and a stage needs only the card: `gh issue view <n> --json body -q .body | awk '/^## Slice card/{p=1} /^## Readiness/{p=0} p'`. The done and cleanup stages read the other two sections when their steps say so.

**Edit the issue body one section at a time.** `gh issue edit --body-file` replaces the whole body. Fetch it to `.slices/<id>/issue.md` (`gh issue view <n> --json body -q .body`), change only your section there, then fetch the body again and compare it with the copy you started from. If it changed in between, someone else edited the issue: stop and say so. Otherwise `gh issue edit <n> --body-file .slices/<id>/issue.md`.

## The stack

One branch and one PR for each stage that writes code or docs. Each branch is cut from the branch below it, and each PR targets that branch:

| Order | Branch | PR title | PR base |
|---|---|---|---|
| 1, only if the read-back fixed docs | `docs/<id>-rulings` | `<id>: doc fixes from the read-back` | `main` |
| 2, unless the card says the slice has no schema stage | `feat/<id>-schema` | `<id>: schema` | the branch below, or `main` |
| 3 on, one per package in the card's build order | `feat/<id>-<package>` | `<id>: <package>` | the branch below |

The id is lower case in branch names: `feat/s-12-schema`, `feat/s-12-api`.

- **Every stage starts with `git fetch origin`** and then cuts its branch from the one below: `git switch -c feat/s-12-api origin/feat/s-12-schema`. Only the bottom branch is cut from `origin/main`. If the branch below is not on GitHub, stop and say which stage has not run.
- **A rerun stage reuses its branch and its PR.** If the branch already exists, switch to it and carry on; never recreate it. A fix asked for in review is a rerun of the stage that wrote that code, `schema` or `build <package>`, on that branch.
- **Push and open the PR at the end of the stage.** Look for one first: `gh pr list --head <branch> --state all --json number,state`. If it exists, push and update its description with `gh pr edit <n> --body-file .slices/<id>/pr-<stage>.md`. Otherwise `git push -u origin <branch>`, then `gh pr create --base <branch below> --head <branch> --title "<title>" --body-file .slices/<id>/pr-<stage>.md`. Write that file to the sections of `.github/pull_request_template.md`: review evidence and a link to the issue, never the explanation or the ledger. The bottom PR's body holds `Closes #<issue>`, because the bottom PR is the last one to reach `main`.
- **A fix that belongs lower in the stack goes lower.** If the api build finds the schema missing a field, stop and ask. The fix is a commit on the lowest branch it belongs to, and every branch above it is then rebased onto it (`git rebase origin/<branch below>`, then `git push --force-with-lease`). That is a force push, so it needs the developer's yes each time.
- **Work in the checkout the session starts in**, whether that is the developer's clone or a worktree the app made for the session. Never switch the branch of a checkout whose Metro is serving another branch (a listener on port 8081 or 8082); add a worktree instead, `git worktree add ../MomentLens-<id> <branch>`, and copy the two `.env` files into it.

Review and merging happen once, after the done stage, as Handbook §12 describes. GitHub requests the code owners' review on every PR from `.github/CODEOWNERS`, and `main` takes a PR only with a code-owner approval and a green CI run. A code owner's own stack needs green CI and `/code-review` instead. Either way the stack merges only while its readiness record is current (D-149). It merges from the top down with Rebase and merge, which keeps every commit.

**Check once per session whether the developer is a code owner** (D-117): they are when `gh api orgs/MomentLens/teams/maintainers/members -q '.[].login'` lists their login, `gh api user -q .login`. Several steps differ for one. A code owner's merge to `main` uses `--admin`, which works only for a repository admin; if GitHub refuses it, treat the stack like anyone else's and ask a code owner to approve.

## Decision ledger

The code owners and the team read how a slice was decided in its issue (D-149). A session's conversation is gone after `/clear`, so each stage writes its entry while the session runs, not from memory at the end. Every slice keeps one, a code owner's own included (D-120).

Each stage keeps `.slices/<id>/ledger-<stage>.md` (the folder is gitignored). It opens with `## Ledger: <stage>, <date>, <developer's GitHub login>, card revision <n>` (`gh api user -q .login`), then one line per decision:

- <the decision>. Why: <the reason>. Decided by: <the developer, Ukasha, or you as a routine call>. Ids: <the D-nn, spec and arch ids it touches>.

Under the decisions, add what you tried and dropped and why, where the work departed from the card and who agreed, what the developer reported from the phone or the dev server, and anything you pushed back on and how it ended. Quote the developer word for word only for an instruction that changed the work's direction, the answer to a decision question, and anything a permission depends on, such as a yes to a migration push, a deploy or a force push. Remove secrets. Leave out routine prompts, whole question-and-answer exchanges, abandoned commands, tool output, logs and code.

Before the stage ends, post it: `gh issue comment <n> --body-file .slices/<id>/ledger-<stage>.md`. Nothing copies it anywhere else.
