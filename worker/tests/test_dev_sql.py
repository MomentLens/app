"""The worker's SQL against the dev project, inside a transaction that rolls back (D-123).

The fakes in tests/fakes.py assume pgmq behaves a certain way. This module checks the real
queue and the real `media` table do: the read order, read_ct, unhiding, the one-transaction
writes and the lock.

It skips while DATABASE_URL is unset. `--dev-sql` reads DATABASE_URL from the repo root's .env
when it is unset and fails instead of skipping, which is how CI runs it (scripts/verify.mjs, in
the dev-project job of .github/workflows/ci.yml). Each test makes its own pgmq queue inside the
rolled-back transaction and never reads `jobs`. The lock test uses a random key, never the
worker's, so a running dev server worker is not disturbed.
"""

import os
import secrets
import time
from uuid import uuid4

import numpy as np
import psycopg
import pytest
from psycopg import sql
from psycopg.types.json import Jsonb

from app import config, queue
from app.db import Archive, DnpSubject, NewFace, Store, vector_literal
from app.jobs.base import JobContext
from app.loop import LOCK_WAIT_S


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
def media_id(request, conn):
    """A finished, unprocessed photo in a throwaway event, owned by any existing account."""
    user = conn.execute("select id from auth.users limit 1").fetchone()
    if user is None:
        # Under --dev-sql a skip would pass the CI check with half the module unrun.
        stop = pytest.fail if request.config.getoption("--dev-sql") else pytest.skip
        stop("the dev project has no account to own a test photo")
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


def unit(i):
    row = np.zeros(512, np.float32)
    row[i], row[511] = 0.6, 0.8
    return row


def face(i, subject_id=None, similarity=None, cluster_id=None):
    return NewFace(
        x=0.1 * i,
        y=0.2,
        width=0.05,
        height=0.1,
        embedding=unit(i),
        matched_subject_id=subject_id,
        similarity=similarity,
        cluster_id=cluster_id,
    )


def subject_row(media_id, subject_id, version):
    return DnpSubject(
        subject_id,
        f"{media_id}/{subject_id}_v{version}.jpg",
        f"{media_id}/{subject_id}_thumb_v{version}.webp",
    )


def dnp_rows(conn, media_id):
    return conn.execute(
        "select subject_id, variant_key, variant_thumb_key from public.dnp_subject"
        " where media_id = %s order by subject_id",
        (media_id,),
    ).fetchall()


def test_finish_face_process_publishes_with_its_faces_and_subjects(conn, store, media_id):
    subject_id = conn.execute(
        "insert into public.subject (user_id) values (null) returning id"
    ).fetchone()[0]
    cluster = uuid4()
    subjects = [subject_row(media_id, subject_id, 1)]

    with store.transaction() as tx:
        assert tx.finish_face_process(
            media_id,
            4032,
            3024,
            f"{media_id}/public_v1.jpg",
            f"{media_id}/public_thumb_v1.webp",
            [face(0, subject_id, 0.93), face(1, cluster_id=cluster)],
            subjects,
        )

    width, height, public, public_thumb, version, published, _, _ = media_row(conn, media_id)
    assert (width, height, version, published) == (4032, 3024, 1, True)
    assert (public, public_thumb) == (
        f"{media_id}/public_v1.jpg",
        f"{media_id}/public_thumb_v1.webp",
    )
    assert dnp_rows(conn, media_id) == [
        (s.subject_id, s.variant_key, s.variant_thumb_key) for s in subjects
    ]

    stored = store.faces(media_id)
    assert len(stored) == 2
    by_x = sorted(stored, key=lambda f: f.x)
    assert np.allclose(by_x[0].embedding, unit(0)) and np.allclose(by_x[1].embedding, unit(1))
    assert (by_x[1].x, by_x[1].y, by_x[1].width, by_x[1].height) == pytest.approx(
        (0.1, 0.2, 0.05, 0.1)
    )
    matched = conn.execute(
        "select matched_subject_id, similarity, cluster_id from public.face"
        " where media_id = %s order by x",
        (media_id,),
    ).fetchall()
    assert matched == [(subject_id, pytest.approx(0.93), None), (None, None, cluster)]
    assert store.dnp_subjects(media_id) == subjects


