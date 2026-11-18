import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Every external command is a shell function. No server or service is contacted.
const harness = `
id() { printf '0\\n'; }
function [() {
  case "$1" in -d|-f|-x) return 0 ;; esac
  builtin [ "$@"
}
runuser() {
  case "$*" in
    *'rev-parse --abbrev-ref HEAD'*) printf 'main\\n' ;;
    *'rev-parse HEAD'*) printf 'same-head\\n' ;;
    *'hash-object --no-filters --stdin'*) cat > /dev/null; printf 'running-copy\\n' ;;
    *'hash-object --no-filters scripts/deploy.sh'*) printf '%s\\n' "\${PULLED_HASH:-running-copy}" ;;
    *'/pip install '*) printf 'worker-install\\n' >> "$AUDIT_LOG"; builtin [ "\${FAIL_WORKER:-0}" != 1 ] ;;
    *'app.ai.fetch_model'*) printf 'model-fetch\\n' >> "$AUDIT_LOG"; builtin [ "\${FAIL_MODEL:-0}" != 1 ] ;;
    *) return 0 ;;
  esac
}
systemctl() { printf '%s\\n' "$*" >> "$AUDIT_LOG"; }
curl() {
  case "$*" in
    *:8000/*) printf '%s' "\${WORKER_HEALTH:-200}" ;;
    *) printf '200' ;;
  esac
}
sleep() { :; }
sed() { printf '3000\\n'; }
audit_script="$1"
shift
source "$audit_script" "$@"
`;
const script = new URL('./deploy.sh', import.meta.url).pathname;
test('retries the worker at the same Git head after a failed deploy or --skip-worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momentlens-deploy-'));
  const log = join(dir, 'calls');
  const run = (args = [], fail = false) =>
    spawnSync('bash', ['-c', harness, 'audit', script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AUDIT_LOG: log, FAIL_WORKER: fail ? '1' : '0' },
    });
  try {
    const failed = run([], true);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /Updating the worker/, failed.stderr);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /restart momentlens-worker/);
    assert.equal(run().status, 0);
    assert.match(
      readFileSync(log, 'utf8'),
      /worker-install\nmodel-fetch\nenable momentlens-worker\nrestart momentlens-worker/,
    );
    const before = readFileSync(log, 'utf8').match(/worker-install/g)?.length;
    assert.equal(run(['--skip-worker']).status, 0);
    assert.equal(readFileSync(log, 'utf8').match(/worker-install/g)?.length, before);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(log, 'utf8').match(/worker-install/g)?.length, before + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the restarted worker never answers /health', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momentlens-deploy-'));
  const run = (env) =>
    spawnSync('bash', ['-c', harness, 'audit', script], {
      encoding: 'utf8',
      env: { ...process.env, AUDIT_LOG: join(dir, 'calls'), FAIL_WORKER: '0', ...env },
    });
  try {
    const down = run({ WORKER_HEALTH: '000' });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /worker's \/health did not answer/);
    const up = run({ WORKER_HEALTH: '200' });
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /The worker's \/health answered HTTP 200/);
    const skipped = spawnSync('bash', ['-c', harness, 'audit', script, '--skip-worker'], {
      encoding: 'utf8',
      env: { ...process.env, AUDIT_LOG: join(dir, 'calls'), WORKER_HEALTH: '000' },
    });
    assert.equal(skipped.status, 0, skipped.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leaves the worker running as it was when the model fetch fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momentlens-deploy-'));
  const log = join(dir, 'calls');
  try {
    const failed = spawnSync('bash', ['-c', harness, 'audit', script], {
      encoding: 'utf8',
      env: { ...process.env, AUDIT_LOG: log, FAIL_WORKER: '0', FAIL_MODEL: '1' },
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /buffalo_l could not be fetched/);
    assert.match(readFileSync(log, 'utf8'), /worker-install\nmodel-fetch\n/);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /momentlens-worker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-runs a deploy.sh that the pull changed, once, and leaves an unchanged one alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'momentlens-deploy-'));
  const log = join(dir, 'calls');
  // exec looks bash up on PATH, so this stand-in catches the re-run. It logs the call, then runs
  // the harness again with this checkout's deploy.sh in place of /srv/momentlens/scripts/deploy.sh.
  const stub = join(dir, 'bash');
  writeFileSync(
    stub,
    '#!/bin/sh\nprintf \'reexec %s BEFORE=%s\\n\' "$*" "$MOMENTLENS_DEPLOY_BEFORE" >> "$AUDIT_LOG"\n' +
      'shift\nexec /bin/bash -c "$HARNESS" audit "$DEPLOY_SCRIPT" "$@"\n',
  );
  chmodSync(stub, 0o755);
  const run = (env) =>
    spawnSync('/bin/bash', ['-c', harness, 'audit', script, '--skip-worker'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        AUDIT_LOG: log,
        HARNESS: harness,
        DEPLOY_SCRIPT: script,
        ...env,
      },
    });
  try {
    const unchanged = run({});
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.doesNotMatch(unchanged.stdout, /changed in the pull/);
    assert.equal(readFileSync(log, 'utf8').match(/^reexec/gm), null);

    const changed = run({ PULLED_HASH: 'pulled-copy' });
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(changed.stdout.match(/changed in the pull/g)?.length, 1);
    assert.equal(changed.stdout.match(/==> Done/g)?.length, 1);
    assert.deepEqual(readFileSync(log, 'utf8').match(/^reexec.*$/gm), [
      'reexec /srv/momentlens/scripts/deploy.sh --skip-worker BEFORE=same-head',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
