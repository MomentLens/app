// node scripts/doctor.mjs, or pnpm check:machine. Works from any directory in the repo.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file like doc.mjs, so running it from apps/mobile does not stack-trace.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(join(root, f), 'utf8').trim();
const pkg = JSON.parse(read('package.json'));

const WANT = {
  node: read('.nvmrc').replace(/^v/, ''),
  pnpm: pkg.packageManager.split('@')[1],
  python: read('worker/.python-version'),
  java: '17',
  xcode: { min: [26, 4], belowMajor: 27 },
};

// shell: true so Windows resolves pnpm.cmd and eas.cmd.
const run = (cmd) => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: root });
  return r.status === 0 ? `${r.stdout}\n${r.stderr}`.trim() : null;
};
const firstVersion = (text) => text?.match(/(\d+)\.(\d+)(?:\.(\d+))?/) ?? null;

let failures = 0;
const report = (ok, name, got, want, hint = '') => {
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(12)} got ${got ?? 'not found'}   want ${want}${!ok && hint ? `\n      ${hint}` : ''}`,
  );
};
// Worth knowing, but nothing breaks without it, so it does not fail the run.
const warn = (name, msg) => console.log(`WARN  ${name.padEnd(12)} ${msg}`);

const nodeGot = process.version.slice(1);
report(nodeGot === WANT.node, 'node', nodeGot, WANT.node, 'fnm install && fnm use  (reads .nvmrc)');

const pnpmGot = run('pnpm -v')?.split('\n').pop();
report(pnpmGot === WANT.pnpm, 'pnpm', pnpmGot, WANT.pnpm, `npm install -g pnpm@${WANT.pnpm}`);

const uvPython = run(`uv python find ${WANT.python}`);
const pyGot = uvPython ? firstVersion(run(`"${uvPython.split('\n')[0]}" --version`))?.[0] : null;
report(
  pyGot?.startsWith(`${WANT.python}.`),
  'python',
  pyGot,
  `${WANT.python}.x`,
  `uv python install ${WANT.python}`,
);

const javaGot = firstVersion(run('java -version'));
report(
  javaGot?.[1] === WANT.java,
  'java',
  javaGot?.[0],
  `${WANT.java}.x`,
  'Install JDK 17 and point JAVA_HOME at it',
);

const sdk = process.env.ANDROID_HOME;
report(Boolean(sdk && existsSync(sdk)), 'ANDROID_HOME', sdk, 'an existing Android SDK folder');
const adbGot = firstVersion(run('adb --version'))?.[0];
report(Boolean(adbGot), 'adb', adbGot, 'on PATH', 'Add <ANDROID_HOME>/platform-tools to PATH');

if (process.platform === 'darwin') {
  const x = firstVersion(run('xcodebuild -version'));
  const maj = Number(x?.[1]);
  const min = Number(x?.[2]);
  const ok =
    Boolean(x) &&
    maj < WANT.xcode.belowMajor &&
    (maj > WANT.xcode.min[0] || (maj === WANT.xcode.min[0] && min >= WANT.xcode.min[1]));
  report(ok, 'xcode', x?.[0], '26.4 to 26.x', 'xcodes install 26.6 --select');
}

if (process.platform === 'win32') {
  const crlf = run('git config --get core.autocrlf');
  report(
    crlf !== 'true',
    'git autocrlf',
    crlf ?? 'unset',
    'false or unset',
    'git config --global core.autocrlf false',
  );
}

// The rest is what differs between the three machines once the toolchain matches: without
// the hook the docs gate runs only in CI, and a missing key or venv fails at the first
// command an agent runs, far from its cause.
const hooks = run('git config --get core.hooksPath');
report(
  hooks === '.husky/_',
  'git hook',
  hooks,
  '.husky/_',
  'pnpm install  (its prepare script installs it)',
);

// Key names only. Never print a value from .env.
const keys = (f) => {
  const out = new Map();
  if (!existsSync(join(root, f))) return null;
  for (const line of read(f).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
    if (m) out.set(m[1], m[2].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
};
// .env.example documents two files. The root .env feeds the API and worker, and matters only
// to whoever runs them locally, since development runs against the server. apps/mobile/.env
// feeds the app on every machine, because Expo reads .env from the app folder only.
const example = keys('.env.example');
if (example) {
  const mobileWant = [...example.keys()].filter((k) => k.startsWith('EXPO_PUBLIC_'));
  const rootWant = [...example.keys()].filter((k) => !k.startsWith('EXPO_PUBLIC_'));
  const rootHave = keys('.env');
  const mobileHave = keys('apps/mobile/.env');
  report(
    Boolean(mobileHave?.get('EXPO_PUBLIC_API_URL')),
    'mobile .env',
    mobileHave
      ? mobileHave.get('EXPO_PUBLIC_API_URL')
        ? 'EXPO_PUBLIC_API_URL set'
        : 'no EXPO_PUBLIC_API_URL'
      : 'no apps/mobile/.env',
    'EXPO_PUBLIC_API_URL set',
    'Copy the EXPO_PUBLIC_ lines of .env.example into apps/mobile/.env and fill them in (Handbook §8)',
  );
  const mobileMissing = mobileWant.filter((k) => !mobileHave?.get(k));
  if (mobileHave && mobileMissing.length)
    warn('mobile .env', `empty or missing: ${mobileMissing.join(' ')}`);
  const misplaced = [...(rootHave?.keys() ?? [])].filter((k) => k.startsWith('EXPO_PUBLIC_'));
  report(
    !misplaced.length,
    'root .env',
    misplaced.length ? `holds ${misplaced.join(' ')}` : 'no EXPO_PUBLIC_ keys',
    'no EXPO_PUBLIC_ keys',
    'Move them to apps/mobile/.env. Expo never reads the root file',
  );
  const rootMissing = rootWant.filter((k) => !rootHave?.get(k));
  if (rootMissing.length)
    warn(
      'root .env',
      `empty or missing, needed only to run the API or worker locally: ${rootMissing.join(' ')}`,
    );
}

const venvPy = join(
  root,
  'worker',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const venvGot = existsSync(venvPy) ? firstVersion(run(`"${venvPy}" --version`))?.[0] : null;
report(
  venvGot?.startsWith(`${WANT.python}.`),
  'worker venv',
  venvGot,
  `${WANT.python}.x`,
  'cd worker && uv venv --python 3.12 && uv pip install -r requirements.txt',
);

if (run('gh auth status') === null)
  warn('gh', 'missing or not logged in, so /slice asks you instead of checking dependencies');

// WSL2 reaches the Windows drive through a slow network filesystem that breaks file watching.
if (process.platform === 'linux' && root.startsWith('/mnt/'))
  warn('repo path', `${root} is on the Windows drive; clone into ~/ inside WSL2 (Handbook §9)`);

console.log(failures ? `\n${failures} check(s) failed.` : '\nMachine matches the repo pins.');
process.exit(failures ? 1 : 0);
