// Run from the repo root: node scripts/doctor.mjs
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
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
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
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

console.log(failures ? `\n${failures} check(s) failed.` : '\nMachine matches the repo pins.');
process.exit(failures ? 1 : 0);
