// Parse docs/ into addressable chunks and resolve every cross-reference between them.
// Used by scripts/doc.mjs. Not run directly.
//
// Identity is derived, never authored: a chunk's id is its GitHub heading anchor, scoped by
// file. Section numbers (§4.11) are aliases computed from the heading, so renumbering a doc
// is a warning here rather than a rewrite of every citation in the repo.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

// The only configuration. `prefixes` qualify a § citation as belonging to this file.
export const FILES = {
  idea: { path: 'docs/Idea.md', prefixes: ['spec', 'Spec'], label: 'spec', bare: true },
  hb: { path: 'docs/EngineeringHandbook.md', prefixes: ['Handbook', 'HB', 'hb'], label: 'hb' },
  dlog: { path: 'docs/DecisionLog.md', prefixes: [], label: 'dlog' },
  arch: {
    path: 'docs/ARCHITECTURE.md',
    prefixes: ['ARCHITECTURE.md', 'ARCHITECTURE', 'arch'],
    label: 'arch',
  },
  slices: { path: 'docs/WorkSlices.md', prefixes: [], label: 'slices' },
};

// Scanned for citations so backlinks are complete. Not chunked.
const SOURCES = [
  'CLAUDE.md',
  'apps/api/CLAUDE.md',
  'apps/mobile/CLAUDE.md',
  'worker/CLAUDE.md',
  '.claude/skills/slice/SKILL.md',
  '.github/ISSUE_TEMPLATE/slice.md',
];

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const D_HEAD = /^(D-\d+)\s*[—:–-]\s*(.+)$/; // 68 entries use an em dash, 12 a colon
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;
const ROW = /^\|\s*\*{0,2}(S-\d+[a-z]?|P0-\d+)\*{0,2}\s*\|\s*(.+?)\s*\|/;
const ABSTRACT = /<!--\s*abstract:\s*([\s\S]*?)-->/;

// GitHub's anchor algorithm. "2.5 Navigation & screen architecture" becomes
// "25-navigation--screen-architecture", double hyphen included, which is what Idea.md's
// hand-written table of contents already links to.
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

const tokens = (t) => Math.ceil(t.length / 4);
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
  const guarded = flat.replace(/(\d)\.(\d)/g, '$1\u0000$2');
  let out = '';
  for (const m of guarded.matchAll(/[^.!?]*[.!?]+(?:\s|$)/g)) {
    out += m[0];
    if (out.trim().length >= min) break;
  }
  out = (out.trim() || guarded).split('\u0000').join('.');
  return out.length > 220 ? out.slice(0, 217).trimEnd() + '...' : out;
};

// Headings, with fence state respected. EngineeringHandbook.md has a shell comment inside a
// fenced block that `grep -n '^#'` reads as an H1.
const headings = (lines) => {
  const out = [];
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
    if (h) out.push({ level: h[1].length, title: h[2], line: i + 1 });
  });
  return { out, open: fence !== null };
};

// Derived from the body wherever possible, so almost nothing here is an authoring job.
const abstractOf = (c) => {
  const body = c.selfBody;
  const explicit = body.match(ABSTRACT);
  if (explicit) return [explicit[1].replace(/\s+/g, ' ').trim(), 'explicit'];
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
  const { out: heads, open } = headings(lines);
  const chunks = [];

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
      if (cfg.prefixes[0]) c.aliases.push(`${cfg.prefixes[0]} §${n[1]}`);
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
      const m = line.match(ROW);
      if (!m || m[1] === 'ID') return;
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
      };
      rows.push(c);
      chunks.push(c);
    });

    // The file's idiom is a paragraph opening with the slice in bold. Matching anywhere in
    // the paragraph instead swallows any bullet list that happens to mention one.
    const byKey = new Map(rows.map((c) => [c.key, c]));
    let para = null;
    lines.forEach((line, i) => {
      if (!line.trim() || line.startsWith('|') || line.startsWith('#')) return (para = null);
      if (!para) para = { start: i + 1, end: i + 1, lines: [line] };
      else {
        para.end = i + 1;
        para.lines.push(line);
        return;
      }
      if (/^\s*[-*+]\s/.test(line)) return (para = null);
      const named = [...new Set(line.match(/\b(S-\d+[a-z]?|P0-\d+)\b/g) || [])];
      if (named.length !== 1 || !byKey.has(named[0])) return (para = null);
      const c = byKey.get(named[0]);
      c.notes.push(para);
      c.attached = c.attached || [];
      c.attached.push(para);
    });
    for (const c of rows) {
      if (!c.attached) continue;
      c.notes = c.attached.map((p) => ({ start: p.start, end: p.end }));
      // Citations in a note become the slice's own edges, so D-19 reaches S-04.
      c.selfBody += '\n' + c.attached.map((p) => p.lines.join('\n')).join('\n');
      c.tokens = c.selfTokens = tokens(c.selfBody);
      delete c.attached;
    }
  }

  for (const c of chunks) {
    const [abstract, source] = abstractOf(c);
    c.abstract = abstract;
    c.abstractSource = source;
    if (/SUPERSEDED by (D-\d+)/i.test(c.title)) {
      c.flags.push('superseded');
      c.supersededBy = c.title.match(/SUPERSEDED by (D-\d+)/i)[1];
    }
    if (c.title.includes('⚠')) c.flags.push('risk');
    c.path = posix(cfg.path);
    c.display = c.key || (c.number ? `${cfg.label} §${c.number}` : null);
    if (c.display && !c.aliases.includes(c.display)) c.aliases.push(c.display);
    c.cites = [];
    c.citedBy = [];
  }
  return { chunks, open, lines };
};

