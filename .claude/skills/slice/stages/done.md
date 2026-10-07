## 5. Done

`git fetch origin` and check out the top branch of the stack. Run `slice-verifier` once more against the whole stack, with base `origin/main`. Then go through the Definition of done in `docs/WorkSlices.md` item by item. For each one say met or not met, with the evidence: the test name and file, the command and its result, or the reason it does not apply. Do not describe a slice as done while an item is unmet.

If `docs/ARCHITECTURE.md` needs an update, write it now as its own commit on the top branch, citing the D-entry or the merged code, and name it in that PR so the code owners approve it there (D-75, D-107). A code owner's own change needs no other approval. The build stages never edit `docs/`; only this stage and the read-back's doc-fix branch do.

Every PR in the stack names which of the four human-read surfaces it touches, or says it touches none. Fix any description that does not, with `gh pr edit <n> --body-file`.

**Put the discussion log in the top PR.** Collect every stage's log from the issue, `gh issue view <n> --json comments --jq '.comments[].body | select(startswith("## Discussion log"))'`, add this stage's own, and append them oldest first to the top PR's description inside a collapsed block:

```
<details>
<summary>Discussion log</summary>

(every stage's log, oldest first)

</details>
```

GitHub caps a description at 65,536 characters. If the logs would pass it, link each issue comment instead of copying it.

Post this stage's log to the issue, then tell the developer, and stop there:

1. The stack from bottom to top, each PR with its number and link.
2. **Review.** GitHub has already requested the code owners' review on every PR. Another developer's review is welcome and never required; if the developer wants one, give `gh pr edit <n> --add-reviewer <their GitHub login>` for each PR and offer to run it. **For a code owner's own stack** there is nobody to wait for: run `/code-review` on each PR, fix what it finds on the branch it belongs to, then record it on the PR with `gh pr comment <n> --body "/code-review ran: <n> findings, <what was fixed or why not>"`, and say the stack can merge once CI is green. An agent tool without `/code-review` reviews each diff against the numbered invariants itself, and says so in that comment.
3. How it lands: once every PR is approved, or for a code owner reviewed by `/code-review`, and green, it merges from the top down with Rebase and merge (Handbook §12). Folding the stack down drops the bottom PR's approval, so that PR needs approving once more before it reaches `main`. Then `/slice <id> cleanup` in a fresh session, which can do the merging too.
