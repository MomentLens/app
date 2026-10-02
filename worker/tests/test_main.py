"""Sentry: started only from WORKER_SENTRY_DSN, and sent one event per archived message."""

from uuid import uuid4

import pytest
import sentry_sdk

from app import config, loop, main
from app.images import DecodeError

SETTINGS = {
    "database_url": "postgresql://user@host:5432/postgres",
    "r2_account_id": "account",
    "r2_access_key_id": "key",
    "r2_secret_access_key": "secret",
    "r2_bucket": "bucket",
}


@pytest.fixture
def inits(monkeypatch):
    calls = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kwargs: calls.append(kwargs))
    return calls


def test_sentry_stays_off_without_the_workers_dsn(inits, monkeypatch):
    monkeypatch.setenv("SENTRY_DSN", "https://the-api@sentry.example/1")
    main.init_sentry(config.Settings(**SETTINGS))
    assert inits == []


def test_sentry_starts_from_the_workers_dsn_with_nothing_automatic(inits):
    settings = config.Settings(
        **SETTINGS, worker_sentry_dsn="https://worker@sentry.example/2", sentry_environment="local"
    )
    main.init_sentry(settings)
    assert inits == [
        {
            "dsn": "https://worker@sentry.example/2",
            "environment": "local",
            "send_default_pii": False,
            "default_integrations": False,
            "auto_enabling_integrations": False,
        }
    ]


def test_a_setup_hook_that_raises_stops_the_start(monkeypatch, caplog):
    monkeypatch.setattr(config, "load_env_file", lambda: None)
    monkeypatch.setattr(config, "load", lambda: config.Settings(**SETTINGS))
    monkeypatch.setattr(main.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(main, "start_health_server", lambda *_args: None)

    def broken_hook():
        raise RuntimeError("the model file is missing")

    monkeypatch.setattr(main, "run_setup_hooks", broken_hook)

    assert main.main() == 1
    assert any(
        r.levelname == "ERROR" and r.getMessage().startswith("cannot start") for r in caplog.records
    )


@pytest.fixture
def sent(monkeypatch):
    calls = []
    monkeypatch.setattr(
        sentry_sdk, "capture_message", lambda text, level=None: calls.append(("message", text))
    )
    monkeypatch.setattr(
        sentry_sdk, "capture_exception", lambda error: calls.append(("error", error))
    )
    return calls


def report(**overrides):
    loop.report_archive(
        **{
            "kind": "failed",
            "job": "thumbnail_dims",
            "msg_id": 7,
            "media_id": uuid4(),
            "read_ct": 3,
            "reason": "failed 3 tries",
        }
        | overrides
    )


def test_an_archive_with_a_known_cause_is_one_message(sent):
    report(error=DecodeError("not an image"))
    assert len(sent) == 1 and sent[0][0] == "message"
    assert "thumbnail_dims" in sent[0][1]


def test_an_archive_from_a_bug_carries_its_exception(sent):
    bug = KeyError("width")
    report(error=bug)
    assert sent == [("error", bug)]
