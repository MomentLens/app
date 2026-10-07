# Choosing a subtask

This is shared guidance for the five slice stages, not another stage. Read it only when considering delegation (D-151, hb §18.8).

## Compare the complete cost

Compare the same remaining task at the same quality bar. Start with the shortest correct inline approach, using targeted doc retrieval, batched searches and `scripts/verify.mjs`'s filtered output. Include the effort needed to complete that approach; a high main-session slider alone does not justify a child.

For each approach, estimate the sum of input and output tokens over its model calls. Include system and tool definitions, instructions, conversation history, retrieved files, tool output and their repetition on later calls. Cached input still counts. Output includes reasoning, so do not add reasoning twice. The delegated estimate also includes the main agent's dispatch, progress messages, reading and checking the report, and any expected retry. Account for retained intermediate context on later calls where the approaches differ. Exclude work both approaches have already performed.

Use recorded usage from comparable tasks or conservative bounds on context size and call count. `tokens()` in `scripts/docindex.mjs` estimates file content only; it cannot measure system prompts, tools, reasoning or repeated requests. Claude and Codex have different startup costs. A smaller model price, a short final report and less content in the main window do not establish fewer raw tokens.

Delegate only when the upper bound for delegated tokens is at most 70% of the lower bound for inline tokens. When unknown startup costs, uncertain call counts, inadequate model capability or duplicated work prevent that comparison, keep the task inline. Briefs over 1,500 tokens and more than 5,000 tokens of intermediate output are screening hints, not permission to spawn.

Record a qualifying call in the stage ledger with the task, model and effort, inline and delegated bounds, evidence behind the estimate, and why the child can meet the quality bar. Label estimates as estimates. Use recorded totals when the client exposes them; missing usage is unknown. Reuse recent evidence instead of running a new comparison for a routine lookup. Reassess after a failure or scope change; a repair can erase the expected saving.

## Choose the scope and effort

| Task | Who does it | Setting |
|---|---|---|
| Full documentation hunt | Main agent, or a qualifying `slice-auditor` | Main model at high effort; keep every numeric comparison and edge-case category |
| Broad dependency-interface map | Main agent, or a qualifying read-only explorer | Luna low in Codex for paths and exports; medium for bounded tracing, if its cost still qualifies |
| Verification evidence and invariant suspicions | Main agent, or a qualifying `slice-verifier` | Codex uses `gpt-6-luna` at medium; Claude uses `sonnet` (D-150) |
| Schema, package implementation, final review, readiness and cleanup | Main agent | Use the effort the task requires; no subagent |

An effort setting is not a token guarantee. Compare total task usage, including extra calls and repairs. The main agent handles unresolved behavior, privacy decisions and final review; the verifier's invariant checks remain suspicions for it to confirm. A model unavailable in the client does not silently fall back to an expensive inherited setting. Do the work inline or reassess a supported model and effort.

## Send a compact task packet

Give the checkout path, task, exact base and code state, allowed files or doc ids, relevant invariant numbers, named negative tests, existing log paths and the required report shape. The audit uses a slice id to load its brief by command. Keep scopes disjoint. Use a Codex spawn with `fork_turns="none"` when the tool supports it, and set the explorer's model and effort explicitly. The named slice agents use their configured settings. Never copy the stage conversation, the whole issue body or full logs into the packet. Count inherited instructions and tools even when no conversation history is forked.

For verification, give a complete manifest from the committed diff against the base, staged and unstaged changes, and non-ignored untracked files in scope. For example, combine `git diff --name-only <base>...HEAD`, `git diff --name-only HEAD` and `git ls-files --others --exclude-standard`, preserving deleted and renamed paths. The agent reads each candidate diff and records any unread path. A depth-limited directory search cannot establish complete coverage.

The agent returns one final report in its existing format, with evidence and missing coverage. It does not start more agents, edit code, resolve undecided behavior, or send routine progress reports to the main agent. The main agent checks findings against their cited sources and asks the developer for decisions. It completes any unread coverage and preserves the physical-device and human-read gates. Verification performed inline returns the same evidence table and checks.
