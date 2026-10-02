"""The worker's settings, read once at startup.

On the server systemd sets them from /srv/momentlens/.env (hb §13.3.3). A local run reads the
repo root's .env, the file the API's dev script reads, and never overrides a variable that is
already set. `.env.example` lists every name.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, MutableMapping
from pathlib import Path

from psycopg.conninfo import conninfo_to_dict
from pydantic import BaseModel, ConfigDict

ROOT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

# The same reading of a .env line as scripts/doctor.mjs.
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$")


class ConfigError(Exception):
    """A setting is missing or cannot work. The worker logs it and exits."""


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    # The Supabase session pooler on 5432, because the queue lock needs a session (D-123).
    database_url: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    # Unset turns Sentry off. Not SENTRY_DSN, which is the API's, in the same env file (D-123).
    worker_sentry_dsn: str | None = None
    sentry_environment: str | None = None


def load_env_file(
    path: Path = ROOT_ENV_FILE, environ: MutableMapping[str, str] = os.environ
) -> None:
    """Copies the file's variables into `environ`, skipping any name already there."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        match = _ENV_LINE.match(line)
        if match and match[1] not in environ:
            environ[match[1]] = re.sub(r"^['\"]|['\"]$", "", match[2].strip())


def load(environ: Mapping[str, str] = os.environ) -> Settings:
    """Reads Settings from `environ`. An empty variable counts as unset."""
    values = {}
    missing = []
    for name, field in Settings.model_fields.items():
        value = environ.get(name.upper(), "").strip()
        if value:
            values[name] = value
        elif field.is_required():
            missing.append(name.upper())
    if missing:
        raise ConfigError(f"missing or empty in the environment: {' '.join(missing)}")

    try:
        port = conninfo_to_dict(values["database_url"]).get("port")
    except Exception as error:
        raise ConfigError(f"DATABASE_URL does not parse: {type(error).__name__}") from None
    if str(port) == "6543":
        raise ConfigError(
            "DATABASE_URL points at the transaction pooler on 6543. The queue lock needs a"
            " session, so use the session pooler's string on 5432 (D-123)"
        )
    return Settings(**values)
