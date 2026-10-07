## 1. Load the slice, not the docs

```
node scripts/doc.mjs slice <id>
```

It prints the phase's instructions where that phase has any, then the slice row with any warning paragraph written about it, then every section and decision the row cites, then the rows of the slices it depends on. A superseded or void decision is never expanded, only flagged.

**Read the phase paragraph first** when there is one. It carries what applies to every slice in the phase and to none of them in particular, which is where "build this with the verification check disabled, Phase 4 adds the gate" lives. It overrides the spec sections below it on purpose.

A section over 800 tokens with two or more subsections comes back as a menu of them with their sizes and the command to read one. `doc toc slices` marks a slice whose brief holds a menu with `+`. When a brief holds one, run the second command; the menu is not the content.

The brief ends with a line of ids one hop further out. Fetch one only when the brief says it matters: `doc D-55`.

Then, and only then:

1. **Check every dependency is finished.** A slice ships as a stack of PRs, so a merged PR with the id in its title proves nothing. The slice's issue closes when its stack reaches `main`. For each id in the "Depends on" column run `gh issue list --state all --search "<id> in:title" --json number,title,state` and read the issue whose title starts with `<id>:`. If it is open, stop and say which. If it is closed, read its readiness record, `gh issue view <n> --json body -q .body | awk '/^## Readiness/{p=1} p'`, and say which items were not met or carried an exception. A slice closed before readiness records existed (D-149) has none, and S-11 merged with an item unmet: for those, check in merged code that the interface you build against exists, and write "readiness unknown" beside it in item 3. If `gh` is missing or not logged in, ask. Never build against an interface you imagined.
2. Read the `AGENTS.md` of every package the slice touches. Codex does not load one below the folder it started in.
3. List what `packages/shared-types` exports, `grep -n '^export' packages/shared-types/src/*.ts`, and open only the files you will reuse or extend. Reuse a schema that exists. Never redeclare one.

**If `doc.mjs` is unavailable**, read the sections the slice row cites directly: every one is numbered, so `grep -n '^#### 4.11.4' docs/Idea.md` then `sed -n 'a,bp'`. Do not read a whole doc, and do not trust `grep -n '^#'` to find headings; it also matches a `#` comment inside a fenced code block. On Windows this needs Git Bash or WSL2.

## 2. Read the slice back before anything else

**Write no code and no docs until this is done and the user has answered it.** Not a schema, not a file, not a test. The ledger is the one file you keep as you go. This step exists to find what the docs get wrong about *this* slice while it is still cheap.

**Delegate the hunt when the brief is large.** The brief's header gives its size. Over about 1,500 tokens, start two subagents at once: `slice-auditor` with the slice id, which does items 4 and 5 below in its own context and returns findings, gaps, what it checked and the decisions needed; and the built-in read-only agent (`Explore` in Claude Code, `explorer` in Codex), asked what already exists in the code for each interface in the "Depends on" column, answering with paths and exported names only. Write items 1 to 3 while they run, use their reports for items 3 to 7, and check any finding you pass on against the ids it cites. Under about 1,500 tokens, do items 4 and 5 yourself: a small brief names few enough ids that the lookups cost less than a subagent does (Handbook §18.8).

This is an audit, not a summary. Do not open by praising the docs or restating the brief. Short sentences, complete lists: every item below is required, and "none" is only an answer if you say what you checked to reach it.

Produce these seven, in this order:

1. **What this slice is.** One paragraph in your own words: what someone can do when it is finished that they could not before. If you cannot write it without hedging, the brief is missing something; say what.
2. **How you would build it.** The shape, not the code. Tables and columns touched, endpoints, jobs, screens, and the order you would do them in. Name every file you would create or change, every dependency you would add (adding one is a decision, root `AGENTS.md`), and every negative test you will write: for each endpoint, another user, another event and the wrong role, plus a Do Not Publish subject and another viewer for anything that returns faces or images. Say whether the slice needs a schema stage: it does unless every schema it uses already exists in `packages/shared-types`, as for S-11 (D-146).
3. **What it inherits, and what it owes.** Read the row of every slice in the "Depends on" column and name the exact interface you build against: the schema in `packages/shared-types`, the endpoint, the column. If it does not exist yet, say so. Then run `node scripts/doc.mjs why <this slice>` and say which later slices read what you are about to write, and what that obliges you to get right now.
4. **Every edge case, by category.** Go through each of these and give at least one case, or say why the category cannot apply to this slice:
   - each role: Admin, Guest, Photographer, a pending member, a blocked member, a non-member
   - a Do Not Publish subject against every other viewer
   - offline, a retry, and the app killed between any two steps
   - two devices acting at once, one account or two people (an event has one Admin, D-102)
   - zero, one, the cap, and one past the cap (spec §4.17)
   - time: a sub-event starting, ending, running late, overlapping (spec §4.3)
   - a Realtime update arriving mid-action

   For each case, say what the docs say to do, citing the id, or say **"the docs do not say"**. Never fill a gap with a guess here; naming the gap is the work. Read the spec §5 subsections for this slice's area, whether or not the brief carries them; `doc spec §5` lists all six.
5. **What the docs get wrong.** Hunt, do not wait to notice. Do each of these and report what you found:
   - Look up every table, column, endpoint, job and R2 key the slice touches in `docs/ARCHITECTURE.md`, and compare it with how the spec and handbook sections in the brief describe it. Anything the API must do in one transaction has to go through a SQL function called with `rpc`, because supabase-js holds no transaction (D-95); flag any that the docs describe as two calls.
   - Compare every number in the brief (limits, sizes, radii, windows, thresholds) across every place it appears.
   - Check every cited `D-nn` for an "Amended" line or a later entry that changes it: `node scripts/doc.mjs why <the ids> --refs` lists both without reprinting the bodies.
   - Check every rule in the brief against the numbered invariants in root `AGENTS.md`.

   Report each finding with the two ids that disagree, or one id and why it cannot work, plus the wording you propose. Then list what you checked and found consistent, so an empty findings list can be told apart from an unread brief.
6. **What this touches that fails silently.** The numbered invariants in root `AGENTS.md` and the human-read surfaces, by number, and the negative test that covers each one.
7. **What I need you to decide.** Every question above that only the team can answer, each with the option you recommend and what it costs.

Then **stop**. The user either says go or fixes the docs for this slice and the ones it depends on first. Record each answer in the ledger as it comes, word for word for a decision question.

**When the user has answered**, write two sections of the issue body, one edit at a time as SKILL.md says, following the template there:

- **Explanation**, the plan in plain words, for a person who will read nothing else (hb §18.7). Answer five questions. What enters the system, and what can a person see when it works? Which component decides each step, where is progress stored, and what passes work on? What happens on a refusal, an interruption, a retry and two people acting at once? Which safety rules apply, and which checks will show they hold? What needs a person's decision, and what does the recommended option cost? Name a file, function, column or variable only when the reader needs it to act or to check a claim, and give its path when you do.
- **Slice card**, revision 1. It holds ids and paths, never copied doc text, and stays under about 900 tokens. It says whether the slice has a schema stage.

Doc fixes the read-back turned up go on the bottom of the stack: branch `docs/<id>-rulings` from `origin/main`, pushed and opened as the stack's first PR. A doc fix that changes a decision needs a `D-nn` entry, and Ukasha rules on it in review. Then post the ledger entry, and tell the user this stage is finished and the next is `/slice <id> schema` in a fresh session, or `/slice <id> build <first package>` when the card says the slice has no schema stage.

**The docs are a draft, not a contract.** They are written by the same agents that read them, and every review of them so far has found something wrong. If two sections disagree, or one describes something that cannot work, say so in step 5 and propose the wording. Do not bend the build to match a document, and do not invent a reading that makes a contradiction go away. Two things are different in kind: the numbered invariants in root `AGENTS.md` and the entries in `docs/DecisionLog.md` are decisions, not descriptions. Those you raise and the team rules on; you do not quietly build the other thing. `docs/ARCHITECTURE.md` wins over the spec and the handbook when they disagree (D-75), and it has been wrong too, so say when it is the one that looks wrong.
