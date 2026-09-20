// Retrieval over docs/. Replaces the grep-then-sed recipe with one addressed lookup.
//
//   node scripts/doc.mjs §4.11 D-57        print those chunks
//   node scripts/doc.mjs slice S-21        the brief for a work slice
//   node scripts/doc.mjs why D-57          what breaks if this decision is reopened
//   node scripts/doc.mjs grep variant_version
//   node scripts/doc.mjs toc idea
//   node scripts/doc.mjs check             the integrity gate
//
// Retrieval never throws and never exits non-zero. A missing chunk prints a diagnostic and
// suggestions, because the moment this crashes an agent falls back to grep and stays there.
// Only `check` exits non-zero.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildIndex, FILES } from './docindex.mjs';

const root = process.cwd();
const VERSION = '1.0';
// A parent whose whole subtree fits is printed entire. Past this the children become stubs
// with their abstracts, so the caller picks one instead of paying for all of them.
const SUBTREE_INLINE_TOKENS = 800;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
  },
});

const index = buildIndex();
const chunks = index.chunks;

// --- resolution ---------------------------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/^[§#]/, '');

const resolve = (token) => {
  if (chunks[token]) return token;
  if (index.byAlias[token]) return index.byAlias[token];

  const t = token.trim();
  const up = t.toUpperCase();

  // An explicit file scope wins over every alias. Checked first because the bare `§7`
  // alias used to fire before this and sent `--file hb 7` to the spec's §7 instead of the
  // handbook's, which is the rule behind root invariant 5.
  const scoped = t.match(/^(\w+):(.+)$/);
  const fileKey = scoped ? scoped[1] : flags.file;
  const num = scoped ? scoped[2] : norm(t);
  if (fileKey && FILES[fileKey]) {
    const hit = Object.values(chunks).find((c) => c.file === fileKey && c.number === num);
    if (hit) return hit.slug;
  }

  if (index.byAlias[up]) return index.byAlias[up];
  if (index.byAlias[`§${norm(t)}`]) return index.byAlias[`§${norm(t)}`];

  const suffix = Object.keys(chunks).filter((s) => s.split('/')[1]?.startsWith(norm(t)));
  if (suffix.length === 1) return suffix[0];
  return null;
};

const suggest = (token) => {
  const t = norm(token);
  return Object.values(chunks)
    .filter((c) => c.slug.includes(t) || c.title.toLowerCase().includes(t))
    .slice(0, 5)
    .map((c) => `${c.display || c.slug}  ${c.title}`);
};

// --- reading ------------------------------------------------------------------------------

const fileText = new Map();
const readChunk = (c, { self = false } = {}) => {
  const rel = c.path;
  if (!fileText.has(rel))
    fileText.set(rel, readFileSync(join(root, ...rel.split('/')), 'utf8').split('\n'));
  const lines = fileText.get(rel);
  const span = self ? c.selfSpan : c.span;
  const read = (a, b) =>
    lines
      .slice(a - 1, b)
      .join('\n')
      .replace(/\s+$/, '');
  const main = read(span.start, span.end);
  // A slice row's warnings live in prose under the table rather than in the row, and they
  // are the point of the row more often than the row is.
  if (!c.notes?.length) return main;
  return [main, ...c.notes.map((n) => read(n.start, n.end))].join('\n\n');
};

const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const staleAbstract = (c) => {
  if (c.abstractSource !== 'explicit' || !c.abstractSha) return false;
  const body = readChunk(c, { self: true }).replace(/<!--\s*abstract:[\s\S]*?-->/, '');
  return sha16(body) !== c.abstractSha;
};

// --- output -------------------------------------------------------------------------------

const out = [];
const say = (line = '') => out.push(line);

const header = (c) => {
  const alias = c.display ? `alias ${c.display} · ` : '';
  say(`--- [${c.slug}]`);
  say(`    ${alias}${c.path}:${c.span.start}-${c.span.end} · ${c.tokens} tok`);
  if (c.flags.includes('superseded')) {
    say(`!!! SUPERSEDED BY ${c.supersededBy}. Reasoning only. Do not build from this.`);
  }
  if (c.flags.includes('risk')) say('    (risk knowingly accepted by the team)');
};

const stub = (c) => {
  say(`--- [${c.slug}] NOT EXPANDED`);
  say(`    ${c.abstract}${staleAbstract(c) ? ' [ABSTRACT MAY BE STALE]' : ''}`);
  say(`    SUPERSEDED BY ${c.supersededBy}. Do not build from it.`);
  say(`    → doc ${c.display || c.slug}`);
};

