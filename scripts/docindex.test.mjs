// Fixtures for scripts/doc.mjs and scripts/docindex.mjs. Run with `node --test scripts/`.
//
// Each test writes a small corpus to a temporary folder with copies of both scripts beside it,
// the way the pre-commit hook checks its snapshot, so the scripts read the fixture and never
// the repo's docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The smallest five docs that pass the gate. A test replaces only the files it is about.
const SLICES_HEAD =
  '# Slices\n\n# Phase 1 — one\n\nBuild this phase on hb §1, before S-02 starts.\n\n';
const TABLE =
  '| ID | Slice | Spec | Owner | Depends on |\n|---|---|---|---|---|\n' +
  '| S-01 | First | spec §1, spec §2 | U | |\n' +
  '| S-02 | Second | spec §2, arch §1 | U | S-01 |\n';
const BASE = {
  'docs/Idea.md':
    '# Spec\n\n## 1. Intro\n\nWhat the app is.\n\n## 2. Upload\n\nHow a photo goes up.\n',
  'docs/EngineeringHandbook.md':
    '# Handbook\n\n## 1. Setup\n\nInstall the tools.\n\n## 2. Testing\n\nRun the tests.\n',
  'docs/DecisionLog.md':
    '# Log\n\n### D-01: First decision\n**Decision.** Photos upload once.\n**Why.** Bytes cost money.\n\n' +
    '### D-02: Second decision\n**Decision.** Thumbnails are small.\n',
  'docs/ARCHITECTURE.md':
    '# Architecture\n\n## 1. Data\n\nThe tables.\n\n### 1.1 Media\n\nOne row per photo, D-02.\n\n### 1.2 Event\n\nOne row per event.\n',
  'docs/WorkSlices.md': SLICES_HEAD + TABLE,
};

