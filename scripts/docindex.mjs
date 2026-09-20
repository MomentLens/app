// Parse docs/ into addressable chunks and resolve every cross-reference between them.
//
//   node scripts/docindex.mjs --report    diagnostics, writes nothing but the cache
//   import { buildIndex } from './docindex.mjs'
//
// Identity is derived, never authored: a chunk's id is its GitHub heading anchor, scoped by
// file. Section numbers (§4.11) are aliases computed from the heading, so renumbering a doc
// is a warning here rather than a rewrite of every citation in the repo.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();

// The only configuration. `prefixes` are the words that qualify a § citation as belonging to
// this file; `bareSection` is the file a §n with no qualifier falls back to.
export const FILES = {
  idea: { path: 'docs/Idea.md', prefixes: ['spec', 'Spec'], bareSection: true, label: 'spec' },
  hb: { path: 'docs/EngineeringHandbook.md', prefixes: ['Handbook', 'HB', 'hb'], label: 'hb' },
  dlog: { path: 'docs/DecisionLog.md', prefixes: [], label: 'dlog' },
  arch: {
    path: 'docs/ARCHITECTURE.md',
    prefixes: ['ARCHITECTURE.md', 'ARCHITECTURE', 'arch'],
    label: 'arch',
  },
  slices: { path: 'docs/WorkSlices.md', prefixes: [], label: 'slices' },
};

// Scanned for citations so backlinks are complete, but not chunked. A `doc why` that misses
// these under-reports the blast radius, which is the one thing that verb exists to get right.
export const CITATION_SOURCES = [
  'CLAUDE.md',
  'apps/api/CLAUDE.md',
  'apps/mobile/CLAUDE.md',
  'worker/CLAUDE.md',
  '.claude/skills/slice/SKILL.md',
  '.github/ISSUE_TEMPLATE/slice.md',
];

// --- text helpers -------------------------------------------------------------------------

// GitHub's anchor algorithm: lowercase, drop everything outside [\w\s-], spaces to hyphens.
// "2.5 Navigation & screen architecture" -> "25-navigation--screen-architecture", double
// hyphen included, which is what Idea.md's hand-written table of contents already links to.
export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Rough, and only ever used for comparison against other chunks in this same corpus.
const tokens = (text) => Math.ceil(text.length / 4);

const toPosix = (p) => p.split('\\').join('/');

// Accumulate whole sentences until there is enough of one to be a useful summary. A bare
// "Supersedes D-71." tells the reader nothing on its own.
const firstSentence = (text, minLen = 40) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Guard the dot inside a section number or a decimal, or "§4.8 Stage 1" reads as a
  // sentence boundary and the abstract starts mid-word at "8 Stage 1)".
  const guarded = flat.replace(/(\d)\.(\d)/g, '$1\u0000$2');
  let out = '';
  const re = /[^.!?]*[.!?]+(?:\s|$)/g;
  let m;
  while ((m = re.exec(guarded)) !== null) {
    out += m[0];
    if (out.trim().length >= minLen) break;
  }
  out = (out.trim() || guarded).split('\u0000').join('.');
  return out.length > 240 ? out.slice(0, 237).trimEnd() + '...' : out;
};

const stripInline = (text) =>
  text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .trim();

// --- parsing ------------------------------------------------------------------------------

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const D_HEADING = /^(D-\d+)\s*[—:–-]\s*(.+)$/; // 68 entries use an em dash, 11 a colon (D-73+)
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;
const SLICE_ROW = /^\|\s*\*{0,2}(S-\d+[a-z]?|P0-\d+)\*{0,2}\s*\|\s*(.+?)\s*\|/;

// Returns the heading lines of a file with fence state respected. EngineeringHandbook.md:532
// is `# worker only if something under worker/ changed:` inside a fenced block; the recipe in
// root CLAUDE.md reads it as an H1 today, which is the bug this function exists to not repeat.
const scanLines = (lines) => {
  const headings = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trimStart().startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = line.match(HEADING);
    if (h) headings.push({ level: h[1].length, title: h[2], line: i + 1 });
  });
  return { headings, fenceOpen: fence !== null };
};

