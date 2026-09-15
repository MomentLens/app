#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 server for MomentLens end to end: system packages, the
# Node, pnpm and Python versions the repo pins, the momentlens service user, the repo
# checkout and API build, both systemd units, nginx, the firewall and TLS.
# Handbook §13 explains each step. Every step checks before it acts, so running the
# script again is safe, and running it again is also how the server picks up a new pin.
#
# It does not deploy later code changes (Handbook §13, "Deploying an update"), and it
# never writes secrets. Fill in /srv/momentlens/.env yourself.
#
# From your own machine:
#   scp scripts/provision.sh root@SERVER_IP:/root/
#   ssh root@SERVER_IP 'bash /root/provision.sh --domain api.example.com --email you@example.com'
# Or, logged in as a sudo user on the server:
#   sudo bash provision.sh --domain api.example.com --email you@example.com
#
#   --domain   hostname nginx serves and certbot certifies (required)
#   --email    Let's Encrypt account email. Passing it accepts Let's Encrypt's terms.
#              Leave it out to skip TLS until DNS points at this server.
#   --branch   branch to check out (default: main)
#   --repo     git URL to clone (default: the public MomentLens repo)

set -euo pipefail
umask 022

REPO_URL="https://github.com/MomentLens/app.git"
BRANCH="main"
DOMAIN=""
EMAIL=""

APP_USER="momentlens"
APP_HOME="/var/lib/momentlens" # kept outside the checkout so caches never land in the git tree
APP_DIR="/srv/momentlens"
ENV_FILE="$APP_DIR/.env"

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: provision.sh --domain HOSTNAME [--email ADDRESS] [--branch NAME] [--repo URL]
Run as root on a fresh Ubuntu 24.04 server. See the header of this file for details.
EOF
  exit "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage 0 ;;
    --domain | --email | --branch | --repo)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --domain) DOMAIN="$2" ;;
        --email) EMAIL="$2" ;;
        --branch) BRANCH="$2" ;;
        --repo) REPO_URL="$2" ;;
      esac
      shift 2
      ;;
    *) usage 1 ;;
  esac
done

# --- Preconditions ------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run as root, for example: sudo bash provision.sh --domain api.example.com"
[ -n "$DOMAIN" ] || usage 1
# The hostname goes into the nginx config, so accept hostname characters only.
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "Not a valid hostname: $DOMAIN"
if [ -n "$EMAIL" ]; then
  [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "Not a valid email address: $EMAIL"
fi

# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "This script needs Ubuntu 24.04 LTS, the release that ships Python 3.12. This server runs ${PRETTY_NAME:-an unknown OS}."
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

# Oracle Cloud's Ubuntu images ship iptables rules that reject everything except SSH, and
# ufw conflicts with them, so on those images the firewall step edits iptables instead.
# Delete this detection and the Oracle branch of the firewall step once nothing runs on Oracle.
ORACLE_IMAGE=0
if grep -qs 'InstanceServices' /etc/iptables/rules.v4; then
  ORACLE_IMAGE=1
fi

as_app() {
  runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="/usr/local/bin:/usr/bin:/bin" HUSKY=0 "$@"
}

# --- System packages -----------------------------------------------------------------

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
apt-get update
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
packages=(ca-certificates curl git xz-utils build-essential nginx python3.12 python3.12-venv certbot python3-certbot-nginx)
if [ "$ORACLE_IMAGE" -eq 1 ]; then
  echo 'iptables-persistent iptables-persistent/autosave_v4 boolean true' | debconf-set-selections
  echo 'iptables-persistent iptables-persistent/autosave_v6 boolean true' | debconf-set-selections
  packages+=(iptables-persistent)
else
  packages+=(ufw)
fi
apt-get install -y --no-install-recommends "${packages[@]}"

# --- Service user and checkout -------------------------------------------------------

log "Creating the $APP_USER service user"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"

log "Checking out $BRANCH from $REPO_URL"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" fetch --prune origin
  as_app git -C "$APP_DIR" checkout "$BRANCH"
  as_app git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
elif [ -z "$(ls -A "$APP_DIR")" ]; then
  as_app git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  die "$APP_DIR is not empty and is not a git checkout. Move its contents aside and run again."
fi

# --- Pinned toolchain ----------------------------------------------------------------

NODE_VERSION="$(tr -d '[:space:]' <"$APP_DIR/.nvmrc")"
NODE_VERSION="${NODE_VERSION#v}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9][0-9.]*\)".*/\1/p' "$APP_DIR/package.json")"
PYTHON_VERSION="$(tr -d '[:space:]' <"$APP_DIR/worker/.python-version")"
[ -n "$NODE_VERSION" ] || die ".nvmrc is empty"
[ -n "$PNPM_VERSION" ] || die "package.json has no pnpm version in packageManager"
case "$PYTHON_VERSION" in
  3.12 | 3.12.*) ;;
  *) die "worker/.python-version says $PYTHON_VERSION, but this script installs Ubuntu 24.04's Python 3.12. Update the script with the pin." ;;
esac

log "Installing Node $NODE_VERSION"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  tarball="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  sum_line="$(awk -v f="$tarball" '$2 == f' "$tmp/SHASUMS256.txt")"
  [ -n "$sum_line" ] || die "nodejs.org publishes no checksum for $tarball"
  (cd "$tmp" && printf '%s\n' "$sum_line" | sha256sum --check --strict -) || die "Checksum mismatch for $tarball"
  # Remove the previous release's bundled npm and corepack so two versions never mix.
  rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  trap - EXIT
