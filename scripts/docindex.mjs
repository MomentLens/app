// Parse docs/ into addressable chunks and resolve every cross-reference between them.
// Used by scripts/doc.mjs. Not run directly.
//
// Identity is derived, never authored: a chunk's id is its GitHub heading anchor, scoped by
// file. Section numbers (§4.11) are aliases computed from the heading, so renumbering a doc
// is a warning here rather than a rewrite of every citation in the repo.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file, not the shell's directory, so it works from anywhere in the repo.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const readDoc = (rel) => {
  const abs = join(root, ...rel.split('/'));
  try {
    // Line endings are normalised here and nowhere else. A stray \r reaching the fence
    // regex disables fence tracking for the whole file and the gate still passes.
    return readFileSync(abs, 'utf8')
      .split(/\r\n|\r/)
      .join('\n');
  } catch {
    throw new Error(`cannot read ${rel}. Expected it at ${abs}.`);
  }
};

// The only configuration. `prefixes` qualify a § citation as belonging to this file.
export const FILES = {
  idea: { path: 'docs/Idea.md', prefixes: ['spec', 'Spec', 'Idea.md'], label: 'spec', bare: true },
  hb: {
    path: 'docs/EngineeringHandbook.md',
    prefixes: ['EngineeringHandbook.md', 'EngineeringHandbook', 'Handbook', 'HB', 'hb'],
    label: 'hb',
  },
  dlog: { path: 'docs/DecisionLog.md', prefixes: [], label: 'dlog' },
  arch: {
    path: 'docs/ARCHITECTURE.md',
    prefixes: ['ARCHITECTURE.md', 'ARCHITECTURE', 'arch'],
    label: 'arch',
  },
  slices: { path: 'docs/WorkSlices.md', prefixes: [], label: 'slices' },
};

// Scanned for citations so `doc why` reports the whole blast radius. Not chunked.
// Code counts: apps/api/eslint.config.mjs bans sharp and jimp citing D-57, and reopening
// D-57 means changing that rule. Listing only the AGENTS.md files missed it.
const SOURCE_DIRS = [
  'apps',
  'packages',
  'worker',
  'e2e',
  'scripts',
  'supabase',
  '.github',
  '.claude',
];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py|sh|sql|md|ya?ml)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', '.venv', '.expo', 'coverage', 'docs']);

const walk = (rel, out = []) => {
  let entries;
  try {
    entries = readdirSync(join(root, ...rel.split('/')), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.claude') continue;
    const next = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(next, out);
    } else if (SOURCE_EXT.test(e.name)) out.push(next);
  }
  return out;
};