const emit = (c) => {
  header(c);
  // A parent whose subtree is small prints whole; a large one prints its own preamble and
  // lists children, because §4.11's own body is a heading and four subsections.
  if (c.children.length && c.tokens > SUBTREE_INLINE_TOKENS) {
    say('');
    say(readChunk(c, { self: true }));
    say('');
    say(`    ${c.children.length} children not inlined (${c.tokens} tok total):`);
    for (const ch of c.children) {
      const k = chunks[ch];
      say(
        `      ${String(k.tokens).padStart(5)} tok  ${(k.display || k.slug).padEnd(12)} ${k.abstract}`,
      );
    }
    say('');
    return c.selfTokens;
  }
  say('');
  say(readChunk(c));
  say('');
  return c.tokens;
};

const banner = (what, n, tok) => `=== doc ${VERSION} | ${what} | ${n} chunks | ~${tok} tok ===`;

const render = (title, expand, stubs) => {
  const body = [];
  const swap = out.length;
  let total = 0;
  for (const slug of expand) total += emit(chunks[slug]);
  // Only a superseded decision gets a stub of its own. Expanding one into a brief is the
  // failure this guards against, and a banner is the cheapest way to prevent it. Everything
  // else is one line of ids at the end, which is enough to go and fetch it.
  for (const slug of stubs.filter((s) => chunks[s].flags.includes('superseded')))
    stub(chunks[slug]);
  body.push(...out.splice(swap));
  say(banner(title, expand.length, total));
  say('');
  out.push(...body);
  return total;
};

const provenance = (resolved, stubs, unresolved) => {
  say('=== provenance ===');
  if (resolved.length) say(`resolved:   ${resolved.join(' ')}`);
  if (stubs.length) {
    const tok = stubs.reduce((n, x) => n + chunks[x].tokens, 0);
    say(
      `one hop out: ${stubs.map((x) => chunks[x].display || x).join(' ')}  (~${tok} tok, not loaded)`,
    );
  }
  say(`unresolved: ${unresolved.length ? unresolved.join(' ') : 'none'}`);
  say('=== end ===');
};

// --- verbs --------------------------------------------------------------------------------

const verbs = {};

verbs.print = (tokensIn) => {
  const expand = [];
  const unresolved = [];
  for (const t of tokensIn) {
    const slug = resolve(t);
    if (!slug) unresolved.push(t);
    else if (!expand.includes(slug)) expand.push(slug);
  }
  render(`print ${tokensIn.join(' ')}`, expand, []);
  provenance(
    expand.map((s) => chunks[s].display || s),
    [],
    unresolved,
  );
  for (const u of unresolved) {
    say('');
    const near = suggest(u);
    // A structured "nothing matches" is a real answer. It stops the caller falling back to
    // a corpus grep that will also find nothing, more slowly.
    if (!near.length) {
      say(`no chunk matches "${u}", and nothing in the corpus is close to it.`);
      say(`  ids look like: spec §4.11 · hb §7 · arch §3 · D-57 · S-21`);
      say(`  list one file with: doc toc ${Object.keys(FILES).join('|')}`);
    } else {
      say(`no chunk matches "${u}". Closest:`);
      for (const n of near) say(`  ${n}`);
    }
  }
};

verbs.slice = (args) => {
  const slug = resolve(args[0]);
  if (!slug) {
    say(`no slice matches "${args[0]}". Closest:`);
    for (const s of suggest(args[0])) say(`  ${s}`);
    return;
  }
  const slice = chunks[slug];
  const expand = [slug];
  const stubs = [];
  const seen = new Set([slug]);

  for (const cited of slice.cites) {
    const c = chunks[cited];
    if (!c || seen.has(cited)) continue;
    seen.add(cited);
    // Never expand a retracted decision into a brief. D-45 is superseded by D-68 and sits
    // one hop from S-21, the slice holding the image-serving authorization check.
    if (c.flags.includes('superseded')) stubs.push(cited);
    else expand.push(cited);
  }
  for (const cited of expand.slice(1)) {
    for (const next of chunks[cited].cites) {
      if (seen.has(next)) continue;
      seen.add(next);
      stubs.push(next);
    }
  }

  const total = render(`slice ${slice.key || args[0]}`, expand, stubs);
  provenance(
    expand.map((x) => chunks[x].display || x),
    stubs,
    [],
  );
  return total;
};

verbs.why = (args) => {
  const slug = resolve(args[0]);
  if (!slug) {
    say(`no chunk matches "${args[0]}".`);
    for (const s of suggest(args[0])) say(`  ${s}`);
    return;
  }
  const c = chunks[slug];
  say(
    `=== doc ${VERSION} | why ${c.aliases[0] || slug} | ${c.citedBy.length} inbound citations ===`,
  );
  say(`${c.display || ''} ${c.title}`.trim());
  say(
    `${c.path}:${c.span.start}-${c.span.end} · ${c.tokens} tok${c.flags.includes('risk') ? ' · risk accepted' : ''}`,
  );
  if (c.flags.includes('superseded')) say(`SUPERSEDED BY ${c.supersededBy}`);
  say('');
  say('REOPENING THIS BREAKS:');
  const groups = {};
  for (const b of c.citedBy) {
    const k = chunks[b] ? chunks[b].file : 'other';
    (groups[k] ||= []).push(chunks[b] ? chunks[b].display || chunks[b].slug : b);
  }
  for (const [k, v] of Object.entries(groups)) say(`  ${k.padEnd(7)} ${v.join(' ')}`);
  say('');
  say(readChunk(c));
};

