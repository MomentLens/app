"""Postgres for the worker: one connection, the queue lock, reconnects and transactions.

The worker connects with DATABASE_URL as the postgres role, so RLS does not apply. Every query
here names one media row or one face_reference row by its primary key, or that photo's blur
regions, so none reaches into another event (worker/AGENTS.md asks for every query to be scoped to
its event).

The connection runs in autocommit, so a statement outside `transaction()` commits on its own.
That is what makes a pgmq read count as a try when the process dies before the job's own
transaction commits (D-123).
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from typing import Any
from uuid import UUID

import numpy as np
import psycopg

from app import queue
from app.queue import Message

log = logging.getLogger("momentlens.worker.db")

# The session-level advisory lock that makes this worker the queue's one reader (D-123). Every
# worker on every machine derives the same number, so two workers pointed at one project meet.
LOCK_KEY = int.from_bytes(hashlib.sha256(b"momentlens:jobs").digest()[:8], "big", signed=True)


class DatabaseUnavailable(Exception):
    """The connection was lost. The loop reconnects, takes the lock again and unhides."""


@dataclass(frozen=True)
class MediaRow:
    id: UUID
    upload_key: str
    upload_thumb_key: str
    # None until a job first writes the row.
    public_key: str | None
    public_thumb_key: str | None
    variant_version: int
    # processed_at is set, so the photo is in the album.
    published: bool


@dataclass(frozen=True)
class BlurRegion:
    """One manual_blur_region row: fractions of the stored image, upright (D-99)."""

    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class ReferenceRow:
    """The face_reference row reference_process works on."""

    id: UUID
    event_id: UUID
    # Built by the API (root invariant 12); the worker only reads it.
    photo_key: str
    status: str


class Archive(Enum):
    ARCHIVED = "archived"
    # Archived, and the photo's processed_at cleared in the same transaction (D-108).
    UNPUBLISHED = "unpublished"
    # Archived, and the pending reference set rejected with `failed` in the same transaction, so
    # the app stops polling it (D-172).
    REJECTED = "rejected"
    # The photo's or the reference's row no longer exists, so the message was deleted as done
    # (arch §5).
    GONE = "gone"


class Tx:
    """The writes a job makes inside its one transaction (app/jobs/base.py, JobContext.commit)."""

    def __init__(self, cur: psycopg.Cursor[Any], queue_name: str) -> None:
        self._cur = cur
        self._queue = queue_name

    def delete_message(self, msg_id: int) -> None:
        if not queue.delete(self._cur, self._queue, msg_id):
            log.warning("msg_id=%s was already gone from the queue when its job committed", msg_id)

    def archive_message(self, msg_id: int) -> None:
        if not queue.archive(self._cur, self._queue, msg_id):
            log.warning("msg_id=%s was already gone from the queue when it was archived", msg_id)

    def lock_media(self, media_id: UUID) -> bool | None:
        """Locks the row and says whether it is published, or returns None when it is gone."""
        self._cur.execute(
            "select processed_at is not null from public.media where id = %s for update",
            (media_id,),
        )
        row = self._cur.fetchone()
        return None if row is None else bool(row[0])

    def unpublish(self, media_id: UUID) -> None:
        """Takes the photo out of the album after a final failure (D-108)."""
        self._cur.execute("update public.media set processed_at = null where id = %s", (media_id,))

    def lock_reference(self, reference_id: UUID) -> str | None:
        """Locks the reference and returns its status, or None when it is gone."""
        self._cur.execute(
            "select status from public.face_reference where id = %s for update", (reference_id,)
        )
        row = self._cur.fetchone()
        return None if row is None else str(row[0])

    def fail_reference(self, reference_id: UUID) -> None:
        """Rejects a pending reference as `failed` after reference_process's final failure, so the
        app stops polling it (D-172). A decided row is left as it is."""
        self._cur.execute(
            "update public.face_reference set status = 'rejected', reject_reason = 'failed'"
            " where id = %s and status = 'pending'",
            (reference_id,),
        )

    def decide_reference(
        self,
        reference_id: UUID,
        status: str,
        reject_reason: str | None,
        embedding: np.ndarray | None,
    ) -> bool:
        """Writes reference_process's decision on a pending row. False when no row matched.

        `accepted` carries the embedding and no reason; `rejected` carries a reason and no
        embedding. face_reference's checks refuse any other pairing. Matching only a pending row
        means a message re-sent from the archive never overwrites a decision.
        """
        self._cur.execute(
            "update public.face_reference"
            " set status = %(status)s, reject_reason = %(reason)s,"
            " embedding = %(embedding)s::extensions.vector"
            " where id = %(id)s and status = 'pending'",
            {
                "id": reference_id,
                "status": status,
                "reason": reject_reason,
                "embedding": None if embedding is None else vector_literal(embedding),
            },
        )
        return self._cur.rowcount == 1

    def finish_thumbnail_dims(self, media_id: UUID, width: int, height: int) -> bool:
        """Publishes a row no job has written yet, in one update. False when no row matched.

        The public keys are copied from the row's own upload keys, which the API built, so this
        builds no key (root invariant 12, arch §3). variant_version goes from 0 to 1 (root
        invariant 2) and processed_at is set in the same statement, so Realtime never sends a
        row that has one without the others (root invariant 1, D-55).
        """
        self._cur.execute(
            "update public.media"
            " set width = %(width)s, height = %(height)s,"
            " public_key = upload_key, public_thumb_key = upload_thumb_key,"
            " variant_version = variant_version + 1, processed_at = now()"
            " where id = %(id)s and variant_version = 0",
            {"id": media_id, "width": width, "height": height},
        )
        return self._cur.rowcount == 1

    def finish_blur_region(
        self, media_id: UUID, read_version: int, public_key: str, public_thumb_key: str
    ) -> bool:
        """Points the row at a blur_region's files, in one update. False when no row matched.

        Matches only while variant_version is still the one the job read, so nothing another
        write changed is overwritten, and a retry after a failure rebuilds the same keys.
        processed_at is set when it is null and kept when it is not, so a message re-sent from the
        archive republishes the photo (D-171). Every file the keys name already applies every
        stored region, so publishing in this statement is safe (root invariant 1, D-55).
        """
        self._cur.execute(
            "update public.media"
            " set public_key = %(public)s, public_thumb_key = %(thumb)s,"
            " variant_version = variant_version + 1,"
            " processed_at = coalesce(processed_at, now())"
            " where id = %(id)s and variant_version = %(version)s and variant_version > 0",
            {
                "id": media_id,
                "version": read_version,
                "public": public_key,
                "thumb": public_thumb_key,
            },
        )
        return self._cur.rowcount == 1


def _connect(conninfo: str) -> psycopg.Connection[Any]:
    return psycopg.connect(
        conninfo,
        autocommit=True,
        connect_timeout=10,
        application_name="momentlens-worker",
        # Notice a dead link in about a minute rather than at the next statement.
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=3,
    )


class Store:
    """The worker's Postgres session. One per process; the loop is its only user."""

    def __init__(
        self,
        conninfo: str | None = None,
        *,
        connect: Callable[[], psycopg.Connection[Any]] | None = None,
        queue_name: str = queue.QUEUE,
        lock_key: int = LOCK_KEY,
    ) -> None:
        if connect is None:
            if conninfo is None:
                raise ValueError("Store needs conninfo or connect")
            connect = lambda: _connect(conninfo)  # noqa: E731
        self._connect = connect
        self._conn: psycopg.Connection[Any] | None = None
        self.queue = queue_name
        self.lock_key = lock_key
        # True while this session holds the queue lock. The lock goes with the session.
        self.locked = False

    # --- the session ------------------------------------------------------------------------

    def connect(self) -> None:
        """Opens the session unless a live one is open."""
        if self._conn is not None and not self._conn.closed and not self._conn.broken:
            return
        self.close()
        try:
            self._conn = self._connect()
        except psycopg.OperationalError as error:
            raise DatabaseUnavailable(_first_line(error)) from None

    def close(self) -> None:
        """Drops the session, and with it the lock. Never raises."""
        conn, self._conn, self.locked = self._conn, None, False
        if conn is not None:
            try:
                conn.close()
            except Exception:  # A broken connection may refuse even this.
                log.debug("closing a dead connection failed", exc_info=True)

    def try_lock(self) -> bool:
        with self._statement() as cur:
            cur.execute("select pg_try_advisory_lock(%s::bigint)", (self.lock_key,))
            row = cur.fetchone()
        self.locked = bool(row and row[0])
        return self.locked

    @contextmanager
    def transaction(self) -> Iterator[Tx]:
        """One transaction, or a savepoint when the caller already holds one, as tests do."""
        with self._guard():
            conn = self._live()
            with conn.transaction(), conn.cursor() as cur:
                yield Tx(cur, self.queue)

    # --- the queue --------------------------------------------------------------------------

    def read(self, visibility_timeout_s: int) -> Message | None:
        with self._statement() as cur:
            return queue.read(cur, self.queue, visibility_timeout_s)

    def delete(self, msg_id: int) -> None:
        with self._statement() as cur:
            queue.delete(cur, self.queue, msg_id)

    def retry_later(self, msg_id: int) -> None:
        """Puts a failed message back at the head of the line, so it goes before any newer one."""
        with self._statement() as cur:
            queue.make_visible(cur, self.queue, msg_id)

    def unhide(self) -> list[int]:
        with self._statement() as cur:
            return queue.unhide(cur, self.queue)

    def archive(
        self,
        msg_id: int,
        media_id: UUID | None,
        *,
        gone_is_done: bool,
        reference_id: UUID | None = None,
    ) -> Archive:
        """A final failure. Archives the message and, in the same transaction, unpublishes the
        photo it names (D-108) or rejects the pending reference it names as `failed` (D-172).

        When that row is gone and `gone_is_done` is set, the message is deleted as done instead,
        with no archive (arch §5).
        """
        with self.transaction() as tx:
            published = None if media_id is None else tx.lock_media(media_id)
            if media_id is not None and published is None and gone_is_done:
                tx.delete_message(msg_id)
                return Archive.GONE
            status = None if reference_id is None else tx.lock_reference(reference_id)
            if reference_id is not None and status is None and gone_is_done:
                tx.delete_message(msg_id)
                return Archive.GONE
            if media_id is not None and published:
                tx.unpublish(media_id)
            rejected = reference_id is not None and status == "pending"
            if rejected:
                tx.fail_reference(reference_id)
            tx.archive_message(msg_id)
        if published:
            return Archive.UNPUBLISHED
        return Archive.REJECTED if rejected else Archive.ARCHIVED

    # --- media ------------------------------------------------------------------------------

    def media_for_job(self, media_id: UUID) -> MediaRow | None:
        """The row a job works on. A soft-deleted row is returned like any other for now. Nobody
        can restore a deleted photo, so S-22a makes every job but media_delete skip one (D-130)."""
        with self._statement() as cur:
            cur.execute(
                "select id, upload_key, upload_thumb_key, public_key, public_thumb_key,"
                " variant_version, processed_at is not null"
                " from public.media where id = %s",
                (media_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return MediaRow(
            id=row[0],
            upload_key=row[1],
            upload_thumb_key=row[2],
            public_key=row[3],
            public_thumb_key=row[4],
            variant_version=row[5],
            published=bool(row[6]),
        )

    def blur_regions(self, media_id: UUID) -> list[BlurRegion]:
        """Every region stored on the photo now, oldest first, through
        manual_blur_region_media_idx. The job reads them itself; the message carries none."""
        with self._statement() as cur:
            cur.execute(
                "select x, y, width, height from public.manual_blur_region"
                " where media_id = %s order by created_at, id",
                (media_id,),
            )
            rows = cur.fetchall()
        return [BlurRegion(x=r[0], y=r[1], width=r[2], height=r[3]) for r in rows]

    # --- face_reference ---------------------------------------------------------------------

    def reference_for_job(self, reference_id: UUID) -> ReferenceRow | None:
        """The reference reference_process decides, or None when the API deleted it (D-172)."""
        with self._statement() as cur:
            cur.execute(
                "select id, event_id, photo_key, status from public.face_reference where id = %s",
                (reference_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return ReferenceRow(id=row[0], event_id=row[1], photo_key=row[2], status=row[3])

    # --- internals --------------------------------------------------------------------------

    def _live(self) -> psycopg.Connection[Any]:
        if self._conn is None:
            raise DatabaseUnavailable("not connected")
        return self._conn

    @contextmanager
    def _guard(self) -> Iterator[None]:
        """Turns an error from a lost connection into DatabaseUnavailable. Others pass."""
        try:
            yield
        except psycopg.Error as error:
            conn = self._conn
            if conn is None or conn.closed or conn.broken:
                self.close()
                raise DatabaseUnavailable(_first_line(error)) from error
            raise

    @contextmanager
    def _statement(self) -> Iterator[psycopg.Cursor[Any]]:
        with self._guard(), self._live().cursor() as cur:
            yield cur


def vector_literal(embedding: np.ndarray) -> str:
    """pgvector's text form, `[v1,v2,...]`, which a `::extensions.vector` cast reads. Nine
    significant digits bring a float32 back exactly, so no Python pgvector package is needed."""
    return "[" + ",".join(format(float(v), ".9g") for v in np.ravel(embedding)) + "]"


def _first_line(error: BaseException) -> str:
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__
