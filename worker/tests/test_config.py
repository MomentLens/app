"""Settings from the environment, and the root .env for local runs."""

import pytest

from app import config
from app.config import ConfigError

COMPLETE = {
    "DATABASE_URL": "postgresql://user@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
    "R2_ACCOUNT_ID": "account",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_BUCKET": "momentlens-dev",
}


def test_loads_every_setting():
    settings = config.load(COMPLETE | {"WORKER_SENTRY_DSN": "https://dsn", "SENTRY_DSN": "api"})
    assert settings.r2_bucket == "momentlens-dev"
    assert settings.worker_sentry_dsn == "https://dsn"
    assert settings.sentry_environment is None


def test_ignores_the_apis_sentry_dsn():
    assert config.load(COMPLETE | {"SENTRY_DSN": "https://api-dsn"}).worker_sentry_dsn is None


def test_names_every_missing_or_empty_setting():
    with pytest.raises(ConfigError) as error:
        config.load({**COMPLETE, "R2_BUCKET": " ", "DATABASE_URL": ""})
    assert "DATABASE_URL" in str(error.value) and "R2_BUCKET" in str(error.value)


def test_refuses_the_transaction_pooler():
    with pytest.raises(ConfigError, match="5432"):
        config.load(COMPLETE | {"DATABASE_URL": "postgresql://u@host.pooler.supabase.com:6543/db"})


def test_an_unparseable_url_does_not_echo_it():
    with pytest.raises(ConfigError) as error:
        config.load(COMPLETE | {"DATABASE_URL": "postgresql://u:hunter2@[bad"})
    assert "hunter2" not in str(error.value)


def test_the_env_file_fills_gaps_and_never_overrides(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# a comment\n"
        "R2_BUCKET=from-file\n"
        "export R2_ACCOUNT_ID='quoted'\n"
        'DATABASE_URL="from-file"\n'
        "not a variable\n"
    )
    environ = {"DATABASE_URL": "already-set"}

    config.load_env_file(env_file, environ)

    assert environ == {
        "DATABASE_URL": "already-set",
        "R2_BUCKET": "from-file",
        "R2_ACCOUNT_ID": "quoted",
    }


def test_a_missing_env_file_is_fine(tmp_path):
    environ = {}
    config.load_env_file(tmp_path / "absent", environ)
    assert environ == {}