const parseDoc = (key, text) => {
  const cfg = FILES[key];
  const lines = text.split('\n');
  const { headings, fenceOpen } = scanLines(lines);
  const chunks = [];

  for (const h of headings) {
    const title = stripInline(h.title);
    const chunk = {
      file: key,
      level: h.level,
      title,
      headingLine: h.line,
      aliases: [],
      flags: [],
    };

    const d = title.match(D_HEADING);
    const n = title.match(NUMBERED);
    if (key === 'dlog' && d) {
      chunk.key = d[1];
      chunk.title = d[2];
      chunk.aliases.push(d[1]);
    } else if (n) {
      chunk.number = n[1];
      chunk.title = n[2];
      chunk.aliases.push(`§${n[1]}`);
      if (cfg.prefixes[0]) chunk.aliases.push(`${cfg.prefixes[0]} §${n[1]}`);
    }
    chunk.slug = `${key}/${slugify(h.title)}`;
    chunks.push(chunk);
  }

  // A chunk's span runs to the next heading at the same or shallower level; its self_span
  // stops at the first child. §4.11's own body is 62 bytes of preamble over four children,
  // which is what lets `doc explain` say "take a child, not the parent".
  chunks.forEach((c, i) => {
    let end = lines.length;
    let selfEnd = lines.length;
    for (let j = i + 1; j < chunks.length; j++) {
      if (selfEnd === lines.length) selfEnd = chunks[j].headingLine - 1;
      if (chunks[j].level <= c.level) {
        end = chunks[j].headingLine - 1;
        break;
      }
    }
    c.span = { start: c.headingLine, end };
    c.selfSpan = { start: c.headingLine, end: Math.min(selfEnd, end) };
    c.body = lines.slice(c.headingLine - 1, end).join('\n');
    c.selfBody = lines.slice(c.headingLine - 1, c.selfSpan.end).join('\n');
    c.tokens = tokens(c.body);
    c.selfTokens = tokens(c.selfBody);
    c.bodySha = sha(c.body);
  });

  // Parent and children from the level nesting.
  chunks.forEach((c, i) => {
    c.children = [];
    for (let j = i - 1; j >= 0; j--) {
      if (chunks[j].level < c.level) {
        c.parent = chunks[j].slug;
        chunks[j].children.push(c.slug);
        break;
      }
    }
  });

  // WorkSlices.md carries its records as table rows, not headings. Without this `doc slice
  // S-21` has nothing to resolve.
  if (key === 'slices') {
    lines.forEach((line, i) => {
      const m = line.match(SLICE_ROW);
      if (!m) return;
      if (/^\|\s*-+\s*\|/.test(line) || m[1] === 'ID') return;
      chunks.push({
        file: key,
        level: 9,
        key: m[1],
        title: stripInline(m[2]),
        aliases: [m[1]],
        flags: ['row'],
        slug: `slices/${m[1].toLowerCase()}`,
        headingLine: i + 1,
        span: { start: i + 1, end: i + 1 },
        selfSpan: { start: i + 1, end: i + 1 },
        body: line,
        selfBody: line,
        tokens: tokens(line),
        selfTokens: tokens(line),
        bodySha: sha(line),
        children: [],
      });
    });
  }

  // WorkSlices.md keeps its records in table rows and its warnings in prose beneath the
  // table. A note naming S-04 belongs to S-04: without this, `doc slice S-04` returns the
  // row and every spec section it cites while silently dropping the paragraph saying the
  // status rule reads the next sub-event's start time, and the D-19 behind it.
  //
  // The file's idiom is a paragraph opening with the slice in bold ("**S-04 carries a
  // trap.**"), so the id must appear in the paragraph's first line and name exactly one
  // slice. A looser rule swallows any bullet list that happens to mention a slice.
  if (key === 'slices') {
    const byKey = new Map(chunks.filter((c) => c.key).map((c) => [c.key, c]));
    const paras = [];
    let para = null;
    lines.forEach((line, i) => {
      const structural = !line.trim() || line.startsWith('|') || line.startsWith('#');
      if (structural) {
        para = null;
        return;
      }
      if (!para) {
        para = { start: i + 1, end: i + 1, lines: [line] };
        paras.push(para);
      } else {
        para.end = i + 1;
        para.lines.push(line);
      }
    });

    for (const pr of paras) {
      if (/^\s*[-*+]\s/.test(pr.lines[0])) continue;
      const named = [...new Set(pr.lines[0].match(/\b(S-\d+[a-z]?|P0-\d+)\b/g) || [])];
      if (named.length !== 1) continue;
      const c = byKey.get(named[0]);
      if (!c) continue;
      (c.notes ||= []).push({ start: pr.start, end: pr.end });
      // Citations inside the note become the slice's own edges, so D-19 reaches S-04.
      c.selfBody = `${c.selfBody}\n${pr.lines.join('\n')}`;
      c.body = c.selfBody;
      c.tokens = tokens(c.body);
      c.selfTokens = c.tokens;
    }
  }

  return { chunks, fenceOpen, lines };
};

