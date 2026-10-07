// The checks CI runs, runnable on any machine, so local verification and CI cannot drift (D-149).
//
//   node scripts/verify.mjs api mobile          lint, typecheck, test and build for those packages
//   node scripts/verify.mjs all --base origin/feat/s-12-schema --slice S-12
//   node scripts/verify.mjs --plan rls worker-sql --base origin/main
//
// Targets: docs, format, worker, rls, worker-sql, any workspace package by folder name (api,
// mobile, shared-types), packages for all of those, or all. Each check prints one row: passed, failed, skipped with its
// reason, or unavailable with what is missing. Full output goes to .slices/<slice>/, or
// .slices/verify/ without --slice, and CI prints it too.
//
// rls and worker-sql run against the shared dev project, so they run only when a path they
// test changed against --base (default origin/main): supabase/ or apps/api/ for rls, worker/ or
// supabase/ for worker-sql, and this script or CI's workflow for both. --force runs them anyway.
// --strict counts an unavailable check as a failure; CI passes it, because there a missing
// secret or tool is a broken job, not a machine without it. --plan prints what would run.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const base = option('--base') || 'origin/main';
const slice = option('--slice');
const strict = flag('--strict');
const force = flag('--force');
const ci = Boolean(process.env.GITHUB_ACTIONS);
const optionValues = new Set([option('--base'), option('--slice')]);
const wanted = argv.filter((a) => !a.startsWith('--') && !optionValues.has(a));

const run = (cmd, args, cwd = root, env = {}) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256e6,
    shell: process.platform === 'win32',
  });
const has = (cmd) => run(cmd, ['--version']).status === 0;

// Workspace packages, read from the folders pnpm-workspace.yaml names, so a new package is
// checked without editing this file. Each runs the scripts it has, as `pnpm -r --if-present`.
const packages = ['apps', 'packages'].flatMap((dir) =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, dir, d.name, 'package.json')))
    .map((d) => {
      const pkg = JSON.parse(readFileSync(join(root, dir, d.name, 'package.json'), 'utf8'));
      return { folder: d.name, name: pkg.name, scripts: pkg.scripts ?? {} };
    }),
);
// The API's build is the only build CI runs; the app builds through EAS (Handbook §13.1).
const SCRIPTS = { api: ['lint', 'typecheck', 'test', 'build'] };

// Key names only, never a value. test:rls and the worker's dev SQL test both read the root .env.
const envKeys = () => {
  const out = new Set(Object.keys(process.env).filter((k) => process.env[k]));
  if (existsSync(join(root, '.env')))
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(\S.*)?$/);
      if (m?.[2]) out.add(m[1]);
    }
  return out;
};
const missingKeys = (keys) => {
  const have = envKeys();
  return keys.filter((k) => !have.has(k));
};