verbs.grep = (args) => {
  const term = args.join(' ');
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const hits = [];
  for (const c of Object.values(chunks)) {
    if (c.flags.includes('row')) continue;
    const body = readChunk(c, { self: true });
    const n = (body.match(re) || []).length;
    if (n) hits.push({ c, n });
  }
  hits.sort((a, b) => b.n - a.n);
  const tok = hits.reduce((s, h) => s + h.c.selfTokens, 0);
  say(`=== doc ${VERSION} | grep ${term} | ${hits.length} chunks | ~${tok} tok if all loaded ===`);
  say('');
  for (const { c, n } of hits) {
    say(
      `${String(n).padStart(3)}x  ${(c.display || c.slug).padEnd(14)} ${String(c.selfTokens).padStart(5)} tok  ${c.path}:${c.selfSpan.start}`,
    );
    say(`      ${c.abstract}`);
  }
  if (!hits.length) say(`no chunk mentions "${term}".`);
};

verbs.toc = (args) => {
  const key = args[0];
  if (!FILES[key]) {
    say(`unknown file "${key}". One of: ${Object.keys(FILES).join(' ')}`);
    return;
  }
  const list = Object.values(chunks).filter((c) => c.file === key);
  say(`=== doc ${VERSION} | toc ${key} | ${list.length} chunks | ${FILES[key].path} ===`);
  say('');
  for (const c of list) {
    const indent = '  '.repeat(Math.max(0, Math.min(c.level, 5) - 1));
    say(`${String(c.tokens).padStart(6)} tok  ${indent}${(c.display || '').padEnd(12)} ${c.title}`);
  }
};

verbs.check = () => {
  const d = index.diagnostics;
  const errors = [];
  for (const u of d.unresolved) {
    errors.push({
      code: 'dangling-citation',
      file: u.file,
      line: u.line,
      message: `"${u.surface}" resolves to nothing`,
    });
  }
  for (const f of d.unbalancedFences) {
    errors.push({
      code: 'unbalanced-fence',
      file: f.file,
      line: 0,
      message: 'a code fence is never closed',
    });
  }
  for (const s of d.duplicateNumbers) {
    errors.push({
      code: 'duplicate-section-number',
      file: s.file,
      line: s.lines[1],
      message: `§${s.number} is also a heading at line ${s.lines[0]}; every citation to it resolves to one of them`,
    });
  }
  for (const s of d.duplicateSlugs) {
    errors.push({
      code: 'duplicate-slug',
      file: s.file,
      line: s.lines[1],
      message: `"${s.slug}" also at line ${s.lines[0]}`,
    });
  }
  if (errors.length) {
    console.log(`docs:check FAILED, ${errors.length} error(s)`);
    for (const e of errors) console.log(`  ${e.code}  ${e.file}:${e.line}  ${e.message}`);
  } else {
    const s = index.stats;
    console.log(
      `docs:check ok  ${s.chunks} chunks, ${s.citations} citations, 0 dangling, 0 duplicate slugs, 0 unbalanced fences`,
    );
  }
  // --warn reports without blocking. The gate runs this way for its first two weeks: a
  // gate nobody has watched fail is a gate that gets bypassed the first time it does.
  if (errors.length && flags.warn) console.log('  (--warn: reporting only, not failing the build)');
  process.exit(errors.length && !flags.warn ? 1 : 0);
};

// --- dispatch -----------------------------------------------------------------------------

// "doc arch §3" reaches argv as two words. Rejoin a file label with the §n that follows it,
// so the qualified form behaves the same quoted or not.
const LABELS = new Set([...Object.keys(FILES), ...Object.values(FILES).flatMap((f) => f.prefixes)]);
const joined = [];
for (let i = 0; i < positionals.length; i++) {
  if (LABELS.has(positionals[i]) && /^§/.test(positionals[i + 1] || '')) {
    joined.push(`${positionals[i]} ${positionals[i + 1]}`);
    i++;
  } else joined.push(positionals[i]);
}
positionals.length = 0;
positionals.push(...joined);

const [head, ...rest] = positionals;
if (!head) {
  console.log(
    'usage: doc <id|§n|D-nn>... | slice S-nn | why D-nn | grep <term> | toc <file> | check',
  );
  process.exit(0);
}

if (verbs[head]) verbs[head](rest);
else verbs.print(positionals);

console.log(out.join('\n'));