// --- abstracts ----------------------------------------------------------------------------

const EXPLICIT = /<!--\s*abstract:\s*([\s\S]*?)-->/;

// Derived from the body wherever possible, so almost nothing here is a standing authoring
// job. An explicit override is authored, so it can drift from the body it describes; there is
// no automatic check for that, only review.
const deriveAbstract = (chunk) => {
  const body = chunk.selfBody;

  const explicit = body.match(EXPLICIT);
  if (explicit) {
    const text = explicit[1].replace(/\s+/g, ' ').trim();
    return { abstract: text, source: 'explicit' };
  }

  if (chunk.file === 'dlog') {
    const dec = body.match(/^\*\*Decision\.\*\*\s*(.+)$/m);
    if (dec) return { abstract: firstSentence(stripInline(dec[1])), source: 'decision' };
  }

  if (chunk.flags?.includes('row')) {
    return { abstract: chunk.title, source: 'title' };
  }

  for (const line of body.split('\n').slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('<!--')) continue;
    // A body that opens with a subheading has no summary of its own, and does not need one:
    // `doc explain` shows its self_tokens and children so the caller takes a child instead.
    if (/^#/.test(t) || FENCE.test(line)) break;
    // Feature sections in the spec open with a bullet list and architecture entries with a
    // table. The first item is a better summary than the heading, and costs nothing.
    const bullet = t.match(/^[-*+]\s+(.+)$/) || t.match(/^\d+\.\s+(.+)$/);
    if (bullet) return { abstract: firstSentence(stripInline(bullet[1])), source: 'first-item' };
    if (/^[|>]/.test(t)) break;
    return { abstract: firstSentence(stripInline(t)), source: 'first-sentence' };
  }

  return { abstract: chunk.title, source: 'title' };
};

// --- citations ----------------------------------------------------------------------------

const PREFIXES = Object.entries(FILES).flatMap(([k, c]) => c.prefixes.map((p) => [p, k]));
const PREFIX_ALT = PREFIXES.map(([p]) => p.replace(/\./g, '\\.')).join('|');
const SECTION = new RegExp(`(?:\`?(${PREFIX_ALT})\`?\\s*)?§(\\d+(?:\\.\\d+)*)`, 'g');
const DECISION = /\bD-(\d+)\b/g;
const SLICE = /\b(S-\d+[a-z]?|P0-\d+)\b/g;
const INHERIT_WINDOW = 60;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// "Handbook §5 and §7" and "HB §6, §14 Phase 5" both elide the prefix on the second citation.
// A bare §n inherits the nearest qualified one within 60 characters, then falls back to the
// file it was written in, then to the spec. Ambiguity is reported, never guessed.
const extractCitations = (rawText, fileKey) => {
  const text = rawText.replace(/<!-- doc:toc begin -->[\s\S]*?<!-- doc:toc end -->/g, '');
  const out = [];
  const sections = [];
  let m;

  SECTION.lastIndex = 0;
  while ((m = SECTION.exec(text)) !== null) {
    const prefix = m[1] ? PREFIXES.find(([p]) => p === m[1])?.[1] : null;
    sections.push({ index: m.index, surface: m[0].trim(), number: m[2], prefix });
  }
  sections.forEach((s, i) => {
    let target = s.prefix;
    if (!target) {
      for (let j = i - 1; j >= 0; j--) {
        if (!sections[j].prefix) continue;
        if (s.index - sections[j].index <= INHERIT_WINDOW) target = sections[j].prefix;
        break;
      }
    }
    out.push({
      kind: 'section',
      surface: s.surface,
      number: s.number,
      hint: target,
      inherited: !s.prefix && !!target,
      line: lineOf(text, s.index),
    });
  });

  DECISION.lastIndex = 0;
  while ((m = DECISION.exec(text)) !== null) {
    out.push({ kind: 'decision', surface: m[0], key: m[0], line: lineOf(text, m.index) });
  }
  SLICE.lastIndex = 0;
  while ((m = SLICE.exec(text)) !== null) {
    out.push({ kind: 'slice', surface: m[0], key: m[1], line: lineOf(text, m.index) });
  }
  return out;
};