// The worker's Python: its venv on a developer's machine, the job's Python in CI. One without
// Ruff and pytest is not the worker's, so its checks are unavailable rather than failed.
let pyCache;
const python = () => {
  if (pyCache !== undefined) return pyCache;
  const venv = join(
    root,
    'worker',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const usable = (p) =>
    run(p, ['-m', 'ruff', '--version']).status === 0 &&
    run(p, ['-m', 'pytest', '--version']).status === 0;
  pyCache =
    [venv, 'python3', 'python'].find((p) => (p !== venv || existsSync(p)) && usable(p)) ?? null;
  return pyCache;
};

let changedCache = null;
const changed = () => {
  if (changedCache) return changedCache;
  const lines = (r) => (r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null);
  const committed = lines(run('git', ['diff', '--name-only', `${base}...HEAD`]));
  if (committed === null)
    return (changedCache = { error: `git cannot compare with ${base}; fetch it first` });
  const local = [
    ...(lines(run('git', ['diff', '--name-only', 'HEAD'])) ?? []),
    ...(lines(run('git', ['ls-files', '--others', '--exclude-standard'])) ?? []),
  ];
  return (changedCache = { files: [...new Set([...committed, ...local])] });
};
const SELF_PATHS = ['scripts/verify.mjs', '.github/workflows/ci.yml'];
const touches = (prefixes) => {
  const c = changed();
  if (c.error) return { error: c.error };
  return {
    hit: c.files.some((f) => prefixes.some((p) => f.startsWith(p)) || SELF_PATHS.includes(f)),
  };
};
// A check that needs the dev project, gated on its paths. Returns a reason to skip, or null.
const gate = (prefixes) => {
  if (force) return null;
  const t = touches(prefixes);
  if (t.error) return { unavailable: t.error };
  return t.hit
    ? null
    : { skipped: `nothing under ${prefixes.join(' or ')} changed against ${base}` };
};

// Every check: a name, the target it belongs to, and how to run it. `need` returns what is
// missing to run it, or null.
const checks = [];
const add = (target, name, cmd, args, opts = {}) =>
  checks.push({ target, name, cmd, args, ...opts });

add('docs', 'docs check', 'node', ['scripts/doc.mjs', 'check']);
add('docs', 'docs tests', 'node', ['--test', 'scripts/*.test.mjs']);
add('format', 'format', 'pnpm', ['format:check'], { need: () => (has('pnpm') ? null : 'pnpm') });
for (const p of packages)
  for (const s of SCRIPTS[p.folder] ?? ['lint', 'typecheck', 'test'])
    if (p.scripts[s])
      add(p.folder, `${p.folder} ${s}`, 'pnpm', ['--filter', p.name, s], {
        need: () => (has('pnpm') ? null : 'pnpm'),
      });
const py = () => python();
const pyNeed = () =>
  py() ? null : 'a Python with Ruff and pytest; create worker/.venv as root AGENTS.md says';
add('worker', 'worker ruff', () => py(), ['-m', 'ruff', 'check', '.'], {
  cwd: 'worker',
  need: pyNeed,
});
add('worker', 'worker ruff format', () => py(), ['-m', 'ruff', 'format', '--check', '.'], {
  cwd: 'worker',
  need: pyNeed,
});
add('worker', 'worker pytest', () => py(), ['-m', 'pytest'], { cwd: 'worker', need: pyNeed });
add('rls', 'rls', 'pnpm', ['--filter', 'api', 'test:rls'], {
  gate: () => gate(['supabase/', 'apps/api/']),
  need: () => {
    const m = missingKeys(['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY']);
    if (!has('pnpm')) m.unshift('pnpm');
    return m.length ? m.join(', ') : null;
  },
});
add(
  'worker-sql',
  'worker sql',
  () => py(),
  ['-m', 'pytest', 'tests/test_dev_sql.py', '--dev-sql'],
  {
    cwd: 'worker',
    gate: () => gate(['worker/', 'supabase/']),
    need: () => pyNeed() ?? (missingKeys(['DATABASE_URL']).length ? 'DATABASE_URL' : null),
  },
);

const targets = new Set(checks.map((c) => c.target));
// `packages` is every workspace package, so CI names no package and misses no new one.
const list = [
  ...new Set(
    wanted.flatMap((t) =>
      t === 'all' ? [...targets] : t === 'packages' ? packages.map((p) => p.folder) : [t],
    ),
  ),
];
const unknown = list.filter((t) => !targets.has(t));
if (!list.length || unknown.length) {
  console.log(
    `${unknown.length ? `unknown target: ${unknown.join(' ')}. ` : ''}usage: node scripts/verify.mjs <target...> [--base <ref>] [--slice <id>] [--strict] [--force] [--plan]\ntargets: ${[...targets].join(' ')} packages all`,
  );
  process.exit(2);
}
const selected = checks.filter((c) => list.includes(c.target));

// Decide each check's fate before running any, so --plan and a real run agree.
const decide = (c) => {
  const g = c.gate?.();
  if (g?.skipped) return { result: 'skipped', note: g.skipped };
  if (g?.unavailable) return { result: 'unavailable', note: g.unavailable };
  const missing = c.need?.();
  if (missing) return { result: 'unavailable', note: `needs ${missing}` };
  return { result: 'run' };
};

if (flag('--plan')) {
  const runs = new Map();
  for (const c of selected) {
    const d = decide(c);
    console.log(`${c.name.padEnd(20)} ${d.result === 'run' ? 'runs' : `${d.result}: ${d.note}`}`);
    // A gated target counts as running when its gate opens, even if this machine lacks the
    // secret: the job that installs and runs it is where a missing secret should fail.
    const g = c.gate?.();
    runs.set(c.target, (runs.get(c.target) ?? false) || !g?.skipped);
  }
  if (process.env.GITHUB_OUTPUT)
    for (const [t, r] of runs)
      appendFileSync(process.env.GITHUB_OUTPUT, `${t.replace(/-/g, '_')}=${r}\n`);
  process.exit(0);
}

const logs = join(root, '.slices', slice || 'verify');
mkdirSync(logs, { recursive: true });
const rows = [];
for (const c of selected) {
  const d = decide(c);
  if (d.result !== 'run') {
    rows.push({ name: c.name, result: d.result, note: d.note, log: '' });
    continue;
  }
  const cmd = typeof c.cmd === 'function' ? c.cmd() : c.cmd;
  const r = run(cmd, c.args, join(root, c.cwd ?? ''));
  const out = `$ ${[cmd, ...c.args].join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  const log = join(logs, `${c.name.replace(/\s+/g, '-')}.log`);
  writeFileSync(log, out);
  if (ci) console.log(`::group::${c.name}\n${out}\n::endgroup::`);
  rows.push({
    name: c.name,
    result: r.status === 0 ? 'passed' : 'failed',
    note: r.status === 0 ? '' : `exit ${r.status ?? r.signal}`,
    log: log.slice(root.length + 1),
  });
}

console.log('| Check | Result | Log |\n|---|---|---|');
for (const r of rows)
  console.log(`| ${r.name} | ${r.result}${r.note ? `: ${r.note}` : ''} | ${r.log} |`);
const failed = rows.filter((r) => r.result === 'failed' || (strict && r.result === 'unavailable'));
process.exit(failed.length ? 1 : 0);