const PREFIXES = Object.entries(FILES).flatMap(([k, c]) => c.prefixes.map((p) => [p, k]));
const SECTION = new RegExp(
  `(?:\`?(${PREFIXES.map(([p]) => p.replace(/\./g, '\\.')).join('|')})\`?\\s*)?§(\\d+(?:\\.\\d+)*)`,
  'g',
);

// "Handbook §5 and §7" elides the prefix on the second citation. A bare §n inherits the
// nearest qualified one within 60 characters, then falls back to its own file, then the spec.
const citations = (text) => {
  const clean = text;
  const out = [];
  const secs = [...clean.matchAll(SECTION)].map((m) => ({
    at: m.index,
    surface: m[0].trim(),
    number: m[2],
    hint: m[1] ? PREFIXES.find(([p]) => p === m[1])[1] : null,
  }));
  secs.forEach((s, i) => {
    let hint = s.hint;
    if (!hint)
      for (let j = i - 1; j >= 0; j--) {
        if (!secs[j].hint) continue;
        if (s.at - secs[j].at <= 60) hint = secs[j].hint;
        break;
      }
    out.push({ kind: 'section', surface: s.surface, number: s.number, hint, at: s.at });
  });
  for (const m of clean.matchAll(/\bD-\d+\b/g))
    out.push({ kind: 'key', surface: m[0], key: m[0], at: m.index });
  for (const m of clean.matchAll(/\b(S-\d+[a-z]?|P0-\d+)\b/g))
    out.push({ kind: 'key', surface: m[0], key: m[1], at: m.index });
  return out;
};

export const buildIndex = () => {
  const chunks = new Map();
  const byNumber = {};
  const byKey = new Map();
  const docs = {};
  const errors = [];

  for (const [key, cfg] of Object.entries(FILES)) {
    const text = readFileSync(join(root, ...cfg.path.split('/')), 'utf8');
    const p = parse(key, text);
    docs[key] = { path: posix(cfg.path), ...p };
    byNumber[key] = {};
    if (p.open)
      errors.push({
        code: 'unbalanced-fence',
        file: posix(cfg.path),
        line: 0,
        msg: 'fence never closed',
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
      if (c.key) byKey.set(c.key, c.slug);
      chunks.set(c.slug, c);
    }
  }

  const target = (cit, from) =>
    cit.kind === 'key'
      ? byKey.get(cit.key) || null
      : [cit.hint, from, 'idea'].reduce(
          (hit, k) => hit || (k && byNumber[k]?.[cit.number]) || null,
          null,
        );

  const lineAt = (text, at, offset) => offset + text.slice(0, at).split('\n').length - 1;

  for (const [key, doc] of Object.entries(docs)) {
    for (const c of doc.chunks) {
      // In WorkSlices.md a row is its own chunk and also sits inside a phase heading's body.
      // Attribute a row's citations to the row only, or every one is counted twice.
      const text =
        key === 'slices' && !c.flags.includes('row')
          ? c.selfBody
              .split('\n')
              .filter((l) => !ROW.test(l))
              .join('\n')
          : c.selfBody;
      for (const cit of citations(text)) {
        const to = target(cit, key);
        if (!to) {
          errors.push({
            code: 'dangling-citation',
            file: doc.path,
            line: lineAt(text, cit.at, c.selfSpan.start),
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

  for (const rel of SOURCES) {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const cit of citations(text)) {
      const to = target(cit, null);
      if (!to) {
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

  const byAlias = {};
  for (const c of chunks.values())
    for (const a of c.aliases) if (!(a in byAlias)) byAlias[a] = c.slug;

  return {
    chunks: Object.fromEntries(chunks),
    byAlias,
    errors,
    stats: {
      chunks: chunks.size,
      citations: [...chunks.values()].reduce((n, c) => n + c.citedBy.length, 0),
    },
  };
};