def test_finish_face_process_with_upload_keys_and_no_face(conn, store, media_id):
    with store.transaction() as tx:
        assert tx.finish_face_process(
            media_id, 10, 20, f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp", [], []
        )
    row = media_row(conn, media_id)
    assert row[2:6] == (row[6], row[7], 1, True)
    assert store.faces(media_id) == []


def test_finish_face_process_writes_nothing_on_a_written_row(conn, store, media_id):
    publish(conn, media_id, version=2)

    with store.transaction() as tx:
        assert not tx.finish_face_process(
            media_id,
            1,
            1,
            f"{media_id}/public_v1.jpg",
            f"{media_id}/public_thumb_v1.webp",
            [face(0)],
            [],
        ), "acts only on variant_version 0"

    assert media_row(conn, media_id)[4] == 2
    assert store.faces(media_id) == []


def test_dnp_subject_refuses_an_upload_key(conn, store, media_id):
    subject_id = conn.execute(
        "insert into public.subject (user_id) values (null) returning id"
    ).fetchone()[0]
    with pytest.raises(psycopg.errors.CheckViolation), store.transaction() as tx:
        tx.finish_face_process(
            media_id,
            1,
            1,
            f"{media_id}/public_v1.jpg",
            f"{media_id}/public_thumb_v1.webp",
            [],
            [DnpSubject(subject_id, f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp")],
        )
    assert media_row(conn, media_id)[4] == 0, "the media update rolls back with the insert"


def test_the_row_write_and_the_message_delete_commit_together(conn, store, media_id, monkeypatch):
    msg_id = send(conn, store, {"job": "face_process", "media_id": str(media_id)})
    store.read(120)

    def fail(*_args):
        raise RuntimeError("delete failed")

    monkeypatch.setattr(queue, "delete", fail)
    with pytest.raises(RuntimeError):
        JobContext(store, None, msg_id, "test").commit(
            lambda tx: tx.finish_face_process(
                media_id, 10, 10, f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp", [], []
            )
        )

    assert media_row(conn, media_id)[4] == 0
    monkeypatch.undo()
    store.retry_later(msg_id)
    assert store.read(120).msg_id == msg_id


def test_media_for_job_returns_a_soft_deleted_row_and_none_for_a_gone_one(conn, store, media_id):
    conn.execute("update public.media set deleted_at = now() where id = %s", (media_id,))

    row = store.media_for_job(media_id)
    assert (
        row.event_id
        == conn.execute("select event_id from public.media where id = %s", (media_id,)).fetchone()[
            0
        ]
    )
    assert (row.id, row.upload_key, row.upload_thumb_key, row.variant_version) == (
        media_id,
        f"{media_id}/upload.jpg",
        f"{media_id}/upload_thumb.webp",
        0,
    )
    assert (row.public_key, row.public_thumb_key, row.published) == (None, None, False)
    assert store.media_for_job(uuid4()) is None


def publish(conn, media_id, version=1):
    conn.execute(
        "update public.media set public_key = upload_key, public_thumb_key = upload_thumb_key,"
        " variant_version = %s, processed_at = now() - interval '1 day' where id = %s",
        (version, media_id),
    )


def add_region(conn, media_id, x, y, width, height):
    # clock_timestamp(), not the column's default now(): the fixture holds one transaction, where
    # now() never moves, so two regions would tie on created_at and sort by their random ids.
    conn.execute(
        "insert into public.manual_blur_region"
        " (id, media_id, drawn_by_user_id, x, y, width, height, created_at)"
        " select gen_random_uuid(), id, uploader_user_id, %s, %s, %s, %s, clock_timestamp()"
        " from public.media where id = %s",
        (x, y, width, height, media_id),
    )


def test_blur_regions_reads_the_photos_rows_oldest_first(conn, store, media_id):
    publish(conn, media_id)
    add_region(conn, media_id, 0.1, 0.2, 0.3, 0.4)
    conn.execute("select pg_sleep(0.01)")
    add_region(conn, media_id, 0.5, 0.5, 0.25, 0.25)

    regions = store.blur_regions(media_id)

    assert [(r.x, r.y, r.width, r.height) for r in regions] == [
        (0.1, 0.2, 0.3, 0.4),
        (0.5, 0.5, 0.25, 0.25),
    ]
    assert store.blur_regions(uuid4()) == []


def processed_at(conn, media_id):
    return conn.execute(
        "select processed_at from public.media where id = %s", (media_id,)
    ).fetchone()[0]


def test_finish_blur_region_points_the_row_at_new_keys_and_keeps_processed_at(
    conn, store, media_id
):
    publish(conn, media_id, version=2)
    before = processed_at(conn, media_id)

    with store.transaction() as tx:
        assert tx.finish_blur_region(
            media_id, 2, f"{media_id}/public_v3.jpg", f"{media_id}/public_thumb_v3.webp", []
        )

    row = media_row(conn, media_id)
    assert row[2:5] == (f"{media_id}/public_v3.jpg", f"{media_id}/public_thumb_v3.webp", 3)
    assert processed_at(conn, media_id) == before


def test_finish_blur_region_sets_processed_at_when_null(conn, store, media_id):
    publish(conn, media_id)
    conn.execute("update public.media set processed_at = null where id = %s", (media_id,))

    with store.transaction() as tx:
        assert tx.finish_blur_region(
            media_id, 1, f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp", []
        )

    assert media_row(conn, media_id)[4:6] == (2, True)


def test_finish_blur_region_refuses_a_changed_version_and_version_0(conn, store, media_id):
    with store.transaction() as tx:
        assert not tx.finish_blur_region(media_id, 0, "x", "y", [])
    publish(conn, media_id, version=4)
    with store.transaction() as tx:
        assert not tx.finish_blur_region(media_id, 3, "x", "y", [])

    assert media_row(conn, media_id)[2:5] == (
        f"{media_id}/upload.jpg",
        f"{media_id}/upload_thumb.webp",
        4,
    )


def test_finish_blur_region_replaces_the_photos_subjects(conn, store, media_id):
    publish(conn, media_id, version=2)
    kept, dropped = (
        conn.execute("insert into public.subject (user_id) values (null) returning id").fetchone()[
            0
        ]
        for _ in range(2)
    )
    conn.execute(
        "insert into public.dnp_subject (media_id, subject_id, variant_key, variant_thumb_key)"
        " values (%s, %s, %s, %s), (%s, %s, %s, %s)",
        (
            media_id,
            kept,
            f"{media_id}/{kept}_v2.jpg",
            f"{media_id}/{kept}_thumb_v2.webp",
            media_id,
            dropped,
            f"{media_id}/{dropped}_v2.jpg",
            f"{media_id}/{dropped}_thumb_v2.webp",
        ),
    )

    with store.transaction() as tx:
        assert tx.finish_blur_region(
            media_id,
            2,
            f"{media_id}/public_v3.jpg",
            f"{media_id}/public_thumb_v3.webp",
            [subject_row(media_id, kept, 3)],
        )

    assert dnp_rows(conn, media_id) == [
        (kept, f"{media_id}/{kept}_v3.jpg", f"{media_id}/{kept}_thumb_v3.webp")
    ]


@pytest.fixture
def members(conn, media_id):
    """Three throwaway accounts in the photo's event, each with an accepted reference there: an
    active member with Do Not Publish on, a removed one with it on, and an active one with it off.
    A fourth reference, in another event, belongs to the first account. The accounts go with the
    rolled-back transaction."""
    users = [
        conn.execute(
            "insert into auth.users (id, raw_user_meta_data)"
            ' values (gen_random_uuid(), \'{"full_name": "Worker SQL test"}\') returning id'
        ).fetchone()[0]
        for _ in range(3)
    ]
    event_id = conn.execute(
        "select event_id from public.media where id = %s", (media_id,)
    ).fetchone()[0]
    other_event = conn.execute(
        "insert into public.event (name, type, create_request_id)"
        " values ('Worker SQL test', 'other', gen_random_uuid()) returning id"
    ).fetchone()[0]
    subjects = []
    setup = [("active", True), ("removed", True), ("active", False)]
    for i, (user, (status, dnp)) in enumerate(zip(users, setup, strict=True)):
        conn.execute(
            "insert into public.subject (user_id) values (%s) on conflict (user_id) do nothing",
            (user,),
        )
        subject_id = conn.execute(
            "select id from public.subject where user_id = %s", (user,)
        ).fetchone()[0]
        subjects.append(subject_id)
        for event in (event_id, other_event):
            conn.execute(
                "insert into public.membership (event_id, user_id, role, status, dnp_activated_at)"
                " values (%s, %s, 'guest', %s, %s)",
                (event, user, status, "now" if dnp else None),
            )
        events = (event_id, other_event) if i == 0 else (event_id,)
        for event in events:
            reference = uuid4()
            conn.execute(
                "insert into public.face_reference"
                " (id, subject_id, event_id, photo_key, status, embedding)"
                " values (%s, %s, %s, %s, 'accepted', %s::extensions.vector)",
                (
                    reference,
                    subject_id,
                    event,
                    f"users/{user}/events/{event}/reference_{reference}.jpg",
                    vector_literal(unit(i if event == event_id else 9)),
                ),
            )
    return event_id, subjects


def test_flagged_references_take_every_member_with_do_not_publish_on_whatever_status(
    store, members
):
    event_id, (on_active, on_removed, _off) = members

    flagged = store.flagged_references(event_id)

    assert sorted(r.subject_id for r in flagged) == sorted([on_active, on_removed])
    by_subject = {r.subject_id: r.embedding for r in flagged}
    assert np.allclose(by_subject[on_active], unit(0)), "this event's reference, not the other's"
    assert np.allclose(by_subject[on_removed], unit(1))


def test_active_references_take_active_members_only(store, members):
    event_id, (on_active, _on_removed, off) = members

    active = store.active_references(event_id)

    assert sorted(r.subject_id for r in active) == sorted([on_active, off])
    assert len(active) == 2, "the other event's reference stays out (D-141)"


def test_clustered_faces_reads_the_events_unknown_clusters(conn, store, media_id):
    cluster = uuid4()
    with store.transaction() as tx:
        tx.finish_face_process(
            media_id,
            1,
            1,
            f"{media_id}/public_v1.jpg",
            f"{media_id}/public_thumb_v1.webp",
            [face(0, cluster_id=cluster), face(1)],
            [],
        )
    event_id = conn.execute(
        "select event_id from public.media where id = %s", (media_id,)
    ).fetchone()[0]

    clustered = store.clustered_faces(event_id)

    assert [c.cluster_id for c in clustered] == [cluster]
    assert np.allclose(clustered[0].embedding, unit(0))
    conn.execute("update public.media set deleted_at = now() where id = %s", (media_id,))
    assert store.clustered_faces(event_id) == []


def test_archive_clears_processed_at_in_the_same_transaction(conn, store, media_id):
    conn.execute("update public.media set processed_at = now() where id = %s", (media_id,))
    msg_id = send(conn, store, {"job": "blur_region", "media_id": str(media_id)})
    store.read(120)

    assert store.archive(msg_id, media_id, gone_is_done=True) is Archive.UNPUBLISHED

    assert media_row(conn, media_id)[5] is False
    assert in_archive(conn, store, msg_id)
    store.unhide()
    assert store.read(120) is None


def test_a_failed_archive_leaves_processed_at_set(conn, store, media_id, monkeypatch):
    conn.execute("update public.media set processed_at = now() where id = %s", (media_id,))
    msg_id = send(conn, store, {"job": "blur_region", "media_id": str(media_id)})

    def fail(*_args):
        raise RuntimeError("archive failed")

    monkeypatch.setattr(queue, "archive", fail)
    with pytest.raises(RuntimeError):
        store.archive(msg_id, media_id, gone_is_done=True)

    assert media_row(conn, media_id)[5] is True


def test_archive_deletes_a_gone_rows_message_as_done(conn, store):
    msg_id = send(conn, store, {"job": "blur_region", "media_id": str(uuid4())})

    assert store.archive(msg_id, uuid4(), gone_is_done=True) is Archive.GONE

    assert not in_archive(conn, store, msg_id)
    assert store.read(120) is None


def test_archive_keeps_an_unknown_jobs_message_whose_row_is_gone(conn, store):
    msg_id = send(conn, store, {"job": "face_process", "media_id": str(uuid4())})

    assert store.archive(msg_id, uuid4(), gone_is_done=False) is Archive.ARCHIVED
    assert in_archive(conn, store, msg_id)


@pytest.fixture
def reference_id(conn):
    """A pending face_reference in a throwaway event, for a subject with no account (D-63)."""
    event_id = conn.execute(
        "insert into public.event (name, type, create_request_id)"
        " values ('Worker SQL test', 'other', gen_random_uuid()) returning id"
    ).fetchone()[0]
    subject_id = conn.execute(
        "insert into public.subject (user_id) values (null) returning id"
    ).fetchone()[0]
    reference = uuid4()
    conn.execute(
        "insert into public.face_reference (id, subject_id, event_id, photo_key)"
        " values (%s, %s, %s, %s)",
        (
            reference,
            subject_id,
            event_id,
            f"users/{uuid4()}/events/{event_id}/reference_{reference}.jpg",
        ),
    )
    return reference


def reference_row(conn, reference_id):
    return conn.execute(
        "select status, reject_reason, embedding is not null from public.face_reference"
        " where id = %s",
        (reference_id,),
    ).fetchone()


def test_reference_for_job_reads_the_row_and_none_for_a_gone_one(conn, store, reference_id):
    row = store.reference_for_job(reference_id)
    assert row is not None
    assert (row.id, row.status) == (reference_id, "pending")
    assert row.photo_key.endswith(f"/reference_{reference_id}.jpg")
    assert store.reference_for_job(uuid4()) is None


def test_decide_reference_stores_the_embedding_as_512_floats(conn, store, reference_id):
    embedding = np.zeros(512, np.float32)
    embedding[0], embedding[511] = 0.6, 0.8
    with store.transaction() as tx:
        assert tx.decide_reference(reference_id, "accepted", None, embedding)

    assert reference_row(conn, reference_id) == ("accepted", None, True)
    dims, first, last = conn.execute(
        "select extensions.vector_dims(embedding), (embedding::real[])[1],"
        " (embedding::real[])[512] from public.face_reference where id = %s",
        (reference_id,),
    ).fetchone()
    assert (dims, first, last) == (512, pytest.approx(0.6), pytest.approx(0.8))


def test_decide_reference_rejects_and_then_refuses_a_decided_row(conn, store, reference_id):
    with store.transaction() as tx:
        assert tx.decide_reference(reference_id, "rejected", "multiple_faces", None)
    with store.transaction() as tx:
        assert not tx.decide_reference(reference_id, "rejected", "no_face", None)

    assert reference_row(conn, reference_id) == ("rejected", "multiple_faces", False)


def test_archive_rejects_a_pending_reference_as_failed(conn, store, reference_id):
    msg_id = send(conn, store, {"job": "reference_process", "face_reference_id": str(reference_id)})

    assert (
        store.archive(msg_id, None, gone_is_done=True, reference_id=reference_id)
        is Archive.REJECTED
    )

    assert reference_row(conn, reference_id) == ("rejected", "failed", False)
    assert in_archive(conn, store, msg_id)


def test_archive_deletes_a_gone_references_message_as_done(conn, store):
    msg_id = send(conn, store, {"job": "reference_process", "face_reference_id": str(uuid4())})

    assert store.archive(msg_id, None, gone_is_done=True, reference_id=uuid4()) is Archive.GONE
    assert not in_archive(conn, store, msg_id)


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
        # Postgres ends the session a moment after close() returns. Wait as long as the loop does.
        deadline = time.monotonic() + LOCK_WAIT_S
        while not second.try_lock():
            assert time.monotonic() < deadline, "the lock outlived its session"
            time.sleep(0.1)
    finally:
        first.close()
        second.close()