fi
note "node $(/usr/local/bin/node --version)"

log "Installing pnpm $PNPM_VERSION"
if [ "$(/usr/local/bin/pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  /usr/local/bin/npm install --global "pnpm@$PNPM_VERSION"
fi
note "pnpm $(/usr/local/bin/pnpm --version)"

# --- App -----------------------------------------------------------------------------

log "Preparing $ENV_FILE"
ENV_CREATED=0
if [ ! -f "$ENV_FILE" ]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 "$APP_DIR/.env.example" "$ENV_FILE"
  ENV_CREATED=1
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
API_PORT="$(sed -n 's/^PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$ENV_FILE" | tail -n 1)"
API_PORT="${API_PORT:-3000}" # apps/api falls back to 3000 when PORT is empty

log "Preparing the worker's Python environment"
if [ ! -x "$APP_DIR/worker/.venv/bin/python" ]; then
  as_app python3.12 -m venv "$APP_DIR/worker/.venv"
fi
WORKER_READY=0
if [ -f "$APP_DIR/worker/requirements.txt" ]; then
  as_app "$APP_DIR/worker/.venv/bin/pip" install --requirement "$APP_DIR/worker/requirements.txt"
  [ -f "$APP_DIR/worker/app/main.py" ] && WORKER_READY=1
else
  note "worker/requirements.txt does not exist yet, so no worker dependencies were installed."
fi

log "Installing dependencies and building the API"
as_app pnpm --dir "$APP_DIR" install --frozen-lockfile
as_app pnpm --dir "$APP_DIR" --filter api build

# --- systemd -------------------------------------------------------------------------

log "Writing systemd units"
cat >/etc/systemd/system/momentlens-api.service <<EOF
[Unit]
Description=MomentLens Express API
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/momentlens-worker.service <<EOF
[Unit]
Description=MomentLens AI Worker
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/worker
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/worker/.venv/bin/python -m app.main
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable momentlens-api
systemctl restart momentlens-api
if [ "$WORKER_READY" -eq 1 ]; then
  systemctl enable momentlens-worker
  systemctl restart momentlens-worker
else
  note "The worker unit is written but not started, because worker/app/main.py or worker/requirements.txt does not exist yet."
fi

# --- nginx ---------------------------------------------------------------------------

log "Configuring nginx for $DOMAIN"
site="/etc/nginx/sites-available/momentlens"
if [ ! -f "$site" ]; then
  cat >"$site" <<EOF
server {
    server_name $DOMAIN;
    client_max_body_size 1m;   # media goes to R2, not here. Keep this small
                               # on purpose: it's a guardrail against anyone
                               # accidentally adding a route that proxies files.
    location / {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
elif grep -qF "server_name $DOMAIN;" "$site"; then
  note "$site already exists, and certbot may have edited it, so it was left alone."
else
  die "$site already exists for a different hostname. Remove it, or pass the hostname it already has."
fi
ln -sfn "$site" /etc/nginx/sites-enabled/momentlens
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx

# --- Firewall ------------------------------------------------------------------------

log "Opening SSH, HTTP and HTTPS"
if [ "$ORACLE_IMAGE" -eq 1 ]; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
      iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  done
  netfilter-persistent save
  note "Oracle has a second firewall. Allow TCP 80 and 443 in the VCN security list as well."
else
  # Allow every port sshd listens on before enabling ufw, so this session is not cut off.
  ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' || true)"
  for port in ${ssh_ports:-22}; do
    ufw allow "$port/tcp"
  done
  ufw allow 'Nginx Full'
  ufw --force enable
fi

# --- TLS -----------------------------------------------------------------------------

log "TLS for $DOMAIN"
if certbot certificates -d "$DOMAIN" 2>/dev/null | grep -q 'Certificate Name'; then
  note "A certificate already exists, and certbot's timer renews it."
elif [ -n "$EMAIL" ]; then
  if certbot --nginx --non-interactive --agree-tos --email "$EMAIL" -d "$DOMAIN" --redirect; then
    note "Certificate installed."
  else
    note "certbot failed, most likely because $DOMAIN does not point at this server yet."
    note "Once DNS resolves here, run: certbot --nginx -d $DOMAIN"
  fi
else
  note "Skipped because no --email was given. Once DNS resolves here, run: certbot --nginx -d $DOMAIN"
fi

# --- Check ---------------------------------------------------------------------------

log "Checking the API"
code="000"
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/" || true)"
  [ "$code" != "000" ] && break
  sleep 1
done
if [ "$code" = "000" ]; then
  note "The API is not answering on port $API_PORT. Read its log with: journalctl -u momentlens-api -n 50"
else
  note "The API answered on port $API_PORT with HTTP $code."
fi

log "Done"
if [ "$ENV_CREATED" -eq 1 ]; then
  note "Fill in $ENV_FILE, which was copied from .env.example, then run: systemctl restart momentlens-api"
fi
if [ -f /var/run/reboot-required ]; then
  note "The package upgrade needs a reboot. Run: reboot"
fi
note "Point the DNS A record for $DOMAIN at this server if it does not already."
note "Next, run the InsightFace spike on this server (Handbook §14, Phase 0)."