// Every file an agent follows as instructions. A dangling citation in any of them sends the
// agent to a section that is not there. Codex reads its own copies of the two slice agents,
// and those had drifted from Claude Code's with nothing checking them.
const listed = (dir, ext) => {
  try {
    return readdirSync(join(root, ...dir.split('/')))
      .filter((f) => f.endsWith(ext))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
};
const GATED = new Set([
  'AGENTS.md',
  'apps/api/AGENTS.md',
  'apps/mobile/AGENTS.md',
  'worker/AGENTS.md',
  '.claude/skills/slice/SKILL.md',
  '.github/ISSUE_TEMPLATE/slice.md',
  '.github/pull_request_template.md',
  ...listed('.claude/agents', '.md'),
  ...listed('.codex/agents', '.toml'),
]);
// The two retrieval scripts and their tests cite D-57 and §4.11 as usage examples or
// fixtures, so scanning them puts this tool in the blast radius of decisions it does not
// depend on.
const SELF = /^scripts\/doc(index)?(\.test)?\.mjs$/;
// Only `doc why` needs the code backlinks, and walking the tree for them costs more than
// parsing all five docs. Everything else reads only the gated files that route to the docs.
const sources = (wide) =>
  wide
    ? [
        ...GATED,
        ...SOURCE_DIRS.flatMap((d) => walk(d)).filter((f) => !SELF.test(f) && !GATED.has(f)),
      ]
    : [...GATED];

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const D_HEAD = /^(D-\d+)\s*[—:–-]\s*(.+)$/; // older entries use an em dash, newer a colon
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;
const ROW = /^\|\s*\*{0,2}(S-\d+[a-z]?|P0-\d+)\*{0,2}\s*\|\s*(.+?)\s*\|/;
const ABSTRACT = /^[ \t]*<!--\s*abstract:\s*([\s\S]*?)-->/m;

// GitHub's anchor algorithm. "2.5 Navigation & screen architecture" becomes
// "25-navigation--screen-architecture", double hyphen included, which is what Idea.md's
// hand-written table of contents already links to.
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

// An agent decides what to read from these numbers, so a biased estimate has a cost.
// length/4 ran 7.4% high overall and put only 38% of chunks within 10% of the truth: it
// over-counts prose by up to a third and under-counts tables by 40%. Fitted against
// cl100k_base over the 300 chunks the corpus had on 2026-09-21, word and punctuation counts land 85%
// within 10% and the corpus total within 0.1%. Still an estimate, still no dependency.
export const tokens = (t) =>
  Math.ceil(1.18 * (t.match(/\S+/g)?.length ?? 0) + 0.59 * (t.match(/[^\w\s]/g)?.length ?? 0));
const posix = (p) => p.split('\\').join('/');
const plain = (t) =>
  t
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .trim();

// Accumulate whole sentences until there is enough of one to be useful. The guard stops
// "§4.8 Stage 1" reading as a sentence end, which starts the summary mid-word at "8 Stage 1".
const sentence = (text, min = 40) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  // A period with no space after it never ends a sentence: 4.11, health_check.sql, e.g.
  // Guarding only decimals left `arch/health_check` summarised as "... not a feature table. sql."
  const guarded = flat.replace(/\.(?=[A-Za-z0-9])/g, '\u0000');
  let out = '';
  for (const m of guarded.matchAll(/[^.!?]*[.!?]+(?:\s|$)/g)) {
    out += m[0];
    if (out.trim().length >= min) break;
  }
  out = (out.trim() || guarded).split('\u0000').join('.');
  return out.length > 220 ? out.slice(0, 217).trimEnd() + '...' : out;
};

