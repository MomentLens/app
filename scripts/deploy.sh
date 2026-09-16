#!/usr/bin/env bash
# Deploys the checked-out branch onto a server that scripts/provision.sh already set up:
# pull, install, build the API, restart it, and touch the worker only when something
# under worker/ changed. Handbook §13, "Deploying an update".
#
# It installs no system packages, writes no secrets, and leaves nginx and TLS alone.
# When a pinned toolchain version changes, run provision.sh again instead.
#
# On the server:
#   sudo bash /srv/momentlens/scripts/deploy.sh
# From your own machine:
#   ssh SERVER 'sudo bash /srv/momentlens/scripts/deploy.sh'
#
#   --branch        branch to deploy (default: the one already checked out)
#   --skip-worker   leave the worker alone even if its files changed

set -euo pipefail
umask 022

APP_USER="momentlens"
APP_HOME="/var/lib/momentlens"
APP_DIR="/srv/momentlens"
ENV_FILE="$APP_DIR/.env"
BRANCH=""
SKIP_WORKER=0

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy.sh [--branch NAME] [--skip-worker]
Run as root on a server that scripts/provision.sh has already set up.
EOF
  exit "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage 0 ;;
    --skip-worker)
      SKIP_WORKER=1
      shift
      ;;
    --branch)
      [ $# -ge 2 ] || die "--branch needs a value"
      BRANCH="$2"
      shift 2
      ;;
    *) usage 1 ;;
  esac
done

# --- Preconditions ------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run as root, for example: sudo bash $APP_DIR/scripts/deploy.sh"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. Run scripts/provision.sh first."
[ -f /etc/systemd/system/momentlens-api.service ] ||
  die "momentlens-api.service does not exist. Run scripts/provision.sh first."

as_app() {
  runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="/usr/local/bin:/usr/bin:/bin" HUSKY=0 "$@"
}
git_app() { as_app git -C "$APP_DIR" "$@"; }

[ -n "$BRANCH" ] || BRANCH="$(git_app rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "The checkout is on a detached HEAD. Pass --branch NAME."

# --- Pull -----------------------------------------------------------------------------

log "Deploying $BRANCH"
BEFORE="$(git_app rev-parse HEAD)"
git_app fetch --prune origin
git_app checkout "$BRANCH"
git_app merge --ff-only "origin/$BRANCH"
AFTER="$(git_app rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  note "Already at $AFTER. Rebuilding anyway, in case an earlier run stopped half way."
else
  note "$BEFORE -> $AFTER"
fi

# --- API ------------------------------------------------------------------------------

log "Installing dependencies and building the API"
# Filtered to the API and its workspace dependencies. The server never runs apps/mobile.
as_app pnpm --dir "$APP_DIR" install --filter "api..." --frozen-lockfile
as_app pnpm --dir "$APP_DIR" --filter api build

log "Restarting momentlens-api"
systemctl restart momentlens-api

# --- Worker ---------------------------------------------------------------------------

WORKER_READY=0
if [ -f "$APP_DIR/worker/requirements.txt" ] &&
  [ -f "$APP_DIR/worker/app/main.py" ] &&
  [ -f /etc/systemd/system/momentlens-worker.service ]; then
  WORKER_READY=1
fi

# True when this deploy brought in a change under worker/.
worker_changed() {
  [ "$BEFORE" != "$AFTER" ] || return 1
  ! git_app diff --quiet "$BEFORE" "$AFTER" -- worker/
}

if [ "$WORKER_READY" -eq 0 ]; then
  note "Skipped: worker/app/main.py, worker/requirements.txt or the unit does not exist yet."
elif [ "$SKIP_WORKER" -eq 1 ]; then
  note "Skipped because --skip-worker was passed."
elif worker_changed || ! systemctl is-enabled --quiet momentlens-worker; then
  log "Updating the worker"
  [ -x "$APP_DIR/worker/.venv/bin/pip" ] || die "worker/.venv is missing. Run scripts/provision.sh."
  as_app "$APP_DIR/worker/.venv/bin/pip" install --requirement "$APP_DIR/worker/requirements.txt"
  systemctl enable momentlens-worker
  systemctl restart momentlens-worker
else
  note "Nothing under worker/ changed, so the worker was left running."
fi

# --- Check ----------------------------------------------------------------------------

API_PORT="$( (sed -n 's/^PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$ENV_FILE" 2>/dev/null || true) | tail -n 1)"
API_PORT="${API_PORT:-3000}" # apps/api falls back to 3000 when PORT is empty

log "Checking the API on port $API_PORT"
code="000"
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/" || true)"
  [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" != "000" ] ||
  die "The API is not answering on port $API_PORT. Read its log with: journalctl -u momentlens-api -n 50"
note "The API answered with HTTP $code."

log "Done"
note "Logs: journalctl -u momentlens-api -f    and    journalctl -u momentlens-worker -f"
