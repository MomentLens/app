import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    *'/pip install '*) printf 'worker-install\\n' >> "$AUDIT_LOG"; builtin [ "\${FAIL_WORKER:-0}" != 1 ] ;;
    *) return 0 ;;
  esac
}
systemctl() { printf '%s\\n' "$*" >> "$AUDIT_LOG"; }
curl() { printf '200'; }
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
      /worker-install\nenable momentlens-worker\nrestart momentlens-worker/,
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