// Three heading forms a renderer shows as headings and the parser cannot see. Each one either
// merges a section into the one above it or, inside a comment, invents a section nobody sees.
const INDENTED_HEADING = /^ {1,3}#{1,6}(\s|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// A line a setext underline cannot follow and still make a heading: blank, a heading, a table
// row, a quote, a list item, an HTML line, or another rule.
const NOT_PARAGRAPH = /^\s*$|^ {0,3}(#|\||>|[-*+]\s|\d+[.)]\s|<|=+[ \t]*$|-+[ \t]*$)/;

// Headings, with fence and comment state respected. A shell comment inside a fenced block is
// exactly what `grep -n '^#'` reads as an H1. `code` marks every line inside a fence or an
// HTML comment, fence lines included, so the slice-row and note scans skip what a reader
// never sees as prose: a sample row in a fenced example used to become a real slice.
const headings = (lines) => {
  const out = [];
  const stray = [];
  const bad = [];
  const code = new Array(lines.length).fill(false);
  // Fences pair from the top, so one stray fence flips every pair after it and the scan ends
  // on an innocent fence far below. The first block that swallows a numbered heading is
  // where the pairing went wrong.
  let suspect = null;
  let fence = null;
  let comment = null;
  lines.forEach((line, i) => {
    if (comment === null) {
      const f = line.match(FENCE);
      if (f) {
        code[i] = true;
        const indent = f[1].length;
        const mark = f[2][0];
        const len = f[2].length;
        // Four spaces turn a fence into code. Inside an open block a shorter run is ordinary
        // content, which is how a ``` example sits inside a ````markdown block. Anything else
        // is a fence someone indented by accident, and it reshapes the document in silence:
        // an indented opener leaves every `#` in the block looking like a heading.
        if (indent > 3) {
          if (fence === null || (mark === fence.mark && len >= fence.len))
            stray.push({ line: i + 1, indent, openedAt: fence && fence.line });
          return;
        }
        // A closer is the same character, at least as long, and carries no info string.
        // A three-long closer ending a four-long opener silently truncates the section.
        if (fence === null) fence = { mark, len, line: i + 1 };
        else if (mark === fence.mark && len >= fence.len && !f[3].trim()) fence = null;
        return;
      }
      if (fence !== null) {
        code[i] = true;
        if (!suspect && /^#{1,6}\s+\d+(\.\d+)*\.?\s/.test(line))
          suspect = { line: fence.line, heading: i + 1 };
        return;
      }
    }
    // An HTML comment that does not close on its own line hides everything up to its `-->`.
    // A heading in there used to become a section, splitting the body of the one above it.
    if (comment !== null) {
      code[i] = true;
      if (HEADING.test(line.trimStart()))
        bad.push({ code: 'heading-in-comment', line: i + 1, openedAt: comment });
      if (line.includes('-->')) comment = null;
      return;
    }
    const open = line.lastIndexOf('<!--');
    if (open !== -1 && !line.slice(open).includes('-->')) {
      code[i] = true;
      comment = i + 1;
      return;
    }
    if (INDENTED_HEADING.test(line)) bad.push({ code: 'indented-heading', line: i + 1 });
    else if (SETEXT.test(line) && i > 0 && !code[i - 1] && !NOT_PARAGRAPH.test(lines[i - 1]))
      bad.push({ code: 'setext-heading', line: i + 1 });
    const h = line.match(HEADING);
    if (h) out.push({ level: h[1].length, title: h[2], line: i + 1 });
  });
  return { out, open: fence, stray, suspect, bad, code, comment };
};

// Derived from the body wherever possible, so almost nothing here is an authoring job.
const abstractOf = (c) => {
  const body = c.selfBody;
  const explicit = body.match(ABSTRACT);
  if (explicit?.[1].trim()) return [explicit[1].replace(/\s+/g, ' ').trim(), 'explicit'];
  if (c.file === 'dlog') {
    const d = body.match(/^\*\*Decision\.\*\*\s*(.+)$/m);
    if (d) return [sentence(plain(d[1])), 'decision'];
  }
  if (c.flags.includes('row')) return [c.title, 'title'];
  for (const line of body.split('\n').slice(1)) {
    const t = line.trim();
    if (!t || t.startsWith('<!--')) continue;
    // A body opening with a subheading has no summary of its own and does not need one.
    if (/^#/.test(t) || FENCE.test(line)) break;
    const item = t.match(/^[-*+]\s+(.+)$/) || t.match(/^\d+\.\s+(.+)$/);
    if (item) return [sentence(plain(item[1])), 'first-item'];
    if (/^[|>]/.test(t)) break;
    return [sentence(plain(t)), 'first-sentence'];
  }
  return [c.title, 'title'];
};

const parse = (key, text) => {
  const cfg = FILES[key];
  const lines = text.split('\n');
  const { out: heads, open, stray, suspect, bad, code, comment } = headings(lines);
  const chunks = [];
  // A note header naming a slice that does not exist is a typo that drops the note.
  const notesBad = [];
  // A | inside a cell shifts every column after it, and the brief silently loses its
  // dependency rows. Phase 0's table has three cells, every other slice table five.
  const rowsBad = [];

  for (const h of heads) {
    const title = plain(h.title);
    const c = { file: key, level: h.level, title, line: h.line, aliases: [], flags: [] };
    const d = title.match(D_HEAD);
    const n = title.match(NUMBERED);
    if (key === 'dlog' && d) {
      c.key = d[1];
      c.title = d[2];
      c.aliases.push(d[1]);
    } else if (n) {
      c.number = n[1];
      c.title = n[2];
      c.aliases.push(`§${n[1]}`);
      for (const pre of cfg.prefixes) c.aliases.push(`${pre} §${n[1]}`);
    }
    c.slug = `${key}/${slug(h.title)}`;
    chunks.push(c);
  }

  // span runs to the next heading at the same or shallower level; selfSpan stops at the
  // first child, so a parent can report how little of it is its own body.
  chunks.forEach((c, i) => {
    let end = lines.length;
    let selfEnd = lines.length;
    for (let j = i + 1; j < chunks.length; j++) {
      if (selfEnd === lines.length) selfEnd = chunks[j].line - 1;
      if (chunks[j].level <= c.level) {
        end = chunks[j].line - 1;
        break;
      }
    }
    c.span = { start: c.line, end };
    c.selfSpan = { start: c.line, end: Math.min(selfEnd, end) };
    c.selfBody = lines.slice(c.line - 1, c.selfSpan.end).join('\n');
    c.tokens = tokens(lines.slice(c.line - 1, end).join('\n'));
    c.selfTokens = tokens(c.selfBody);
    c.children = [];
    // Citations are read per segment, each carrying the file line its first line sits on.
    // Stripping text before scanning would shift every line number reported after it.
    c.segments = [{ text: c.selfBody, from: c.selfSpan.start }];
  });
  chunks.forEach((c, i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (chunks[j].level < c.level) {
        c.parent = chunks[j].slug;
        chunks[j].children.push(c.slug);
        break;
      }
    }
  });

  // WorkSlices.md keeps its records in table rows and its warnings in prose beneath the
  // table. Both are needed: for S-04 the warning is the point of the row.
  if (key === 'slices') {
    const rows = [];
    lines.forEach((line, i) => {
      if (code[i]) return;
      const m = line.match(ROW);
      if (!m || m[1] === 'ID') return;
      const cells = line.split('|').slice(1, -1);
      const want = m[1].startsWith('P0') ? 3 : 5;
      if (cells.length !== want)
        rowsBad.push({
          line: i + 1,
          msg: `${m[1]} has ${cells.length} cells and a row in its table has ${want}. A | inside a cell shifts the Depends on column; take it out`,
        });
      else if (want === 5) {
        const other = cells[4].replace(/\b(S-\d+[a-z]?|P0-\d+)\b/g, '').replace(/[,\s]/g, '');
        if (other)
          rowsBad.push({
            line: i + 1,
            msg: `${m[1]}'s Depends on cell holds "${cells[4].trim()}". It takes slice ids only, because the brief prints exactly those rows`,
          });
      }
      const c = {
        file: key,
        level: 9,
        key: m[1],
        title: plain(m[2]),
        aliases: [m[1]],
        flags: ['row'],
        slug: `slices/${m[1].toLowerCase()}`,
        line: i + 1,
        span: { start: i + 1, end: i + 1 },
        selfSpan: { start: i + 1, end: i + 1 },
        selfBody: line,
        tokens: tokens(line),
        selfTokens: tokens(line),
        children: [],
        notes: [],
        // The "Depends on" cell, the fifth. A brief prints these rows in full; a slice that a
        // row or note merely mentions goes one hop out. Phase 0's three-column table has none.
        deps: [...(line.split('|')[5] ?? '').matchAll(/\b(S-\d+[a-z]?|P0-\d+)\b/g)].map(
          (d) => d[1],
        ),
        segments: [{ text: line, from: i + 1 }],
      };
      rows.push(c);
      chunks.push(c);
    });

    // Every note in this file is written the same way: the paragraph opens with the id
    // in bold. Match exactly that, because the looser rule this replaces counted the ids
    // anywhere on the first line and required there to be only one, so editing a note to
    // mention a second slice silently detached it from the first.
    const NOTE = /^\*\*(S-\d+[a-z]?|P0-\d+)\b/;
    const byKey = new Map(rows.map((c) => [c.key, c]));

    // The phases run in file order, so a dependency listed below its slice is either later
    // in the same table or in a later phase, and the table no longer reads in build order.
    // An id with no row at all is the dangling-citation check's.
    for (const c of rows)
      for (const d of c.deps) {
        const dep = byKey.get(d);
        if (d === c.key)
          rowsBad.push({
            line: c.line,
            msg: `${c.key} depends on itself, so its dependency check waits on its own open issue. Take ${c.key} out of its Depends on cell`,
          });
        else if (dep && dep.line > c.line)
          rowsBad.push({
            line: c.line,
            msg: `${c.key} depends on ${d}, which is listed below it at line ${dep.line}. Move ${c.key} below it so the table reads in build order`,
          });
      }
    // A paragraph that opens with a slice id in anything but bold is not a note, so it stays
    // in the phase's prose and prints in the brief of every slice in the phase as if it were
    // an instruction to all of them.
    const UNBOLD = /^[*_]{0,3}(S-\d+[a-z]?|P0-\d+)\b/;
    let para = null;
    let inBlock = false;
    lines.forEach((line, i) => {
      if (code[i] || !line.trim() || line.startsWith('|') || line.startsWith('#')) {
        para = null;
        inBlock = false;
        return;
      }
      if (para) {
        para.end = i + 1;
        para.lines.push(line);
        return;
      }
      // Only the first line of a block decides. Restarting on the second line made a
      // hard-wrapped note attach without its subject, and a bullet's continuation line
      // attach as if it were a note.
      if (inBlock) return;
      inBlock = true;
      const m = line.match(NOTE);
      if (!m) {
        const u = line.match(UNBOLD);
        if (u)
          rowsBad.push({
            line: i + 1,
            msg: `this paragraph opens with ${u[1]} but not in bold, so it is not ${u[1]}'s note and every brief in the phase prints it. Write **${u[1]} in bold, or open the paragraph with another word`,
          });
        return;
      }
      if (!byKey.has(m[1])) return (notesBad.push({ line: i + 1, key: m[1] }), undefined);
      para = { start: i + 1, end: i + 1, lines: [line] };
      const c = byKey.get(m[1]);
      c.attached = c.attached || [];
      c.attached.push(para);
    });
    for (const c of rows) {
      if (!c.attached) continue;
      c.notes = c.attached.map((p) => ({ start: p.start, end: p.end }));
      // Citations in a note become the slice's own edges, so D-88 reaches S-04.
      c.selfBody += '\n' + c.attached.map((p) => p.lines.join('\n')).join('\n');
      c.tokens = c.selfTokens = tokens(c.selfBody);
      for (const p of c.attached) c.segments.push({ text: p.lines.join('\n'), from: p.start });
      delete c.attached;
    }

    // A row and its warning paragraph also sit inside a phase heading's body. Blank those
    // lines out of the heading rather than deleting them: the row already owns the edge,
    // and counting it twice inflates every `doc why` answer.
    const owned = new Set();
    for (const c of rows) {
      owned.add(c.line);
      for (const n of c.notes) for (let l = n.start; l <= n.end; l++) owned.add(l);
    }
    for (const c of chunks) {
      if (c.flags.includes('row')) continue;
      const kept = c.selfBody.split('\n').map((l, i) => (owned.has(c.selfSpan.start + i) ? '' : l));
      c.segments = [{ text: kept.join('\n'), from: c.selfSpan.start }];
    }
  }

  for (const c of chunks) {
    const [abstract, source] = abstractOf(c);
    c.abstract = abstract;
    c.abstractSource = source;
    // A void entry is retired as surely as a superseded one. D-48's heading says "VOID, see
    // D-58", which this used to miss, so D-48 printed with no warning and could be expanded.
    const retired = c.title.match(/\b(SUPERSEDED by|VOID, see) (D-\d+)/i);
    if (retired) {
      c.flags.push('superseded');
      c.supersededBy = retired[2];
      c.retiredAs = /^void/i.test(retired[1]) ? 'VOID, SEE' : 'SUPERSEDED BY';
    }
    if (c.title.includes('⚠')) c.flags.push('risk');
    c.path = posix(cfg.path);
    c.display = c.key || (c.number ? `${cfg.label} §${c.number}` : null);
    if (c.display && !c.aliases.includes(c.display)) c.aliases.push(c.display);
    c.cites = [];
    c.citedBy = [];
  }
  return { chunks, open, stray, suspect, notesBad, rowsBad, bad, comment, lines };
};

const PREFIXES = Object.entries(FILES).flatMap(([k, c]) => c.prefixes.map((p) => [p, k]));
const SECTION = new RegExp(
  `(?:\`?\\b(${PREFIXES.map(([p]) => p.replace(/\./g, '\\.')).join('|')})\`?\\s*)?§(\\d+(?:\\.\\d+)*)`,
  // Case-insensitive: `handbook §7` silently resolved to the spec's §7, because the
  // prefix missed and the bare number fell through to the default document.
  'gi',
);

// "Handbook §5 and §7" elides the prefix on the second citation. A bare §n inherits the
// nearest qualified one within 60 characters of the same paragraph, then falls back to its own
// file, then the spec. A blank line ends the inheritance, because a prefix at the end of one
// paragraph says nothing about a § opening the next.
// Most § citations in docs/ carry no prefix and resolve by that fallback, so it is
// convention, not a guess, and the gate does not flag it. Some name a number that exists in
// more than one document. The limit: in "Handbook §5, plus §2 of the spec" the bare
// §2 inherits `hb` from six words earlier and the trailing qualifier is not read.
// ARCHITECTURE.md's 17 table entries carry no section number, so nothing could cite one and
// a row wanting `venue_verification` had to cite arch §2 and get a 17-item menu. `arch:slug`
// is the form doc.mjs already accepts on the command line.
const LABELS = Object.entries(FILES).flatMap(([k, f]) =>
  [k, f.label].filter(Boolean).map((n) => [n, k]),
);
const SLUGREF = new RegExp(`\\b(${LABELS.map(([n]) => n).join('|')}):([a-z][a-z0-9_-]*)\\b`, 'g');
// `doc arch:3` reads as arch §3 on the command line, so a doc writing arch:3 means the same.
// The scanner used to need a letter after the colon and skipped it, so a dangling one passed.
const NUMREF = new RegExp(`\\b(${LABELS.map(([n]) => n).join('|')}):(\\d+(?:\\.\\d+)*)\\b`, 'g');

// A Decision line names what it changes with a verb, then a list that runs to the next verb,
// semicolon or sentence end.
const VERB_CLAUSE =
  /\b(amends|supersedes|voids)\b(.*?)(?=;|\b(?:amends|supersedes|voids|keeps|replaces|specifies|settles)\b|$)/gi;
// The ids an entry's "Amended (see D-nn)" lines name. doc.mjs prints these lines first.
export const AMENDED = /^\*\*Amended \(see ([^)]*)\)\.?\*\*/;
const amendedBy = (c) =>
  c.selfBody
    .split('\n')
    .map((l) => l.match(AMENDED))
    .filter(Boolean)
    .flatMap((m) => m[1].match(/\bD-\d+\b/g) ?? []);

const citations = (text) => {
  const clean = text;
  const out = [];
  const secs = [...clean.matchAll(SECTION)].map((m) => ({
    at: m.index,
    surface: m[0].trim(),
    number: m[2],
    hint: m[1] ? PREFIXES.find(([p]) => p.toLowerCase() === m[1].toLowerCase())[1] : null,
  }));
  secs.forEach((s, i) => {
    let hint = s.hint;
    if (!hint)
      for (let j = i - 1; j >= 0; j--) {
        if (!secs[j].hint) continue;
        if (s.at - secs[j].at <= 60 && !/\n[ \t]*\n/.test(clean.slice(secs[j].at, s.at)))
          hint = secs[j].hint;
        break;
      }
    out.push({
      kind: 'section',
      surface: s.surface,
      number: s.number,
      hint,
      at: s.at,
      explicit: !!s.hint,
    });
  });
  for (const m of clean.matchAll(/\bD-\d+\b/g))
    out.push({ kind: 'key', surface: m[0], key: m[0], at: m.index });
  for (const m of clean.matchAll(/\b(S-\d+[a-z]?|P0-\d+)\b/g))
    out.push({ kind: 'key', surface: m[0], key: m[1], at: m.index });
  for (const m of clean.matchAll(SLUGREF))
    out.push({
      kind: 'slug',
      surface: m[0],
      slug: `${LABELS.find(([n]) => n === m[1])[1]}/${m[2]}`,
      at: m.index,
    });
  for (const m of clean.matchAll(NUMREF))
    out.push({
      kind: 'section',
      surface: m[0],
      number: m[2],
      hint: LABELS.find(([n]) => n === m[1])[1],
      at: m.index,
      explicit: true,
    });
  return out;
};

export const buildIndex = ({ wide = false } = {}) => {
  const chunks = new Map();
  const byNumber = {};
  const byKey = new Map();
  // Corpus-wide: `docs/DecisionLog.md` is merge=union, so two branches each appending D-81
  // is the expected collision, and the second would be unreachable forever.
  const seenKey = new Map();
  const docs = {};
  const errors = [];

  for (const [key, cfg] of Object.entries(FILES)) {
    const text = readDoc(cfg.path);
    const p = parse(key, text);
    docs[key] = { path: posix(cfg.path), ...p };
    byNumber[key] = {};
    for (const t of p.bad)
      errors.push({
        code: t.code,
        file: posix(cfg.path),
        line: t.line,
        msg: {
          'heading-in-comment': `this heading sits inside the HTML comment opened at line ${t.openedAt}, so no reader sees it and it splits the section above it; move it out of the comment or drop its #`,
          'indented-heading':
            'this heading is indented, so a renderer shows it and the parser does not, and its text joins the section above; take out the leading spaces',
          'setext-heading':
            'this line underlines the one above it, which makes that line a heading the parser cannot see; leave a blank line above it, or write the heading with #',
        }[t.code],
      });
    if (p.comment !== null)
      errors.push({
        code: 'unclosed-comment',
        file: posix(cfg.path),
        line: p.comment,
        msg: 'this HTML comment never closes, so it hides the rest of the file; close it with -->',
      });
    for (const t of p.notesBad)
      errors.push({
        code: 'orphan-note',
        file: posix(cfg.path),
        line: t.line,
        msg: `this paragraph opens "**${t.key}" but there is no such slice, so the note reaches no brief`,
      });
    for (const t of p.rowsBad)
      errors.push({ code: 'slice-row', file: posix(cfg.path), line: t.line, msg: t.msg });
    for (const t of p.stray)
      errors.push({
        code: 'fence-indent',
        file: posix(cfg.path),
        line: t.line,
        msg: t.openedAt
          ? `this fence is indented ${t.indent} spaces, so it is code and does not close the block opened at line ${t.openedAt}; unindent it`
          : `this fence is indented ${t.indent} spaces, so it opens a block the parser cannot see and every # below it reads as a heading; unindent it`,
      });
    if (p.open)
      errors.push({
        code: 'unbalanced-fence',
        file: posix(cfg.path),
        line: p.open.line,
        msg:
          `the ${p.open.mark.repeat(p.open.len)} fence opened here never closes` +
          (p.suspect
            ? `. Fences pair from the top, so look earlier: the block opened at line ${p.suspect.line} swallows the heading at line ${p.suspect.heading}, so that fence is probably the stray one`
            : ''),
      });

    const seenSlug = new Map();
    const seenNum = new Map();
    for (const c of p.chunks) {
      if (seenSlug.has(c.slug))
        errors.push({
          code: 'duplicate-slug',
          file: c.path,
          line: c.line,
          msg: `"${c.slug}" also at line ${seenSlug.get(c.slug)}`,
        });
      else seenSlug.set(c.slug, c.line);
      if (c.number) {
        if (seenNum.has(c.number))
          errors.push({
            code: 'duplicate-section-number',
            file: c.path,
            line: c.line,
            msg: `§${c.number} is also a heading at line ${seenNum.get(c.number)}; citations to it resolve to one of them`,
          });
        else seenNum.set(c.number, c.line);
        byNumber[key][c.number] = c.slug;
      }
      if (key === 'dlog' && !c.key && /^D-\d+\b/.test(c.title))
        errors.push({
          code: 'unparsed-decision',
          file: c.path,
          line: c.line,
          msg: `"${c.title}" is a heading but not a decision: put an em dash or a colon between the id and the title, or nothing can cite it`,
        });
      if (c.key) {
        if (seenKey.has(c.key)) {
          const was = seenKey.get(c.key);
          errors.push({
            code: 'duplicate-id',
            file: c.path,
            line: c.line,
            msg: `${c.key} is also defined at ${was.file}:${was.line}; every citation to it resolves to one of them`,
          });
        } else {
          seenKey.set(c.key, { file: c.path, line: c.line });
          byKey.set(c.key, c.slug);
        }
      }
      chunks.set(c.slug, c);
    }
  }

  // A written-out prefix is an assertion about which document, so it never falls through.
  // It used to: renumber ARCHITECTURE.md's §3 and every `arch §3` citation silently became
  // the spec's §3, handing S-12 the event lifecycle where it asked for the R2 key formats,
  // with a green gate. An inherited prefix is a guess, so that one may still fall back.
  const target = (cit, from) =>
    cit.kind === 'slug'
      ? chunks.has(cit.slug)
        ? cit.slug
        : null
      : cit.kind === 'key'
        ? byKey.get(cit.key) || null
        : cit.explicit
          ? byNumber[cit.hint]?.[cit.number] || null
          : [cit.hint, from, 'idea'].reduce(
              (hit, k) => hit || (k && byNumber[k]?.[cit.number]) || null,
              null,
            );

  const lineAt = (text, at, offset) => offset + text.slice(0, at).split('\n').length - 1;

  for (const [key, doc] of Object.entries(docs)) {
    for (const c of doc.chunks) {
      for (const seg of c.segments) {
        for (const cit of citations(seg.text)) {
          const to = target(cit, key);
          if (!to) {
            errors.push({
              code: 'dangling-citation',
              file: doc.path,
              line: lineAt(seg.text, cit.at, seg.from),
              msg: `"${cit.surface}" resolves to nothing`,
            });
            continue;
          }
          if (to === c.slug) continue;
          if (!c.cites.includes(to)) c.cites.push(to);
          const t = chunks.get(to);
          if (t && !t.citedBy.includes(c.slug)) t.citedBy.push(c.slug);
        }
      }
    }
  }

  for (const rel of sources(wide)) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const cit of citations(text)) {
      const to = target(cit, null);
      if (!to) {
        if (GATED.has(posix(rel)))
          errors.push({
            code: 'dangling-citation',
            file: posix(rel),
            line: lineAt(text, cit.at, 1),
            msg: `"${cit.surface}" resolves to nothing`,
          });
        continue;
      }
      const t = chunks.get(to);
      if (t && !t.citedBy.includes(posix(rel))) t.citedBy.push(posix(rel));
    }
  }

  // An entry that amends an older one has to say so in the older one too, because a brief
  // prints the older entry and not the newer. D-141 amended D-109 and D-129 and neither said so,
  // so S-25's brief printed D-129 with no sign that D-141 had changed it. Only ids after the
  // verb count: "Supersedes D-50 and D-51 and amends D-38" is two lists, and "keeps D-119's
  // header" is not an amendment. A retired entry's lines live in git history, so it needs none.
  for (const c of chunks.values()) {
    if (c.file !== 'dlog' || !c.key) continue;
    const decision = c.selfBody.match(/^\*\*Decision\.\*\*(.*)$/m);
    if (!decision) continue;
    const first = decision[1].split(/\.(?=\s|$)/)[0];
    for (const clause of first.matchAll(VERB_CLAUSE)) {
      const verb = clause[1].toLowerCase();
      for (const [id] of clause[2].matchAll(/\bD-\d+\b/g)) {
        const t = chunks.get(byKey.get(id));
        if (!t || t.flags.includes('superseded')) continue;
        if (verb === 'amends' && amendedBy(t).includes(c.key)) continue;
        errors.push({
          code: 'missing-backlink',
          file: t.path,
          line: t.line,
          msg:
            verb === 'amends'
              ? `${c.key} amends ${id}, but ${id} has no "Amended (see ${c.key})" line. Add one saying what ${c.key} changed in ${id}`
              : `${c.key} ${verb} ${id}, but ${id}'s heading does not say ~~(${verb === 'voids' ? 'VOID, see' : 'SUPERSEDED by'} ${c.key})~~`,
        });
      }
    }
  }

  const byAlias = {};
  for (const c of chunks.values())
    for (const a of c.aliases) {
      if (!(a in byAlias)) byAlias[a] = c.slug;
      const low = a.toLowerCase();
      if (!(low in byAlias)) byAlias[low] = c.slug;
    }

  // Every numbered leaf section of the spec is either reachable from a slice or named
  // somewhere in WorkSlices.md. A section nothing points at is behaviour nobody is assigned
  // to build, and an agent asked to build around it invents it instead. spec §5, the whole
  // of the error handling, had zero inbound citations when this check was written.
  // A section whose children are all unnumbered, like spec §9's three beats, counts as a leaf:
  // nothing can cite those children, so the section itself needs an owner.
  for (const c of chunks.values()) {
    if (c.file !== 'idea' || !c.number || c.children.some((k) => chunks.get(k).number)) continue;
    let seen = false;
    for (let x = c; x && !seen; x = x.parent ? chunks.get(x.parent) : null)
      seen = x.citedBy.some((b) => chunks.get(b)?.file === 'slices');
    if (!seen)
      errors.push({
        code: 'uncovered-spec',
        file: c.path,
        line: c.line,
        msg: `nothing in docs/WorkSlices.md points at §${c.number}; give it a slice, or name it under "Spec coverage" and say why not`,
      });
  }

  const broken = errors.some((e) => e.code === 'unbalanced-fence' || e.code === 'fence-indent');
  return {
    chunks: Object.fromEntries(chunks),
    byAlias,
    errors: broken ? errors.filter((e) => e.code !== 'dangling-citation') : errors,
    stats: {
      chunks: chunks.size,
      citations: [...chunks.values()].reduce((n, c) => n + c.citedBy.length, 0),
    },
  };
};
