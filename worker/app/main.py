"""MomentLens AI worker.

A pgmq consumer, not a web server (Handbook §6). The queue loop runs on the main thread
(app/loop.py). The only HTTP surface is /health, on a side thread, so a human on the box can
tell whether the loop is running (hb §13.3.3).

When the loop dies the process exits, and systemd's Restart=always brings it back. SIGTERM, which
`systemctl stop` and a deploy send, lets the job in progress finish first (D-123).
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
import time
from types import FrameType

import sentry_sdk
import uvicorn
from fastapi import FastAPI, Response

from app import config
from app.db import Store
from app.jobs import REGISTRY, run_setup_hooks
from app.loop import Worker
from app.storage import Storage

# nginx proxies the API and nothing else, so the worker stays on loopback.
HOST = "127.0.0.1"
PORT = 8000

log = logging.getLogger("momentlens.worker")


class HealthServerError(Exception):
    """/health could not start, most often because its port is taken."""


def create_app(loop_running: threading.Event) -> FastAPI:
    app = FastAPI(title="MomentLens worker", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    def health(response: Response) -> dict[str, str]:
        """200 while the queue loop runs, waiting for the lock included. 503 before it starts,
        while the jobs' setup hooks run, and once it stopped."""
        if loop_running.is_set():
            return {"status": "ok"}
        response.status_code = 503
        return {"status": "stopped"}

    return app


def start_health_server(app: FastAPI, host: str, port: int) -> uvicorn.Server:
    """Serves `app` on a daemon thread and returns once it listens."""
    server = uvicorn.Server(
        uvicorn.Config(
            app, host=host, port=port, lifespan="off", access_log=False, log_level="warning"
        )
    )
    # Off the main thread, uvicorn installs no signal handlers, so SIGTERM stays the loop's.
    thread = threading.Thread(target=server.run, name="health", daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            raise HealthServerError(f"/health could not listen on {host}:{port}")
        time.sleep(0.02)
    return server


def init_sentry(settings: config.Settings) -> None:
    """Sentry for archived messages and nothing else (D-123), off without WORKER_SENTRY_DSN."""
    if not settings.worker_sentry_dsn:
        log.info("Sentry is off, because WORKER_SENTRY_DSN is unset")
        return
    sentry_sdk.init(
        dsn=settings.worker_sentry_dsn,
        environment=settings.sentry_environment,
        send_default_pii=False,
        # No automatic capture of logs, uncaught errors or threads. app/loop.py reports each
        # archive itself.
        default_integrations=False,
        auto_enabling_integrations=False,
    )


def main() -> int:
    """Entry point for `python -m app.main`, which is what systemd runs. Returns the exit code."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    try:
        config.load_env_file()
        settings = config.load()
    except config.ConfigError as error:
        log.error("cannot start: %s", error)
        return 1
    init_sentry(settings)

    stop = threading.Event()

    def request_stop(signum: int, _frame: FrameType | None) -> None:
        log.info("%s received, stopping after the job in progress", signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    loop_running = threading.Event()
    try:
        start_health_server(create_app(loop_running), HOST, PORT)
    except HealthServerError as error:
        log.error("cannot start: %s", error)
        return 1

    try:
        run_setup_hooks()
    except Exception:
        log.exception("cannot start: a job's setup hook failed")
        return 1
    store = Store(settings.database_url)
    worker = Worker(store, Storage.from_settings(settings), REGISTRY, stop)

    code = 0
    loop_running.set()
    log.info("worker started, /health on http://%s:%s, jobs: %s", HOST, PORT, " ".join(REGISTRY))
    try:
        worker.run()
    except Exception:
        log.exception("the queue loop died, exiting so systemd restarts the worker")
        code = 1
    finally:
        loop_running.clear()
        store.close()
        sentry_sdk.flush(timeout=5)
    log.info("worker stopped")
    return code


if __name__ == "__main__":
    sys.exit(main())
