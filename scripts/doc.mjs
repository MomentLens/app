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
import { buildIndex, FILES } from './docindex.mjs';

// Anchored to this file, not the shell's directory, so `node ../../scripts/doc.mjs D-57`
// works from anywhere in the repo.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Past this a parent prints its own preamble and a menu of children instead of the subtree.
const MENU_OVER = 800;

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fileFlag = (process.argv.find((a) => a.startsWith('--file=')) || '').slice(7) || null;
let index;
try {
  index = buildIndex();
} catch (e) {
  // A missing or unreadable doc cannot be recovered from. Say which, never stack-trace.
  // Retrieval exits 0 so a broken doc never fails the caller; the gate exits 1, because
  // a gate that cannot read the docs has not passed.
  console.log(`doc: ${e.message}`);
  process.exit(process.argv.includes('check') ? 1 : 0);
}
const C = index.chunks;
const num = (s) => s.toLowerCase().replace(/^[§#]/, '');

// "doc arch §3" arrives as two words. Rejoin a file label with the section that follows it.
const LABELS = new Set([...Object.keys(FILES), ...Object.values(FILES).flatMap((f) => f.prefixes)]);
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (LABELS.has(argv[i]) && /^§/.test(argv[i + 1] || ''))
    (args.push(`${argv[i]} ${argv[i + 1]}`), i++);
  else args.push(argv[i]);
}

const resolve = (token) => {
  const t = token.trim();
  // A bare §n is a real section in three of the five docs. Guessing which is exactly the
  // failure that looks correct and throws nothing, so refuse and name the choices.
  if (/^§?\d+(\.\d+)*$/.test(t) && !fileFlag) {
    const all = Object.values(C).filter((c) => c.number === num(t));
    if (all.length > 1) return { ambiguous: all.map((c) => c.display) };
    if (all.length === 1) return all[0].slug;
  }
  const scoped = t.match(/^(\w+):(.+)$/);
  const key = scoped ? scoped[1] : fileFlag;
  if (key && FILES[key]) {
    const hit = Object.values(C).find(
      (c) => c.file === key && c.number === num(scoped ? scoped[2] : t),
    );
    if (hit) return hit.slug;
  }
  if (C[t]) return t;
  if (index.byAlias[t]) return index.byAlias[t];
  if (index.byAlias[t.toUpperCase()]) return index.byAlias[t.toUpperCase()];
  const near = Object.keys(C).filter((s) => s.split('/')[1]?.startsWith(num(t)));
  return near.length === 1 ? near[0] : null;
};

const near = (t) =>
  Object.values(C)
    .filter((c) => c.slug.includes(num(t)) || c.title.toLowerCase().includes(num(t)))
    .slice(0, 5)
    .map((c) => `  ${c.display || c.slug}  ${c.title}`);

const files = new Map();
const read = (path, a, b) => {
  if (!files.has(path))
    files.set(path, readFileSync(join(root, ...path.split('/')), 'utf8').split('\n'));
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
const emit = (c) => {
  const id = c.display || c.slug;
  const flags = c.flags.includes('risk') ? ' · risk accepted' : '';
  say(`--- ${id} · ${c.path}:${c.span.start}-${c.span.end} · ${c.tokens} tok${flags}`);
  if (c.flags.includes('superseded'))
    say(`!!! SUPERSEDED BY ${c.supersededBy}. Do not build from it.`);
  say('');
  if (c.children.length && c.tokens > MENU_OVER) {
    say(body(c, true));
    say('');
    say(`    ${c.children.length} sections under this one (${c.tokens} tok in total):`);
    for (const ch of c.children) {
      const k = C[ch];
      say(
        `      ${String(k.tokens).padStart(5)} tok  ${(k.display || k.slug).padEnd(14)} ${k.abstract}`,
      );
    }
    say('');
    return c.selfTokens;
  }
  say(body(c));
  say('');
  return c.tokens;
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
      say(`no chunk matches "${t}".`);
      if (n.length) out.push(...n);
      else say(`  ids look like: spec §4.11 · hb §7 · arch §3 · D-57 · S-21`);
      say('');
    } else emit(C[r]);
  }
};