// --- index --------------------------------------------------------------------------------

export const buildIndex = () => {
  const chunks = new Map();
  const byNumber = {};
  const byKey = new Map();
  const diagnostics = {
    duplicateSlugs: [],
    duplicateNumbers: [],
    unbalancedFences: [],
    unresolved: [],
  };
  const docs = {};

  for (const [key, cfg] of Object.entries(FILES)) {
    const abs = join(root, ...cfg.path.split('/'));
    const text = readFileSync(abs, 'utf8');
    const parsed = parseDoc(key, text);
    docs[key] = { path: toPosix(cfg.path), text, ...parsed };
    byNumber[key] = {};

    if (parsed.fenceOpen) diagnostics.unbalancedFences.push({ file: toPosix(cfg.path) });

    const seen = new Map();
    const seenNum = new Map();
    for (const c of parsed.chunks) {
      if (seen.has(c.slug)) {
        diagnostics.duplicateSlugs.push({
          file: toPosix(cfg.path),
          slug: c.slug,
          lines: [seen.get(c.slug), c.headingLine],
        });
      } else seen.set(c.slug, c.headingLine);

      if (c.number) {
        if (seenNum.has(c.number)) {
          diagnostics.duplicateNumbers.push({
            file: toPosix(cfg.path),
            number: c.number,
            lines: [seenNum.get(c.number), c.headingLine],
          });
        } else seenNum.set(c.number, c.headingLine);
      }

      const { abstract, source } = deriveAbstract(c);
      c.abstract = abstract;
      c.abstractSource = source;

      if (/~~\(SUPERSEDED by (D-\d+)\)~~|\(SUPERSEDED by (D-\d+)\)/i.test(c.title)) {
        c.flags.push('superseded');
        c.supersededBy = (c.title.match(/SUPERSEDED by (D-\d+)/i) || [])[1];
      }
      if (c.title.includes('⚠') || /^\*\*Cost\.\*\*.*⚠/m.test(c.selfBody)) c.flags.push('risk');

      c.display = c.key || (c.number ? `${cfg.label} §${c.number}` : null);
      if (c.display && !c.aliases.includes(c.display)) c.aliases.push(c.display);
      c.path = toPosix(cfg.path);
      c.cites = [];
      c.citedBy = [];
      chunks.set(c.slug, c);
      if (c.number) byNumber[key][c.number] = c.slug;
      if (c.key) byKey.set(c.key, c.slug);
    }
  }

  const resolveSection = (cit, fromFile) => {
    for (const key of [cit.hint, fromFile, 'idea']) {
      if (key && byNumber[key] && byNumber[key][cit.number]) return byNumber[key][cit.number];
    }
    return null;
  };

  const addEdge = (fromId, cit, fromFile, where) => {
    const target =
      cit.kind === 'section' ? resolveSection(cit, fromFile) : byKey.get(cit.key) || null;
    if (!target) {
      diagnostics.unresolved.push({ surface: cit.surface, ...where, line: cit.line });
      return;
    }
    if (target === fromId) return;
    const from = chunks.get(fromId);
    if (from && !from.cites.includes(target)) from.cites.push(target);
    const to = chunks.get(target);
    if (to && !to.citedBy.includes(fromId)) to.citedBy.push(fromId);
  };

  for (const [key, doc] of Object.entries(docs)) {
    for (const c of doc.chunks) {
      // In WorkSlices.md every slice row is its own chunk and also sits inside a phase
      // heading's body. Attribute a row's citations to the row only, or `doc why` reports
      // each one twice.
      const source =
        key === 'slices' && !c.flags.includes('row')
          ? c.selfBody
              .split('\n')
              .filter((l) => !SLICE_ROW.test(l))
              .join('\n')
          : c.selfBody;
      for (const cit of extractCitations(source, key)) {
        // extractCitations counts lines from the start of the chunk body, which begins on
        // the heading line.
        cit.line = source === c.selfBody ? c.selfSpan.start + cit.line - 1 : c.selfSpan.start;
        addEdge(c.slug, cit, key, { file: doc.path, in: c.slug });
      }
    }
  }

  // External files are citation sources only. They get backlink credit without being chunked.
  for (const rel of CITATION_SOURCES) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const id = toPosix(rel);
    for (const cit of extractCitations(text, null)) {
      const target = cit.kind === 'section' ? resolveSection(cit, null) : byKey.get(cit.key);
      if (!target) {
        diagnostics.unresolved.push({ surface: cit.surface, file: id, in: id, line: cit.line });
        continue;
      }
      const to = chunks.get(target);
      if (to && !to.citedBy.includes(id)) to.citedBy.push(id);
    }
  }

  const byAlias = {};
  for (const c of chunks.values())
    for (const a of c.aliases) if (!(a in byAlias)) byAlias[a] = c.slug;

  return {
    generatedAt: new Date().toISOString(),
    files: Object.fromEntries(
      Object.entries(docs).map(([k, d]) => [
        k,
        { path: d.path, lines: d.lines.length, bytes: d.text.length, chunks: d.chunks.length },
      ]),
    ),
    chunks: Object.fromEntries(
      [...chunks.entries()].map(([slug, c]) => [
        slug,
        {
          slug,
          file: c.file,
          path: c.path,
          aliases: c.aliases,
          number: c.number,
          key: c.key,
          display: c.display,
          title: c.title,
          level: c.level,
          abstract: c.abstract,
          abstractSource: c.abstractSource,
          bodySha: c.bodySha,
          flags: c.flags,
          supersededBy: c.supersededBy,
          parent: c.parent,
          children: c.children,
          span: c.span,
          selfSpan: c.selfSpan,
          tokens: c.tokens,
          selfTokens: c.selfTokens,
          notes: c.notes,
          cites: c.cites,
          citedBy: c.citedBy,
        },
      ]),
    ),
    byAlias,
    diagnostics,
    stats: {
      chunks: chunks.size,
      citations: [...chunks.values()].reduce((n, c) => n + c.citedBy.length, 0),
      unresolved: diagnostics.unresolved.length,
      duplicateSlugs: diagnostics.duplicateSlugs.length,
      duplicateNumbers: diagnostics.duplicateNumbers.length,
      unbalancedFences: diagnostics.unbalancedFences.length,
    },
  };
};

