#!/usr/bin/env bash
# Runs the self-hosted Supabase stack (Postgres with pgmq, Auth, PostgREST, Realtime, and the
# Envoy gateway) on the server, from Supabase's own docker/ folder at a pinned commit plus
# docker-compose.override.yml from this folder. provision.sh calls it; running it again is safe
# and is how a setting below reaches the server.
#
# First run: generates every Supabase secret into /opt/supabase/docker/.env (chmod 600, never in
# git), then writes SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY and DATABASE_URL
# into the app's /srv/momentlens/.env. Later runs keep the secrets and re-apply the settings.
#
# The Resend API key is asked for when stdin is a terminal (ssh -t) and SMTP is not set yet.
# Without it, Auth runs but no recovery email is sent.
#
# Usage, as root: bash setup.sh --domain api.example.com --mail-from noreply@example.com

set -euo pipefail
umask 022 # the containers read volumes/ as other users; .env alone is chmod 600

# Supabase's master branch on 2026-10-28. Moving the pin pulls new images; read docker/CHANGELOG.md.
SUPABASE_COMMIT="831d6302c7361c0a5115a91e953bdf084eb85330"
SUPABASE_DIR="/opt/supabase"
STACK_DIR="$SUPABASE_DIR/docker"
STACK_ENV="$STACK_DIR/.env"
APP_ENV="/srv/momentlens/.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES=(db auth rest realtime api-gw)
# The gateway's port on the host, set in docker-compose.override.yml. The worker holds 8000.
GATEWAY="http://127.0.0.1:54321"

DOMAIN=""
MAIL_FROM=""

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain | --mail-from)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --domain) DOMAIN="$2" ;;
        --mail-from) MAIL_FROM="$2" ;;
      esac
      shift 2
      ;;
    *) die "Usage: setup.sh --domain HOSTNAME --mail-from ADDRESS" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "Pass --domain with a valid hostname"