const corpus = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'docindex-'));
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['doc.mjs', 'docindex.mjs']) copyFileSync(join(here, f), join(dir, 'scripts', f));
  for (const [p, text] of Object.entries({ ...BASE, ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const doc = (...args) => {
    try {
      const out = execFileSync('node', [join(dir, 'scripts', 'doc.mjs'), ...args], {
        encoding: 'utf8',
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  return { doc, done: () => rmSync(dir, { recursive: true, force: true }) };
};

// Runs fn against a fixture and always removes it.
const withCorpus = (files, fn) => {
  const c = corpus(files);
  try {
    fn(c.doc);
  } finally {
    c.done();
  }
};

const passes = (doc) => {
  const r = doc('check');
  assert.equal(r.code, 0, r.out);
};
const failsWith = (doc, code, text) => {
  const r = doc('check');
  assert.equal(r.code, 1, r.out);
  const line = r.out.split('\n').find((l) => l.includes(`  ${code}  `));
  assert.ok(line, `expected ${code} in:\n${r.out}`);
  if (text) assert.match(line, text);
};

test('the base corpus passes the gate', () => withCorpus({}, passes));

test('P1: a brief prints what its phase paragraph cites, and no slice the paragraph names', () =>
  withCorpus({}, (doc) => {
    const brief = doc('slice', 'S-01').out;
    assert.match(brief, /^--- hb §1 · /m);
    assert.doesNotMatch(brief, /^--- S-02 · /m);
  }));

test('P1: a section the row and the phase paragraph both cite prints once', () =>
  withCorpus(
    {
      'docs/WorkSlices.md':
        SLICES_HEAD + TABLE.replace('spec §1, spec §2 | U', 'spec §1, spec §2, hb §1 | U'),
    },
    (doc) => {
      const brief = doc('slice', 'S-01').out;
      assert.equal(brief.match(/^--- hb §1 · /gm).length, 1);
    },
  ));

test('P2: an amendment the older entry does not record fails the gate', () => {
  const log = BASE['docs/DecisionLog.md'].replace(
    '**Decision.** Thumbnails are small.',
    '**Decision.** Amends D-01. Thumbnails are small.',
  );
  withCorpus({ 'docs/DecisionLog.md': log }, (doc) =>
    failsWith(
      doc,
      'missing-backlink',
      /D-02 amends D-01, but D-01 has no "Amended \(see D-02\)" line/,
    ),
  );
  const fixed = log.replace(
    '**Why.** Bytes cost money.',
    '**Why.** Bytes cost money.\n**Amended (see D-02).** Thumbnails too.',
  );
  withCorpus({ 'docs/DecisionLog.md': fixed }, passes);
});

test('P2: only ids after the verb count, and a retired entry needs no line', () => {
  const log =
    '# Log\n\n### D-01: First\n**Decision.** One.\n**Amended (see D-03).** Changed.\n\n' +
    '### D-02: Second ~~(SUPERSEDED by D-03)~~\n**Decision.** Two.\n\n' +
    '### D-04: Fourth\n**Decision.** Four.\n\n' +
    "### D-03: Third\n**Decision.** Supersedes D-02 and amends D-01 and keeps D-04's header. Three.\n";
  withCorpus({ 'docs/DecisionLog.md': log }, passes);
  withCorpus({ 'docs/DecisionLog.md': log.replace(' ~~(SUPERSEDED by D-03)~~', '') }, (doc) =>
    failsWith(doc, 'missing-backlink', /D-03 supersedes D-02/),
  );
});

test('P9: an amended decision prints its amendment lines first, under one label', () => {
  const log = BASE['docs/DecisionLog.md']
    .replace(
      '**Why.** Bytes cost money.',
      '**Why.** Bytes cost money.\n**Amended (see D-02).** Twice now.',
    )
    .replace(
      '**Decision.** Thumbnails are small.',
      '**Decision.** Amends D-01. Thumbnails are small.',
    );
  withCorpus({ 'docs/DecisionLog.md': log }, (doc) => {
    const lines = doc('D-01').out.split('\n');
    const at = (p) => lines.findIndex((l) => l.startsWith(p));
    assert.equal(at('Changed since.'), at('### D-01') + 1);
    assert.equal(at('**Amended (see D-02).**'), at('Changed since.') + 1);
    assert.ok(at('**Decision.**') > at('**Amended (see D-02).**'));
    // The label is the only line added; every line of the entry is still printed once.
    assert.equal(lines.filter((l) => l.startsWith('**')).length, 3);
  });
});

test('P6: why --refs prints the amendment lines and leaves out the body', () => {
  const log = BASE['docs/DecisionLog.md']
    .replace(
      '**Why.** Bytes cost money.',
      '**Why.** Bytes cost money.\n**Amended (see D-02).** Twice now.',
    )
    .replace(
      '**Decision.** Thumbnails are small.',
      '**Decision.** Amends D-01. Thumbnails are small.',
    );
  withCorpus({ 'docs/DecisionLog.md': log }, (doc) => {
    const refs = doc('why', 'D-01', '--refs').out;
    assert.match(refs, /^\*\*Amended \(see D-02\)\.\*\* Twice now\.$/m);
    assert.doesNotMatch(refs, /\*\*Decision\.\*\*/);
    assert.match(doc('why', 'D-01').out, /^\*\*Decision\.\*\* Photos upload once\.$/m);
    assert.match(doc('why', 'D-02', '--refs').out, /^NOT AMENDED$/m);
  });
});

test('P17: why answers every id it is given', () =>
  withCorpus({}, (doc) => {
    const out = doc('why', 'D-01', 'D-02').out;
    assert.match(out, /^=== why D-01 /m);
    assert.match(out, /^=== why D-02 /m);
  }));

test('P11: an indented heading fails the gate', () =>
  withCorpus(
    {
      'docs/EngineeringHandbook.md':
        BASE['docs/EngineeringHandbook.md'] + '\n  ## 3. Indented\n\nText.\n',
    },
    (doc) => failsWith(doc, 'indented-heading'),
  ));

test('P11: a setext heading fails the gate, and a rule after a blank line does not', () => {
  withCorpus(
    {
      'docs/EngineeringHandbook.md':
        BASE['docs/EngineeringHandbook.md'] + '\nA title\n---\n\nText.\n',
    },
    (doc) => failsWith(doc, 'setext-heading'),
  );
  withCorpus(
    {
      'docs/EngineeringHandbook.md':
        BASE['docs/EngineeringHandbook.md'] + '\nA paragraph.\n\n---\n\n- a list\n---\n',
    },
    passes,
  );
});

test('P11: a heading inside an HTML comment fails the gate and makes no section', () =>
  withCorpus(
    {
      'docs/EngineeringHandbook.md': BASE['docs/EngineeringHandbook.md'].replace(
        'Install the tools.',
        'Install the tools.\n\n<!--\n## 9. Hidden\n-->\n\nStill setup.',
      ),
    },
    (doc) => {
      failsWith(doc, 'heading-in-comment');
      assert.match(doc('hb', '§1').out, /Still setup\./);
      assert.match(doc('hb', '§9').out, /no chunk matches/);
    },
  ));

test('P17: a slice that depends on itself fails the gate', () =>
  withCorpus(
    { 'docs/WorkSlices.md': SLICES_HEAD + TABLE.replace('| U | S-01 |', '| U | S-01, S-02 |') },
    (doc) => failsWith(doc, 'slice-row', /S-02 depends on itself/),
  ));

test('P17: a sample row inside a fence is not a slice', () =>
  // Outside the fence this row would be a second S-01 and fail as a duplicate.
  withCorpus(
    {
      'docs/WorkSlices.md':
        SLICES_HEAD + TABLE + '\nA sample:\n\n```\n| S-01 | Sample | spec §1 | U | |\n```\n',
    },
    (doc) => {
      passes(doc);
      assert.match(doc('slice', 'S-01').out, /^\| S-01 \| First \|/m);
      assert.doesNotMatch(doc('slice', 'S-01').out, /Sample/);
    },
  ));

test('P17: a paragraph opening with a slice id that is not bold fails the gate', () => {
  withCorpus(
    { 'docs/WorkSlices.md': SLICES_HEAD + TABLE + '\nS-01 writes the first table.\n' },
    (doc) => failsWith(doc, 'slice-row', /opens with S-01 but not in bold/),
  );
  withCorpus(
    { 'docs/WorkSlices.md': SLICES_HEAD + TABLE + '\n**S-01 writes the first table.**\n' },
    (doc) => {
      passes(doc);
      assert.match(doc('slice', 'S-01').out, /S-01 writes the first table/);
      assert.doesNotMatch(
        doc('slice', 'S-02').out.split('--- S-01 ·')[0],
        /S-01 writes the first table/,
      );
    },
  );
});

test("P17: the one-hop list carries the citations of a printed section's children", () =>
  withCorpus({}, (doc) => {
    const brief = doc('slice', 'S-02').out;
    assert.match(brief, /^--- arch §1 · /m);
    assert.match(brief, /^one hop out: .*\bD-02\b/m);
  }));

test('P17: arch:1 in a doc is a citation, and a dangling one fails', () => {
  const hb = (ref) =>
    BASE['docs/EngineeringHandbook.md'].replace('Run the tests.', `Run the tests, see ${ref}.`);
  withCorpus({ 'docs/EngineeringHandbook.md': hb('arch:1') }, (doc) => {
    passes(doc);
    assert.match(doc('why', 'arch:1').out, /^ {2}hb {6}hb §2$/m);
  });
  withCorpus({ 'docs/EngineeringHandbook.md': hb('arch:9') }, (doc) =>
    failsWith(doc, 'dangling-citation', /"arch:9" resolves to nothing/),
  );
});

test('P17: a bare § does not inherit a prefix across a blank line', () =>
  withCorpus(
    {
      'docs/Idea.md': BASE['docs/Idea.md'].replace(
        'How a photo goes up.',
        'Read hb §2 first.\n\n§1 covers the rest.',
      ),
    },
    (doc) => {
      assert.match(doc('why', 'spec', '§1').out, /^ {2}idea {4}spec §2$/m);
      assert.doesNotMatch(doc('why', 'hb', '§1').out, /spec §2/);
    },
  ));

test('P4: a Codex agent copy has to match its Claude Code twin', () => {
  const md =
    '---\nname: helper\ndescription: Helps.\ntools: Read\n---\n\nRead `.claude/skills/slice/SKILL.md` first.\nThen stop.\n';
  const toml = (body) =>
    `name = "helper"\ndescription = "Helps."\ndeveloper_instructions = """\n${body}"""\n`;
  const same = toml('Read `.agents/skills/slice/SKILL.md` first.\nThen stop.');
  withCorpus({ '.claude/agents/helper.md': md, '.codex/agents/helper.toml': same }, passes);
  withCorpus(
    {
      '.claude/agents/helper.md': md,
      '.codex/agents/helper.toml': same.replace('Then stop.', 'Then go.'),
    },
    (doc) =>
      failsWith(doc, 'agent-drift', /line 2 of the instructions, which there reads "Then stop\."/),
  );
  withCorpus(
    {
      '.claude/agents/helper.md': md,
      '.codex/agents/other.toml': same.replace('"helper"', '"other"'),
    },
    (doc) => failsWith(doc, 'agent-drift', /has no .codex\/agents\/ twin/),
  );
});

test("the issue template's readiness rows match the Definition of done", () => {
  const dod =
    '\n## Definition of done\n\n**Ready for review**\n\n- [ ] **Schema.** zod.\n\n**Ready to merge**\n\n- [ ] **Review.** Approved.\n\n## Phase 1\n';
  const slices =
    SLICES_HEAD.replace('# Phase 1 — one', `${dod.replace('## Phase 1', '# Phase 1 — one')}`) +
    TABLE;
  const template = (rows) =>
    `## Readiness\n\n| Item | Result | Head | Evidence | By |\n|---|---|---|---|---|\n${rows.map((r) => `| ${r} | | | | |`).join('\n')}\n`;
  withCorpus(
    {
      'docs/WorkSlices.md': slices,
      '.github/ISSUE_TEMPLATE/slice.md': template(['Schema', 'Review']),
    },
    passes,
  );
  withCorpus(
    { 'docs/WorkSlices.md': slices, '.github/ISSUE_TEMPLATE/slice.md': template(['Schema']) },
    (doc) => failsWith(doc, 'readiness-rows'),
  );
});