// --- report -------------------------------------------------------------------------------

if (process.argv[1] && toPosix(process.argv[1]).endsWith('scripts/docindex.mjs')) {
  const index = buildIndex();
  const d = index.diagnostics;

  if (process.argv.includes('--write-toc')) {
    for (const t of writeToc(index)) console.log(`toc  ${t}`);
    console.log('');
  }
  const pad = (s, n) => String(s).padEnd(n);

  console.log('files');
  for (const [k, f] of Object.entries(index.files)) {
    console.log(
      `  ${pad(k, 7)} ${pad(f.path, 34)} ${pad(f.lines + ' lines', 12)} ${f.chunks} chunks`,
    );
  }

  console.log('\nstats');
  for (const [k, v] of Object.entries(index.stats)) console.log(`  ${pad(k, 18)} ${v}`);

  console.log(`\nunbalanced fences (${d.unbalancedFences.length})`);
  for (const f of d.unbalancedFences) console.log(`  ${f.file}`);

  console.log(`\nduplicate slugs (${d.duplicateSlugs.length})`);
  for (const x of d.duplicateSlugs) console.log(`  ${x.file}:${x.lines.join(',')}  ${x.slug}`);

  console.log(`\nduplicate section numbers (${d.duplicateNumbers.length})`);
  for (const x of d.duplicateNumbers) console.log(`  ${x.file}:${x.lines.join(',')}  §${x.number}`);

  console.log(`\nunresolved citations (${d.unresolved.length})`);
  for (const u of d.unresolved) console.log(`  ${u.file}:${u.line}  ${u.surface}`);

  const over = Object.values(index.chunks)
    .filter((c) => c.selfTokens > 600 && c.children.length === 0)
    .sort((a, b) => b.selfTokens - a.selfTokens);
  console.log(`\nleaf chunks over 600 tokens (${over.length})`);
  for (const c of over.slice(0, 12)) console.log(`  ${pad(c.selfTokens, 6)} ${c.slug}`);
}