verbs.slice = ([id]) => {
  const r = resolve(id);
  if (!r || r.ambiguous) {
    const n = near(id || '');
    say(`no slice matches "${id}".`);
    if (n.length) out.push(...n);
    else say('  slice ids look like S-01 … S-31 and P0-1 … P0-9. List them: doc toc slices');
    return;
  }
  const slice = C[r];
  const expand = [r];
  const next = [];
  const seen = new Set([r]);
  for (const id2 of slice.cites) {
    if (seen.has(id2)) continue;
    seen.add(id2);
    // Never expand a retracted decision into a brief. Four of them sit one hop from S-21,
    // the slice holding the image-serving authorization check.
    if (C[id2].flags.includes('superseded')) next.push(id2);
    else expand.push(id2);
  }
  for (const id2 of expand.slice(1))
    for (const n of C[id2].cites) if (!seen.has(n)) (seen.add(n), next.push(n));

  let total = 0;
  for (const s of expand) total += emit(C[s]);
  for (const s of next.filter((x) => C[x].flags.includes('superseded'))) {
    say(`--- ${C[s].display} NOT EXPANDED`);
    say(`    ${C[s].abstract}`);
    say(`    SUPERSEDED BY ${C[s].supersededBy}. Do not build from it.`);
    say('');
  }
  out.unshift(`=== slice ${slice.key || id} · ${expand.length} sections · ~${total} tok ===`, '');
  say(`one hop out: ${next.map((s) => C[s].display || s).join(' ')}`);
};

verbs.why = ([id]) => {
  const r = resolve(id);
  if (!r || r.ambiguous) return verbs.print([id]);
  const c = C[r];
  say(`=== why ${c.display || r} · ${c.citedBy.length} inbound citations ===`);
  say(`${c.display || ''} ${c.title}`.trim());
  say(
    `${c.path}:${c.span.start}-${c.span.end} · ${c.tokens} tok${c.flags.includes('risk') ? ' · risk accepted' : ''}`,
  );
  if (c.flags.includes('superseded')) say(`SUPERSEDED BY ${c.supersededBy}`);
  say('');
  say('REOPENING THIS BREAKS:');
  const groups = {};
  for (const b of c.citedBy) (groups[C[b] ? C[b].file : 'other'] ||= []).push(C[b]?.display || b);
  for (const [k, v] of Object.entries(groups)) say(`  ${k.padEnd(7)} ${v.join(' ')}`);
  say('');
  say(body(c));
};

verbs.grep = (list) => {
  const term = list.join(' ');
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const hits = Object.values(C)
    .map((c) => ({ c, n: (body(c, true).match(re) || []).length }))
    .filter((h) => h.n)
    .sort((a, b) => b.n - a.n);
  say(`=== grep ${term} · ${hits.length} sections ===`);
  say('');
  for (const { c, n } of hits) {
    say(
      `${String(n).padStart(3)}x  ${(c.display || c.slug).padEnd(16)} ${String(c.selfTokens).padStart(5)} tok  ${c.path}:${c.selfSpan.start}`,
    );
    say(`      ${c.abstract}`);
  }
  if (!hits.length) say(`nothing in docs/ mentions "${term}".`);
};

verbs.toc = ([key]) => {
  if (!FILES[key]) return say(`unknown file "${key}". One of: ${Object.keys(FILES).join(' ')}`);
  const list = Object.values(C).filter((c) => c.file === key && c.level < 9);
  say(`=== toc ${key} · ${list.length} sections · ${FILES[key].path} ===`);
  say('');
  for (const c of list) {
    const pad = '  '.repeat(Math.max(0, Math.min(c.level, 5) - 1));
    const sum = c.abstract !== c.title ? `  ${c.abstract}` : '';
    say(
      `${String(c.tokens).padStart(6)} tok  ${pad}${(c.display || '').padEnd(12)} ${c.title}${sum}`.slice(
        0,
        160,
      ),
    );
  }
};

verbs.check = () => {
  const e = index.errors;
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
if (!head)
  console.log(
    'usage: doc <id|§n|D-nn>... | slice S-nn | why D-nn | grep <term> | toc <file> | check',
  );
else if (verbs[head]) verbs[head](rest);
else verbs.print(args);
if (out.length) console.log(out.join('\n'));
