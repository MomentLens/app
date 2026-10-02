"""/health: no auth and no data, 200 while the loop runs and 503 once it stopped (D-123)."""

import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

from app.main import HealthServerError, create_app, start_health_server


def get(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_answers_200_while_the_loop_runs_and_503_once_it_stopped():
    running = threading.Event()
    server = start_health_server(create_app(running), "127.0.0.1", 0)
    try:
        port = server.servers[0].sockets[0].getsockname()[1]

        assert get(port) == (503, {"status": "stopped"})
        running.set()
        assert get(port) == (200, {"status": "ok"})
        running.clear()
        assert get(port) == (503, {"status": "stopped"})
    finally:
        server.should_exit = True


# uvicorn ends its thread with SystemExit when it cannot bind, which is what this test wants.
@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_taken_port_stops_startup():
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        port = taken.getsockname()[1]
        with pytest.raises(HealthServerError):
            start_health_server(create_app(threading.Event()), "127.0.0.1", port)