[[ "$MAIL_FROM" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "Pass --mail-from with an email address"
command -v docker >/dev/null || die "Docker is not installed. provision.sh installs it."
export PATH="/usr/local/bin:$PATH" # add-new-auth-keys.sh needs the node provision.sh installs

# Replaces KEY's line in FILE, or appends it. Values are written as given, unquoted.
set_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" >"$tmp"
  cat "$tmp" >"$file" # keeps the file's owner and mode
  rm -f "$tmp"
}
get_env() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

log "Fetching Supabase's docker/ folder at $SUPABASE_COMMIT"
install -d -m 755 "$SUPABASE_DIR"
if [ ! -d "$SUPABASE_DIR/.git" ]; then
  git -C "$SUPABASE_DIR" init -q
  git -C "$SUPABASE_DIR" remote add origin https://github.com/supabase/supabase.git
  git -C "$SUPABASE_DIR" sparse-checkout set --no-cone /docker/
fi
if [ "$(git -C "$SUPABASE_DIR" rev-parse -q --verify HEAD || true)" != "$SUPABASE_COMMIT" ]; then
  git -C "$SUPABASE_DIR" fetch -q --depth 1 --filter=blob:none origin "$SUPABASE_COMMIT"
  # .env and volumes/db/data are untracked, so checkout leaves them alone.
  git -C "$SUPABASE_DIR" checkout -q --force "$SUPABASE_COMMIT"
fi
ln -sfn "$HERE/docker-compose.override.yml" "$STACK_DIR/docker-compose.override.yml"

log "Preparing $STACK_ENV"
if [ ! -f "$STACK_ENV" ]; then
  cp "$STACK_DIR/.env.example" "$STACK_ENV"
  chmod 600 "$STACK_ENV"
  (cd "$STACK_DIR" && sh utils/generate-keys.sh --update-env >/dev/null)
  (cd "$STACK_DIR" && sh utils/add-new-auth-keys.sh --update-env >/dev/null)
  rm -f "$STACK_ENV.old"
  note "Generated new secrets."
fi
for key in JWT_SECRET POSTGRES_PASSWORD SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY JWT_KEYS JWT_JWKS; do
  [ -n "$(get_env "$STACK_ENV" "$key")" ] || die "$key is empty in $STACK_ENV. Move the file aside and run again."
done

# Every setting here mirrors supabase/config.toml or the hosted project's Auth settings.
set_env "$STACK_ENV" SUPABASE_PUBLIC_URL "https://$DOMAIN"
# Email links are built from this, so it must be the public URL or reset links point nowhere.
set_env "$STACK_ENV" API_EXTERNAL_URL "https://$DOMAIN/auth/v1"
# Auth sends users here when a redirect is not allow-listed, so the fallback also opens the app.
set_env "$STACK_ENV" SITE_URL "momentlens://reset-password"
set_env "$STACK_ENV" ADDITIONAL_REDIRECT_URLS "momentlens://reset-password"
set_env "$STACK_ENV" JWT_EXPIRY 3600
set_env "$STACK_ENV" DISABLE_SIGNUP false
set_env "$STACK_ENV" ENABLE_EMAIL_SIGNUP true
# Upstream's default asks every new user to confirm their email, and nothing in the app handles it.
set_env "$STACK_ENV" ENABLE_EMAIL_AUTOCONFIRM true
set_env "$STACK_ENV" ENABLE_ANONYMOUS_USERS false
set_env "$STACK_ENV" ENABLE_PHONE_SIGNUP false
set_env "$STACK_ENV" ENABLE_PHONE_AUTOCONFIRM false
set_env "$STACK_ENV" SMTP_HOST smtp.resend.com
set_env "$STACK_ENV" SMTP_PORT 465
set_env "$STACK_ENV" SMTP_USER resend
set_env "$STACK_ENV" SMTP_ADMIN_EMAIL "$MAIL_FROM"
set_env "$STACK_ENV" SMTP_SENDER_NAME MomentLens

if [[ "$(get_env "$STACK_ENV" SMTP_PASS)" != re_* ]]; then
  if [ -t 0 ]; then
    read -rsp "    Resend API key (starts re_, input hidden; Enter to skip): " smtp_pass
    echo
    if [ -n "$smtp_pass" ]; then
      [[ "$smtp_pass" == re_* ]] || die "That is not a Resend API key"
      set_env "$STACK_ENV" SMTP_PASS "$smtp_pass"
    fi
  fi
  [[ "$(get_env "$STACK_ENV" SMTP_PASS)" == re_* ]] ||
    note "SMTP is not set, so recovery emails will not send. Run this script again over ssh -t to add the key."
fi

log "Starting ${SERVICES[*]}"
(cd "$STACK_DIR" && docker compose pull --quiet "${SERVICES[@]}" && docker compose up -d --remove-orphans "${SERVICES[@]}")

log "Checking the stack"
publishable="$(get_env "$STACK_ENV" SUPABASE_PUBLISHABLE_KEY)"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null -H "apikey: $publishable" $GATEWAY/auth/v1/health; then
    ok=1
    break
  fi
  sleep 2
done
[ "$ok" -eq 1 ] || die "Auth is not answering through the gateway. Read: cd $STACK_DIR && docker compose logs auth api-gw"
curl -fsS $GATEWAY/auth/v1/.well-known/jwks.json | grep -q '"ES256"' ||
  die "The JWKS has no ES256 key, so apps/api cannot verify tokens. Check JWT_KEYS in $STACK_ENV."
note "Auth answers and publishes an ES256 key."
docker exec supabase-db psql -U postgres -tAc "select 1 from pg_available_extensions where name = 'pgmq'" | grep -q 1 ||
  die "This Postgres image has no pgmq extension, which the migrations need."
note "pgmq is available."
curl -fsS -o /dev/null -H "apikey: $publishable" $GATEWAY/rest/v1/ ||
  note "PostgREST did not answer yet. Read: cd $STACK_DIR && docker compose logs rest"

log "Writing the Supabase variables into $APP_ENV"
if [ -f "$APP_ENV" ]; then
  set_env "$APP_ENV" SUPABASE_URL "$GATEWAY"
  set_env "$APP_ENV" SUPABASE_PUBLISHABLE_KEY "$publishable"
  set_env "$APP_ENV" SUPABASE_SECRET_KEY "$(get_env "$STACK_ENV" SUPABASE_SECRET_KEY)"
  # Straight to Postgres on loopback: a session connection, which the worker's queue lock needs (D-123).
  set_env "$APP_ENV" DATABASE_URL "postgresql://postgres:$(get_env "$STACK_ENV" POSTGRES_PASSWORD)@127.0.0.1:5432/postgres"
  note "Done. Restart the API and the worker to pick them up."
else
  note "$APP_ENV does not exist yet. provision.sh creates it; run this script again after."
fi

log "Done"
note "For apps/mobile/.env and the EAS environments:"
note "  EXPO_PUBLIC_SUPABASE_URL=https://$DOMAIN"
note "  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$publishable"
note "The publishable key is public by design. The secret key and database password stay on this server."
