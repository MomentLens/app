"""main(): Sentry from WORKER_SENTRY_DSN only, one event per archived message, and the start
order that keeps /health at 503 until the model is loaded and warm (D-123, D-169)."""

import signal
import urllib.error
import urllib.request
from uuid import uuid4

import pytest
import sentry_sdk
from insightface.model_zoo import model_zoo
from insightface.utils import storage

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
    monkeypatch.setattr(main.model, "load", lambda: None)

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
            "job": "blur_region",
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
    assert "blur_region" in sent[0][1]


def test_an_archive_from_a_bug_carries_its_exception(sent):
    bug = KeyError("width")
    report(error=bug)
    assert sent == [("error", bug)]


# --- Start order: /health 503 while the model loads, then setup hooks, then the loop (D-169) ---


class FakeWorker:
    runs = 0

    def __init__(self, *args):
        pass

    def run(self):
        FakeWorker.runs += 1


class FakeStore:
    def __init__(self, *args):
        pass

    def close(self):
        pass


@pytest.fixture
def start(monkeypatch):
    """Runs main() with fakes for everything after the model, /health on a free port.

    Returns the recorded signal handlers and the /health server, filled in once main() starts it.
    """
    monkeypatch.setattr(config, "load_env_file", lambda: None)
    monkeypatch.setattr(config, "load", lambda: config.Settings(**SETTINGS))
    handlers = {}
    monkeypatch.setattr(main.signal, "signal", lambda sig, fn: handlers.__setitem__(sig, fn))
    monkeypatch.setattr(main, "PORT", 0)
    servers = []
    real_start = main.start_health_server

    def start_and_keep(*args):
        server = real_start(*args)
        servers.append(server)
        return server

    monkeypatch.setattr(main, "start_health_server", start_and_keep)
    monkeypatch.setattr(main, "Worker", FakeWorker)
    monkeypatch.setattr(main, "Store", FakeStore)
    monkeypatch.setattr(main.Storage, "from_settings", lambda settings: None)
    FakeWorker.runs = 0
    yield handlers, servers
    for server in servers:
        server.should_exit = True


def health_status(server):
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_health_answers_503_while_the_model_loads(start, monkeypatch):
    _handlers, servers = start
    seen = []
    monkeypatch.setattr(main.model, "load", lambda: seen.append(health_status(servers[0])))

    assert main.main() == 0
    assert seen == [503]
    assert FakeWorker.runs == 1


def test_the_model_loads_before_the_setup_hooks(start, monkeypatch):
    order = []
    monkeypatch.setattr(main.model, "load", lambda: order.append("model"))
    monkeypatch.setattr(main, "run_setup_hooks", lambda: order.append("hooks"))

    assert main.main() == 0
    assert order == ["model", "hooks"]


def test_sigterm_during_the_load_reads_nothing_from_the_queue(start, monkeypatch):
    handlers, servers = start

    def load_then_stop():
        handlers[signal.SIGTERM](signal.SIGTERM, None)

    monkeypatch.setattr(main.model, "load", load_then_stop)

    assert main.main() == 0
    assert FakeWorker.runs == 0
    assert health_status(servers[0]) == 503


def test_sigterm_before_the_load_skips_it(start, monkeypatch):
    handlers, _servers = start
    started = main.start_health_server

    def start_then_stop(*args):
        server = started(*args)
        handlers[signal.SIGTERM](signal.SIGTERM, None)
        return server

    def refuse():
        raise AssertionError("the model loaded after SIGTERM")

    monkeypatch.setattr(main, "start_health_server", start_then_stop)
    monkeypatch.setattr(main.model, "load", refuse)

    assert main.main() == 0
    assert FakeWorker.runs == 0


def test_a_missing_model_file_exits_1_without_a_download(start, monkeypatch, tmp_path, caplog):
    _handlers, servers = start
    monkeypatch.setattr(main.model, "model_dir", lambda: tmp_path / "buffalo_l")

    def refuse(*args, **kwargs):
        raise AssertionError(f"a download was attempted: {args}")

    monkeypatch.setattr(storage, "download_file", refuse)
    monkeypatch.setattr(model_zoo, "download_onnx", refuse)

    assert main.main() == 1
    assert FakeWorker.runs == 0
    assert health_status(servers[0]) == 503
    errors = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
    assert any("cannot start" in e and "det_10g.onnx" in e for e in errors)


def test_a_model_file_that_does_not_open_exits_1(start, monkeypatch, caplog):
    def corrupt():
        raise RuntimeError("[ONNXRuntimeError] : 7 : INVALID_PROTOBUF")

    monkeypatch.setattr(main.model, "load", corrupt)

    assert main.main() == 1
    assert FakeWorker.runs == 0
    assert any(
        r.levelname == "ERROR" and r.getMessage().startswith("cannot start") for r in caplog.records
    )
