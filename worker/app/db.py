"""Postgres for the worker: one connection, the queue lock, reconnects and transactions.

The worker connects with DATABASE_URL as the postgres role, so RLS does not apply. Every query
here names one media row or one face_reference row by its primary key, that photo's own rows, or
one event's references and faces by the event's id, so none reaches into another event
(worker/AGENTS.md asks for every query to be scoped to its event).

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
from app.ai.matching import ClusterFace, Reference
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
    # Matching and blurring read only this event's references (D-141).
    event_id: UUID
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
class StoredFace:
    """One face row as blur_region and reprocess read it: the detector's box as fractions of the
    stored image, and its embedding, so nothing detects again (D-66, root invariant 10)."""

    id: UUID
    x: float
    y: float
    width: float
    height: float
    embedding: np.ndarray


@dataclass(frozen=True)
class NewFace:
    """A face row face_process inserts: the detector's box, its embedding, its recognition match
    among the event's active members and its Unknown cluster (D-74, arch:face)."""

    x: float
    y: float
    width: float
    height: float
    embedding: np.ndarray
    matched_subject_id: UUID | None
    similarity: float | None
    cluster_id: UUID | None


@dataclass(frozen=True)
class DnpSubject:
    """One dnp_subject row: a Do Not Publish subject in a photo and the keys of their own file
    and thumbnail, at the media row's variant_version (arch:dnp_subject)."""

    subject_id: UUID
    variant_key: str
    variant_thumb_key: str


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

    def finish_face_process(
        self,
        media_id: UUID,
        width: int,
        height: int,
        public_key: str,
        public_thumb_key: str,
        faces: list[NewFace],
        subjects: list[DnpSubject],
    ) -> bool:
        """Publishes a row no job has written yet with its faces and subjects. False when no row
        matched, and then nothing is written.

        The media update runs first and matches only variant_version 0, so a message re-sent from
        the archive never adds a second set of face rows (D-123). It takes variant_version to 1
        (root invariant 2) and sets processed_at in the same statement. Every file the keys name
        is already in R2 and the whole write commits at once, so no reader sees the row published
        before its faces and subjects exist (root invariant 1, D-55).
        """
        self._cur.execute(
            "update public.media"
            " set width = %(width)s, height = %(height)s,"
            " public_key = %(public)s, public_thumb_key = %(thumb)s,"
            " variant_version = variant_version + 1, processed_at = now()"
            " where id = %(id)s and variant_version = 0",
            {
                "id": media_id,
                "width": width,
                "height": height,
                "public": public_key,
                "thumb": public_thumb_key,
            },
        )
        if self._cur.rowcount != 1:
            return False
        if faces:
            self._cur.executemany(
                "insert into public.face"
                " (media_id, x, y, width, height, embedding, matched_subject_id, similarity,"
                " cluster_id)"
                " values (%s, %s, %s, %s, %s, %s::extensions.vector, %s, %s, %s)",
                [
                    (
                        media_id,
                        f.x,
                        f.y,
                        f.width,
                        f.height,
                        vector_literal(f.embedding),
                        f.matched_subject_id,
                        f.similarity,
                        f.cluster_id,
                    )
                    for f in faces
                ],
            )
        self._insert_subjects(media_id, subjects)
        return True

    def finish_blur_region(
        self,
        media_id: UUID,
        read_version: int,
        public_key: str,
        public_thumb_key: str,
        subjects: list[DnpSubject],
    ) -> bool:
        """Points the row and its subjects at a regeneration's files. False when no row matched,
        and then nothing is written.

        Matches only while variant_version is still the one the job read, so nothing another
        write changed is overwritten, and a retry after a failure rebuilds the same keys.
        processed_at is set when it is null and kept when it is not, so a message re-sent from the
        archive republishes the photo (D-171). The photo's dnp_subject rows are replaced by
        `subjects` in the same transaction, so a subject never holds a key from another version.
        Every file the keys name already applies every stored region, so publishing in this
        statement is safe (root invariant 1, D-55).
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
        if self._cur.rowcount != 1:
            return False
        self._cur.execute("delete from public.dnp_subject where media_id = %s", (media_id,))
        self._insert_subjects(media_id, subjects)
        return True

    def _insert_subjects(self, media_id: UUID, subjects: list[DnpSubject]) -> None:
        if subjects:
            self._cur.executemany(
                "insert into public.dnp_subject"
                " (media_id, subject_id, variant_key, variant_thumb_key) values (%s, %s, %s, %s)",
                [(media_id, s.subject_id, s.variant_key, s.variant_thumb_key) for s in subjects],
            )


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
                "select id, event_id, upload_key, upload_thumb_key, public_key, public_thumb_key,"
                " variant_version, processed_at is not null"
                " from public.media where id = %s",
                (media_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return MediaRow(
            id=row[0],
            event_id=row[1],
            upload_key=row[2],
            upload_thumb_key=row[3],
            public_key=row[4],
            public_thumb_key=row[5],
            variant_version=row[6],
            published=bool(row[7]),
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

    def faces(self, media_id: UUID) -> list[StoredFace]:
        """The photo's face rows as face_process stored them, through face_media_idx."""
        with self._statement() as cur:
            cur.execute(
                "select id, x, y, width, height, embedding::text from public.face"
                " where media_id = %s order by created_at, id",
                (media_id,),
            )
            rows = cur.fetchall()
        return [
            StoredFace(
                id=r[0], x=r[1], y=r[2], width=r[3], height=r[4], embedding=parse_vector(r[5])
            )
            for r in rows
        ]

    def dnp_subjects(self, media_id: UUID) -> list[DnpSubject]:
        """The photo's dnp_subject rows, so a regeneration can delete the files they replace."""
        with self._statement() as cur:
            cur.execute(
                "select subject_id, variant_key, variant_thumb_key from public.dnp_subject"
                " where media_id = %s order by subject_id",
                (media_id,),
            )
            rows = cur.fetchall()
        return [DnpSubject(subject_id=r[0], variant_key=r[1], variant_thumb_key=r[2]) for r in rows]

    def clustered_faces(self, event_id: UUID) -> list[ClusterFace]:
        """Every unmatched face already in an Unknown cluster in the event, for clustering a new
        photo's faces (D-74). Deleted photos are left out (D-130)."""
        with self._statement() as cur:
            cur.execute(
                "select f.cluster_id, f.embedding::text from public.face f"
                " join public.media m on m.id = f.media_id"
                " where m.event_id = %s and m.deleted_at is null and f.cluster_id is not null"
                " order by f.created_at, f.id",
                (event_id,),
            )
            rows = cur.fetchall()
        return [ClusterFace(cluster_id=r[0], embedding=parse_vector(r[1])) for r in rows]

    # --- face_reference ---------------------------------------------------------------------

    def active_references(self, event_id: UUID) -> list[Reference]:
        """Accepted references added to this event by subjects who are active members of it, for
        recognition: Find My Photos and Unknown clusters (D-141, D-175)."""
        return self._references(event_id, "m.status = 'active'")

    def flagged_references(self, event_id: UUID) -> list[Reference]:
        """Accepted references added to this event by subjects whose membership in it has Do Not
        Publish on, whatever its status, for blurring. A removed or blocked subject stays blurred
        in new photos (D-129, D-175)."""
        return self._references(event_id, "m.dnp_activated_at is not null")

    def _references(self, event_id: UUID, condition: str) -> list[Reference]:
        # `condition` is one of the two literals above, never input.
        with self._statement() as cur:
            cur.execute(
                "select r.subject_id, r.embedding::text from public.face_reference r"
                " join public.subject s on s.id = r.subject_id"
                " join public.membership m on m.user_id = s.user_id and m.event_id = r.event_id"
                f" where r.event_id = %s and r.status = 'accepted' and {condition}"
                " order by r.subject_id, r.created_at, r.id",
                (event_id,),
            )
            rows = cur.fetchall()
        return [Reference(subject_id=r[0], embedding=parse_vector(r[1])) for r in rows]

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


def parse_vector(text: str) -> np.ndarray:
    """A pgvector value read as `::text`, `[v1,v2,...]`, as float32."""
    return np.array(text.strip("[]").split(","), dtype=np.float32)


def _first_line(error: BaseException) -> str:
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__
