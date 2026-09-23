// Retrieval over docs/. One addressed lookup instead of grepping headings and reading files.
//
//   doc spec §4.11.4 D-57 arch §3   print those sections
//   doc slice S-21                  everything that slice cites, plus its warning paragraph
//   doc why D-57                    what breaks if this decision is reopened
//   doc grep variant_version        which sections mention a term
//   doc toc idea|hb|dlog|arch|slices
//   doc check                       the gate: dangling citations, fences, duplicate ids
//
// Retrieval never throws and never exits non-zero. A miss prints a diagnostic, because the
// first time this crashes an agent falls back to grep and stays there. Only `check` exits 1.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, FILES, tokens } from './docindex.mjs';

// Anchored to this file, not the shell's directory, so `node ../../scripts/doc.mjs D-57`
// works from anywhere in the repo.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Past this a parent prints its own preamble and a menu of children instead of the subtree.
const MENU_OVER = 800;

// Only the `--` a package runner inserts is dropped. Dropping every word that starts with a
// dash also dropped the term in `doc grep --skip-worker` and reported that no term was given.
const argv = process.argv.slice(2).filter((a) => a !== '--');
let index;
try {
  // Only `why` reports the blast radius, so only `why` pays for the code backlink walk.
  index = buildIndex({ wide: argv[0] === 'why' });
} catch (e) {
  // A missing or unreadable doc cannot be recovered from. Say which, never stack-trace.
  // Retrieval exits 0 so a broken doc never fails the caller; the gate exits 1, because
  // a gate that cannot read the docs has not passed.
  console.log(`doc: ${e.message}`);
  process.exit(process.argv.includes('check') ? 1 : 0);
}
const C = index.chunks;
const num = (s) => (s ?? '').toLowerCase().replace(/^[§#]/, '');

// "doc arch §3" arrives as two words. Rejoin a file label with the section that follows it,
// with or without the §: `doc hb 7` used to search for "hb", then refuse a bare 7 as
// ambiguous. Not for grep, where "spec 4" is a phrase to search for.
const LABEL = new Map();
for (const [k, f] of Object.entries(FILES))
  for (const n of [k, f.label, ...f.prefixes]) if (n) LABEL.set(n.toLowerCase(), k);
const fileKey = (s) => LABEL.get((s ?? '').toLowerCase().trim());
const args = [];
for (let i = 0; i < argv.length; i++) {
  const sec = (argv[i + 1] || '').match(/^§?(\d+(?:\.\d+)*)$/);
  if (argv[0] !== 'grep' && fileKey(argv[i]) && sec) (args.push(`${argv[i]} §${sec[1]}`), i++);
  else args.push(argv[i]);
}

const resolve = (token) => {
  const t = (token ?? '').trim();
  if (!t) return null;
  // A bare §n is a real section in three of the five docs. Guessing which is exactly the
  // failure that looks correct and throws nothing, so refuse and name the choices.
  if (/^§?\d+(\.\d+)*$/.test(t)) {
    const all = Object.values(C).filter((c) => c.number === num(t));
    if (all.length > 1) return { ambiguous: all.map((c) => c.display) };
    if (all.length === 1) return all[0].slug;
  }
  const scoped = t.match(/^([\w.]+):(.+)$/);
  const key = scoped && fileKey(scoped[1]);
  if (key) {
    const want = num(scoped[2]);
    const hit = Object.values(C).find(
      (c) => c.file === key && (c.number === want || c.slug === `${key}/${want}`),
    );
    if (hit) return hit.slug;
  }
  if (Object.hasOwn(C, t)) return t;
  if (Object.hasOwn(index.byAlias, t)) return index.byAlias[t];
  const low = t.toLowerCase();
  if (Object.hasOwn(index.byAlias, low)) return index.byAlias[low];
  // A structured id must match exactly. `D-8` is not a short form of `D-80`, it is a typo,
  // and resolving it silently is the failure this tool exists to remove. Free text like
  // `dnp` still matches on prefix, because there it is a search, not an id.
  if (/^(D|S|P0)-/i.test(t) || /^§?\d/.test(t)) return null;
  const hit = Object.keys(C).filter((s) => s.split('/')[1]?.startsWith(num(t)));
  return hit.length === 1 ? hit[0] : null;
};

// A mistyped id can be any length; echoing 300 characters of it back is noise.
const show = (t) => (t.length > 60 ? t.slice(0, 60) + '…' : t);

// A mistyped id gets the ids that start with it: `D-8` lists D-80 to D-89. Matching on slug
// text listed D-19, D-23, D-25, D-47 and D-52, all retired, whose slugs end "superseded-by-d-8x".
const near = (t) => {
  if (!t) return [];
  const pool = /^(D|S|P0)-\d+[a-z]?$/i.test(t)
    ? Object.values(C).filter((c) => c.key?.toLowerCase().startsWith(t.toLowerCase()))
    : Object.values(C).filter(
        (c) => c.slug.includes(num(t)) || c.title.toLowerCase().includes(num(t)),
      );
  return pool.slice(0, 5).map((c) => `  ${c.display || c.slug}  ${c.title}`);
};

const files = new Map();
const read = (path, a, b) => {
  if (!files.has(path))
    // Split the way docindex.mjs does, or a CRLF working copy puts a \r on every line.
    files.set(path, readFileSync(join(root, ...path.split('/')), 'utf8').split(/\r\n|\r|\n/));
  return files
    .get(path)
    .slice(a - 1, b)
    .join('\n')
    .replace(/\s+$/, '');
};

const body = (c, self = false) => {
  const span = self ? c.selfSpan : c.span;
  const main = read(c.path, span.start, span.end);
  if (!c.notes?.length) return main;
  return [main, ...c.notes.map((n) => read(c.path, n.start, n.end))].join('\n\n');
};

const out = [];
const say = (l = '') => out.push(l);

// Prints a chunk. A large parent gives its preamble and a menu, so nobody pays 3,600 tokens
// for an answer that lives in 300.
const emit = (c, put = say) => {
  const id = c.display || c.slug;
  const flags = c.flags.includes('risk') ? ' · risk accepted' : '';
  put(`--- ${id} · ${c.path}:${c.span.start}-${c.span.end} · ~${c.tokens} tok${flags}`);
  if (c.flags.includes('superseded'))
    put(`!!! ${c.retiredAs} ${c.supersededBy}. Do not build from it.`);
  put('');
  if (menued(c)) {
    put(body(c, true));
    put('');
    put(`    ${c.children.length} sections under this one (~${c.tokens} tok in total).`);
    put(`    Read the one you need: doc ${C[c.children[0]].display || C[c.children[0]].slug}`);
    for (const ch of c.children) {
      const k = C[ch];
      put(
        `      ~${String(k.tokens).padStart(5)} tok  ${(k.display || k.slug).padEnd(14)} ${gist(k)}`,
      );
    }
    put('');
    return;
  }
  put(body(c));
  put('');
};

// A slice row sits under a phase heading but is not its child, since rows are found after
// the heading tree is built. Locate it by span.
const phaseOf = (slice) =>
  Object.values(C)
    .filter(
      (c) =>
        c.file === 'slices' &&
        !c.flags.includes('row') &&
        c.span.start < slice.span.start &&
        c.span.end >= slice.span.start,
    )
    .sort((a, b) => b.level - a.level || b.span.start - a.span.start)[0];

const phaseProse = (phase) =>
  !phase
    ? ''
    : phase.segments[0].text
        .split('\n')
        .filter((l) => l.trim() && !/^(#|\||---)/.test(l.trim()))
        .join('\n');

// A menu of one child is not a choice: the reader fetches that child every time. arch §1 has
// one child, the "who may see what" table, and sits just under the threshold; a menu there
// would hide the table from every slice that cites it.
const menued = (c) => c.children.length > 1 && c.tokens > MENU_OVER;

// What a chunk costs to read through this tool: a menued parent charges only its preamble.
const cost = (c) => (menued(c) ? c.selfTokens : c.tokens);
const gist = (c) =>
  c.flags.includes('superseded') ? `${c.retiredAs} ${c.supersededBy}. ${c.abstract}` : c.abstract;

const plan = (slice) => {
  const expand = [slice.slug];
  const next = [];
  const seen = new Set([slice.slug]);
  for (const id of slice.cites) {
    if (seen.has(id)) continue;
    seen.add(id);
    // Never expand a retracted decision into a brief. D-45 reaches S-21 through D-57,
    // the slice holding the image-serving authorization check.
    if (C[id].flags.includes('superseded')) next.push(id);
    // A brief carries the rows of the slices it depends on. S-25's note names S-03, S-07
    // and S-24 as places it touches, and printing those rows and their notes cost 235
    // tokens of other slices' warnings.
    else if (C[id].flags.includes('row') && !slice.deps.includes(C[id].key)) next.push(id);
    else expand.push(id);
  }
  for (const id of expand.slice(1))
    for (const n of C[id].cites) if (!seen.has(n)) (seen.add(n), next.push(n));
  const prose = phaseProse(phaseOf(slice));
  return { expand, next, prose, menus: expand.filter((s) => menued(C[s])).length };
};

// One brief, as lines. `slice`, `toc` and `check` all go through this, so the cost `toc`
// prints is the size of the brief `slice` prints. Both used to add up section sizes only,
// leaving out every provenance line and the one-hop list, and ran about 10% low.
const render = (slice) => {
  const lines = [];
  const put = (l = '') => lines.push(l);
  const { expand, next, prose, menus } = plan(slice);
  if (prose) {
    put(`--- ${phaseOf(slice).title} · applies to every slice in this phase`);
    put('');
    put(prose);
    put('');
  }
  for (const s of expand) emit(C[s], put);
  for (const s of next.filter((x) => C[x].flags.includes('superseded'))) {
    put(`--- ${C[s].display} NOT EXPANDED`);
    put(`    ${C[s].abstract}`);
    put(`    ${C[s].retiredAs} ${C[s].supersededBy}. Do not build from it.`);
    put('');
  }
  put(`one hop out: ${next.map((s) => C[s].display || s).join(' ')}`);
  // The checklist every slice is measured against is not in any brief and is too long to
  // put in every one. Name it, now that a chunk without a section number can be addressed.
  put('done means: doc slices:definition-of-done');
  // The header is part of what the reader pays for, and leaving it out put every brief 17
  // tokens over its own figure. `~N` is one word whatever N is, so counting with 0 is exact.
  const head = (n) => `=== slice ${slice.key} · ${expand.length} sections · ~${n} tok ===`;
  const cost = tokens([head(0), '', ...lines].join('\n'));
  return { lines: [head(cost), '', ...lines], cost, menus };
};

const verbs = {};

verbs.print = (list) => {
  for (const t of list) {
    const r = resolve(t);
    if (r?.ambiguous) {
      say(`"${t}" is a section in more than one document. Say which:`);
      for (const o of r.ambiguous) say(`  doc '${o}'`);
      say('');
    } else if (!r) {
      const n = near(t);
      say(`no chunk matches "${show(t)}".`);
      if (n.length) out.push(...n);
      else if (/^[a-z]+$/i.test(t) && list.length > 1)
        say(`  "${t}" is not a command either. Commands: slice, brief, why, grep, toc, check`);
      else say(`  ids look like: spec §4.11 · hb §7 · arch §3 · D-57 · S-21`);
      say('');
    } else emit(C[r]);
  }
};

// Every id given gets a brief. `doc slice S-01 S-02` used to build S-01 and drop S-02 in
// silence.
verbs.slice = (ids) => {
  if (!ids.length) return say('which slice? e.g. doc slice S-21. List them: doc toc slices');
  ids.forEach((id, i) => {
    if (i) say('');
    const r = resolve(id);
    if (!r || r.ambiguous) {
      const n = near(id);
      say(`no slice matches "${show(id)}".`);
      if (n.length) out.push(...n);
      else say('  slice ids look like S-01 … S-31 and P0-1 … P0-9. List them: doc toc slices');
      return;
    }
    const slice = C[r];
    if (!slice.flags.includes('row')) {
      const d = slice.display || r;
      return say(`${d} is not a slice. To read it: doc ${d}. To list the slices: doc toc slices`);
    }
    out.push(...render(slice).lines);
  });
};

// Every document calls the output a brief, so `doc brief S-21` is what someone types. It
// used to fall through to print, which returned the one-line row and none of the sections,
// looking like a successful retrieval.
verbs.brief = verbs.slice;

verbs.why = ([id]) => {
  if (!id) return say('which decision? e.g. doc why D-57');
  const r = resolve(id);
  if (!r || r.ambiguous) return verbs.print([id]);
  const c = C[r];
  say(`=== why ${c.display || r} · ${c.citedBy.length} inbound citations ===`);
  say(`${c.display || ''} ${c.title}`.trim());
  say(
    `${c.path}:${c.span.start}-${c.span.end} · ${c.tokens} tok${c.flags.includes('risk') ? ' · risk accepted' : ''}`,
  );
  if (c.flags.includes('superseded')) say(`${c.retiredAs} ${c.supersededBy}`);
  say('');
  say('REOPENING THIS BREAKS:');
  const groups = {};
  for (const b of c.citedBy) (groups[C[b] ? C[b].file : 'other'] ||= []).push(C[b]?.display || b);
  for (const [k, v] of Object.entries(groups)) say(`  ${k.padEnd(7)} ${v.join(' ')}`);
  say('');
  say(body(c));
};

verbs.grep = (list) => {
  const term = list.join(' ').trim();
  if (!term) return say('grep needs a term: doc grep variant_version');
  // A term longer than any heading is a mistake, and past ~40k it exceeds the regex limit.
  if (term.length > 200) return say(`that term is ${term.length} characters. Try a shorter one.`);
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const hits = Object.values(C)
    .map((c) => ({
      c,
      n: (
        c.segments
          .map((s) => s.text)
          .join('\n')
          .match(re) || []
      ).length,
    }))
    .filter((h) => h.n)
    .sort((a, b) => b.n - a.n);
  say(`=== grep ${term} · ${hits.length} sections ===`);
  say('');
  for (const { c, n } of hits) {
    say(
      `${String(n).padStart(3)}x  ${(c.display || c.slug).padEnd(16)} ~${String(cost(c)).padStart(5)} tok  ${c.path}:${c.selfSpan.start}`,
    );
    say(`      ${c.abstract}`);
  }
  if (!hits.length) say(`nothing in docs/ mentions "${term}".`);
};

verbs.toc = ([key]) => {
  const fk = fileKey(key);
  if (!fk)
    return say(
      `${key ? `unknown file "${show(key)}". ` : ''}Which file? One of: spec hb dlog arch slices`,
    );
  const list = Object.values(C).filter((c) => c.file === fk && c.level < 9);
  const rows = Object.values(C).filter((c) => c.file === fk && c.flags.includes('row'));
  const n = rows.length
    ? `${list.length} sections, ${rows.length} slices`
    : `${list.length} sections`;
  say(`=== toc ${FILES[fk].label || fk} · ${n} · ${FILES[fk].path} ===`);
  say('');
  for (const c of list) {
    const pad = '  '.repeat(Math.max(0, Math.min(c.level, 5) - 1));
    const sum = c.abstract !== c.title || c.flags.includes('superseded') ? `  ${gist(c)}` : '';
    say(
      `${String(c.tokens).padStart(6)} tok  ${pad}${(c.display || '').padEnd(12)} ${c.title}${sum}`.slice(
        0,
        160,
      ),
    );
  }
  // The slices are the point of this file, and what matters about one before you start is
  // what its brief costs. Derived, so it cannot disagree with the brief.
  if (!rows.length) return;
  say('');
  say(`    what \`doc slice <id>\` costs. + means a cited section is too large to print,`);
  say(`    so the brief lists its parts and you read one more:`);
  let phase = null;
  for (const r of rows) {
    const p = phaseOf(r);
    if (p && p !== phase) (say(''), say(`    ${p.title}`), (phase = p));
    const { cost, menus } = render(r);
    say(
      `      ~${String(cost).padStart(5)} tok${menus ? ' +' : '  '} ${(r.key || '').padEnd(6)} ${r.title}`.slice(
        0,
        150,
      ),
    );
  }
};

verbs.check = () => {
  const e = [...index.errors];
  // Parsing clean is not the same as working. Render every brief, file reads included,
  // because the gate runs on every markdown commit and a crash in the slice path is
  // invisible to a parse check.
  for (const c of Object.values(C)) {
    if (!c.flags.includes('row')) continue;
    try {
      render(c);
    } catch (err) {
      e.push({
        code: 'brief-fails',
        file: c.path,
        line: c.span.start,
        msg: `${c.key}: ${err.message}`,
      });
    }
  }
  if (e.length) {
    console.log(`docs:check FAILED, ${e.length} error(s)`);
    for (const x of e) console.log(`  ${x.code}  ${x.file}:${x.line}  ${x.msg}`);
  } else {
    console.log(
      `docs:check ok  ${index.stats.chunks} sections, ${index.stats.citations} citations, 0 errors`,
    );
  }
  process.exit(e.length ? 1 : 0);
};

const [head, ...rest] = args;
if (!head || head === '--help' || head === '-h')
  console.log(
    'usage: doc <id|§n|D-nn>... | slice S-nn | why D-nn | grep <term> | toc <file> | check',
  );
else if (Object.hasOwn(verbs, head)) verbs[head](rest);
else verbs.print(args);
if (out.length) console.log(out.join('\n'));
