// Reads a slice issue's readiness record and says whether the stack may move on (D-149).
//
//   node scripts/readiness.mjs --issue 97 --stage review --head 1a2b3c4
//   node scripts/readiness.mjs --body-file .slices/S-12/issue.md --stage merge --head HEAD
//
// The rows it expects are the bold labels of the Definition of done in docs/WorkSlices.md: the
// "Ready for review" list for --stage review, both lists for --stage merge. A row passes when its
// result is met, n/a with a reason, or an exception with a link, and its head holds the same
// changes as --head. Same changes, not the same commit: folding a stack replays its commits
// under new ids, and that alone must not make the record stale. Exits 1 with every reason it
// refuses, so cleanup stops before a merge rather than after.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const stage = option('--stage');
const head = option('--head');
const base = option('--base') || 'origin/main';
const usage =
  'usage: node scripts/readiness.mjs (--issue <n> | --body-file <path>) --stage review|merge --head <commit> [--base origin/main]';
if (
  !['review', 'merge'].includes(stage) ||
  !head ||
  !(option('--issue') || option('--body-file'))
) {
  console.log(usage);
  process.exit(2);
}

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256e6 });
  return r.status === 0 ? r.stdout : null;
};

// The labels, read from the Definition of done so the record cannot drift from it.
const labels = (() => {
  const doc = readFileSync(join(root, 'docs', 'WorkSlices.md'), 'utf8');
  const section = doc.split(/^## Definition of done\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const [review, merge] = section.split(/^\*\*Ready to merge\*\*/m);
  const pick = (t) => [...(t ?? '').matchAll(/^- \[ \] \*\*([^*]+?)\.\*\*/gm)].map((m) => m[1]);
  return { review: pick(review), merge: pick(merge) };
})();
if (!labels.review.length || !labels.merge.length) {
  console.log(
    'docs/WorkSlices.md has no "Ready for review" and "Ready to merge" lists to check against.',
  );
  process.exit(2);
}
const want = stage === 'review' ? labels.review : [...labels.review, ...labels.merge];

let body;
if (option('--body-file')) body = readFileSync(option('--body-file'), 'utf8');
else {
  const r = spawnSync('gh', ['issue', 'view', option('--issue'), '--json', 'body', '-q', '.body'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log(`gh could not read issue #${option('--issue')}: ${(r.stderr || '').trim()}`);
    process.exit(2);
  }
  body = r.stdout;
}
body = body.split(/\r\n|\r/).join('\n');

// The table under "## Readiness": | Item | Result | Head | Evidence | By |
const rows = new Map();
const record = body.split(/^## Readiness\s*$/m)[1]?.split(/^## /m)[0];
if (record)
  for (const line of record.split('\n')) {
    const cells = line.trim().startsWith('|')
      ? line
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim())
      : null;
    if (!cells || cells.length < 5 || /^-+$/.test(cells[0]) || cells[0] === 'Item') continue;
    rows.set(cells[0], { result: cells[1], head: cells[2], evidence: cells[3], by: cells[4] });
  }

// One patch id per head: the whole diff from the merge base with --base, so two heads holding
// the same changes agree whatever their commit ids.
const patchIds = new Map();
const changes = (commit) => {
  if (patchIds.has(commit)) return patchIds.get(commit);
  const diff = git('diff', '--binary', `${base}...${commit}`);
  let id = null;
  if (diff !== null) {
    const r = spawnSync('git', ['patch-id', '--stable'], {
      cwd: root,
      input: diff,
      encoding: 'utf8',
    });
    id = r.status === 0 ? r.stdout.split(' ')[0] || 'empty' : null;
  }
  patchIds.set(commit, id);
  return id;
};
const resolve = (c) => git('rev-parse', '--verify', '--quiet', `${c}^{commit}`)?.trim() ?? null;
const current = resolve(head);

const problems = [];
const notes = [];
if (!record)
  problems.push('the issue has no "## Readiness" section, so every row below is missing');
for (const label of want) {
  const row = rows.get(label);
  if (!row || !row.result) {
    problems.push(`${label}: missing`);
    continue;
  }
  const result = row.result.toLowerCase();
  if (/^not met\b/.test(result))
    problems.push(`${label}: not met${row.evidence ? `, ${row.evidence}` : ''}`);
  else if (/^n\/a\b/.test(result) && !/^n\/a:\s*\S/.test(result))
    problems.push(`${label}: n/a with no reason`);
  else if (/^exception\b/.test(result) && !/(https?:\/\/|#\d)/.test(row.result))
    problems.push(`${label}: an exception needs a link to Ukasha's decision in the issue`);
  else if (!/^(met|n\/a:|exception:)/.test(result))
    problems.push(`${label}: result "${row.result}" is not met, n/a: or exception:`);
  else if (/^met\b/.test(result) && !row.evidence) problems.push(`${label}: met with no evidence`);
  else if (!row.by) problems.push(`${label}: nobody is named as supplying it`);
  if (!row.head) {
    problems.push(`${label}: no head commit`);
    continue;
  }
  const recorded = resolve(row.head);
  if (!current) problems.push(`${label}: cannot find ${head} locally; git fetch first`);
  else if (!recorded)
    problems.push(`${label}: cannot find its head ${row.head} locally; git fetch first`);
  else if (recorded !== current) {
    const a = changes(recorded);
    const b = changes(current);
    if (!a || !b)
      problems.push(`${label}: cannot compare ${row.head} with ${head} against ${base}`);
    else if (a !== b)
      problems.push(
        `${label}: stale, recorded at ${row.head}, whose changes differ from ${head}'s`,
      );
    else notes.push(`${label}: recorded at ${row.head}, which holds the same changes as ${head}`);
  }
}

for (const n of new Set(notes)) console.log(`same  ${n}`);
if (problems.length) {
  console.log(
    `NOT READY to ${stage === 'review' ? 'review' : 'merge'}, ${problems.length} problem(s):`,
  );
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(
  `ready to ${stage === 'review' ? 'review' : 'merge'}: ${want.length} rows current at ${head}`,
);
