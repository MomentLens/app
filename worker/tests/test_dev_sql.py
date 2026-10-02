"""The worker's SQL against the dev project, inside a transaction that rolls back (D-123).

The fakes in tests/fakes.py assume pgmq behaves a certain way. This module checks the real
queue and the real `media` table do: the read order, read_ct, unhiding, the one-transaction
writes and the lock.

It skips while DATABASE_URL is unset. `--dev-sql` reads DATABASE_URL from the repo root's .env
when it is unset and fails instead of skipping, which is how CI runs it
(.github/workflows/worker-sql.yml). Each test makes its own pgmq queue inside the rolled-back
transaction and never reads `jobs`. The lock test uses a random key, never the worker's, so a
running dev server worker is not disturbed.
"""

import os
import secrets
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from app import config, queue
from app.db import Archive, Store
from app.jobs.base import JobContext


@pytest.fixture(scope="module")
def database_url(request):
    if request.config.getoption("--dev-sql"):
        config.load_env_file()
        if not os.environ.get("DATABASE_URL"):
            pytest.fail("--dev-sql needs DATABASE_URL, from the environment or the root .env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is unset. Run with --dev-sql to use the root .env (D-123)")
    return url


@pytest.fixture
def conn(database_url):
    with (
        psycopg.connect(database_url, autocommit=True) as connection,
        connection.transaction(force_rollback=True),
    ):
        yield connection


@pytest.fixture
def store(conn):
    name = f"worker_test_{secrets.token_hex(6)}"
    conn.execute("select pgmq.create(%s)", (name,))
    s = Store(connect=lambda: conn, queue_name=name)
    s.connect()
    return s


@pytest.fixture
def media_id(conn):
    """A finished, unprocessed photo in a throwaway event, owned by any existing account."""
    user = conn.execute("select id from auth.users limit 1").fetchone()
    if user is None:
        pytest.skip("the dev project has no account to own a test photo")
    event_id = conn.execute(
        "insert into public.event (name, type, create_request_id)"
        " values ('Worker SQL test', 'other', gen_random_uuid()) returning id"
    ).fetchone()[0]
    venue_id = conn.execute(
        "insert into public.venue (event_id, name, lat, lng) values (%s, 'Hall', 0, 0)"
        " returning id",
        (event_id,),
    ).fetchone()[0]
    sub_event_id = conn.execute(
        "insert into public.sub_event (event_id, name, starts_at, ends_at, venue_id)"
        " values (%s, 'Mehndi', now(), now() + interval '1 hour', %s) returning id",
        (event_id, venue_id),
    ).fetchone()[0]
    media = uuid4()
    conn.execute(
        "insert into public.media (id, event_id, sub_event_id, uploader_user_id,"
        " uploader_role_at_upload, captured_at, content_hash, upload_key, upload_thumb_key,"
        " uploaded_at, size_bytes)"
        " values (%s, %s, %s, %s, 'guest', now(), %s, %s, %s, now(), 1)",
        (
            media,
            event_id,
            sub_event_id,
            user[0],
            uuid4().hex + uuid4().hex,
            f"{media}/upload.jpg",
            f"{media}/upload_thumb.webp",
        ),
    )
    return media


def send(conn, store, body, delay=0):
    return conn.execute(
        "select pgmq.send(%s::text, %s::jsonb, %s::integer)", (store.queue, Jsonb(body), delay)
    ).fetchone()[0]


def media_row(conn, media_id):
    return conn.execute(
        "select width, height, public_key, public_thumb_key, variant_version,"
        " processed_at is not null, upload_key, upload_thumb_key from public.media where id = %s",
        (media_id,),
    ).fetchone()


def in_archive(conn, store, msg_id):
    table = sql.Identifier("pgmq", f"a_{store.queue}")
    query = sql.SQL("select count(*) from {} where msg_id = %s").format(table)
    return conn.execute(query, (msg_id,)).fetchone()[0] == 1


def test_a_failed_message_is_read_again_before_a_newer_one(conn, store):
    first = send(conn, store, {"n": 1})
    second = send(conn, store, {"n": 2})

    message = store.read(120)
    assert (message.msg_id, message.read_ct, message.body) == (first, 1, {"n": 1})

    store.retry_later(first)
    again = store.read(120)
    assert (again.msg_id, again.read_ct) == (first, 2)

    with store.transaction() as tx:
        tx.delete_message(first)
    assert store.read(120).msg_id == second


