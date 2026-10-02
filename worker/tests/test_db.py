"""The Store's handling of a lost connection, without a database."""

import psycopg
import pytest

from app.db import LOCK_KEY, DatabaseUnavailable, Store


class StubConnection:
    """Enough of a psycopg connection for Store to fail on."""

    def __init__(self, *, broken):
        self.broken = broken
        self.closed = False

    def cursor(self):
        raise psycopg.OperationalError("server closed the connection unexpectedly")

    def close(self):
        self.closed = True


def test_every_worker_derives_the_same_lock_key():
    # A changed key would let an old and a new worker read the queue at once (D-123).
    assert LOCK_KEY == 5660234404065457891


def test_an_error_on_a_broken_connection_is_a_lost_connection():
    store = Store(connect=lambda: StubConnection(broken=True))
    store.connect()
    store.locked = True

    with pytest.raises(DatabaseUnavailable):
        store.read(120)
    assert not store.locked


def test_an_error_on_a_live_connection_passes_through():
    store = Store(connect=lambda: StubConnection(broken=False))
    store.connect()

    with pytest.raises(psycopg.OperationalError):
        store.read(120)


def test_a_failed_connect_is_a_lost_connection():
    def refuse():
        raise psycopg.OperationalError("connection refused")

    with pytest.raises(DatabaseUnavailable):
        Store(connect=refuse).connect()


def test_nothing_runs_before_connect():
    with pytest.raises(DatabaseUnavailable):
        Store(connect=lambda: StubConnection(broken=False)).read(120)