def test_unhide_brings_back_what_a_stopped_worker_hid_and_leaves_a_delay(conn, store):
    hidden = send(conn, store, {"n": 1})
    delayed = send(conn, store, {"n": 2}, delay=60)
    assert store.read(120).msg_id == hidden
    assert store.read(120) is None

    assert store.unhide() == [hidden]

    again = store.read(120)
    assert (again.msg_id, again.read_ct) == (hidden, 2)
    assert store.read(120) is None, f"msg_id {delayed} was sent with a delay and must stay hidden"


def test_finish_thumbnail_dims_copies_the_keys_from_the_row_and_publishes(conn, store, media_id):
    with store.transaction() as tx:
        assert tx.finish_thumbnail_dims(media_id, 4032, 3024)

    width, height, public, public_thumb, version, published, upload, upload_thumb = media_row(
        conn, media_id
    )
    assert (width, height, version, published) == (4032, 3024, 1, True)
    assert (public, public_thumb) == (upload, upload_thumb)
    assert public == f"{media_id}/upload.jpg"

    with store.transaction() as tx:
        assert not tx.finish_thumbnail_dims(media_id, 1, 1), "acts only on variant_version 0"
    assert media_row(conn, media_id)[:2] == (4032, 3024)


def test_the_row_write_and_the_message_delete_commit_together(conn, store, media_id, monkeypatch):
    msg_id = send(conn, store, {"job": "thumbnail_dims", "media_id": str(media_id)})
    store.read(120)

    def fail(*_args):
        raise RuntimeError("delete failed")

    monkeypatch.setattr(queue, "delete", fail)
    with pytest.raises(RuntimeError):
        JobContext(store, None, msg_id).commit(
            lambda tx: tx.finish_thumbnail_dims(media_id, 10, 10)
        )

    assert media_row(conn, media_id)[4] == 0
    monkeypatch.undo()
    store.retry_later(msg_id)
    assert store.read(120).msg_id == msg_id


def test_media_for_job_returns_a_soft_deleted_row_and_none_for_a_gone_one(conn, store, media_id):
    conn.execute("update public.media set deleted_at = now() where id = %s", (media_id,))

    row = store.media_for_job(media_id)
    assert (row.id, row.upload_key, row.variant_version) == (media_id, f"{media_id}/upload.jpg", 0)
    assert store.media_for_job(uuid4()) is None


def test_archive_clears_processed_at_in_the_same_transaction(conn, store, media_id):
    conn.execute("update public.media set processed_at = now() where id = %s", (media_id,))
    msg_id = send(conn, store, {"job": "thumbnail_dims", "media_id": str(media_id)})
    store.read(120)

    assert store.archive(msg_id, media_id, gone_is_done=True) is Archive.UNPUBLISHED

    assert media_row(conn, media_id)[5] is False
    assert in_archive(conn, store, msg_id)
    store.unhide()
    assert store.read(120) is None


def test_a_failed_archive_leaves_processed_at_set(conn, store, media_id, monkeypatch):
    conn.execute("update public.media set processed_at = now() where id = %s", (media_id,))
    msg_id = send(conn, store, {"job": "thumbnail_dims", "media_id": str(media_id)})

    def fail(*_args):
        raise RuntimeError("archive failed")

    monkeypatch.setattr(queue, "archive", fail)
    with pytest.raises(RuntimeError):
        store.archive(msg_id, media_id, gone_is_done=True)

    assert media_row(conn, media_id)[5] is True


def test_archive_deletes_a_gone_rows_message_as_done(conn, store):
    msg_id = send(conn, store, {"job": "thumbnail_dims", "media_id": str(uuid4())})

    assert store.archive(msg_id, uuid4(), gone_is_done=True) is Archive.GONE

    assert not in_archive(conn, store, msg_id)
    assert store.read(120) is None


def test_archive_keeps_an_unknown_jobs_message_whose_row_is_gone(conn, store):
    msg_id = send(conn, store, {"job": "face_process", "media_id": str(uuid4())})

    assert store.archive(msg_id, uuid4(), gone_is_done=False) is Archive.ARCHIVED
    assert in_archive(conn, store, msg_id)


def test_a_second_worker_cannot_take_the_lock(database_url):
    key = secrets.randbits(63)
    first = Store(database_url, lock_key=key)
    second = Store(database_url, lock_key=key)
    try:
        first.connect()
        second.connect()
        assert first.try_lock()
        assert not second.try_lock()

        first.close()  # the lock goes with the session, as when a worker dies
        assert second.try_lock()
    finally:
        first.close()
        second.close()
