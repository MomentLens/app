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
from collections.abc import Callable, Iterator, Sequence
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
    # deleted_at is set. Nobody can restore the photo, so every job but media_delete skips it
    # (D-130).
    deleted: bool


@dataclass(frozen=True)
class LockedMedia:
    """A media row as Store.archive sees it under its row lock."""

    published: bool
    deleted: bool


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
    # Recognition among the event's active members, and the Unknown cluster (D-74).
    matched_subject_id: UUID | None = None
    similarity: float | None = None
    cluster_id: UUID | None = None
    # The Do Not Publish subject the photo's current files blur this face for (D-178).
    dnp_subject_id: UUID | None = None


@dataclass(frozen=True)
class EventPhoto:
    """A published or once-published photo in an event, with its stored faces, as reprocess
    reads it."""

    row: MediaRow
    faces: list[StoredFace]


@dataclass(frozen=True)
class FaceUpdate:
    """reprocess's rewrite of one face row: its match, its cluster and the subject its files now
    blur it for (D-178)."""

    id: UUID
    matched_subject_id: UUID | None
    similarity: float | None
    cluster_id: UUID | None
    dnp_subject_id: UUID | None


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
    # The Do Not Publish subject the photo's files blur this face for, from variants.plan (D-178).
    dnp_subject_id: UUID | None = None


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
    subject_id: UUID
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
    # The photo is deleted and the job is not media_delete, so the message was deleted as done
    # (D-130, D-177).
    DELETED = "deleted"


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

    def lock_media(self, media_id: UUID) -> LockedMedia | None:
        """Locks the row and says whether it is published and deleted, or None when it is gone."""
        self._cur.execute(
            "select processed_at is not null, deleted_at is not null from public.media"
            " where id = %s for update",
            (media_id,),
        )
        row = self._cur.fetchone()
        return None if row is None else LockedMedia(published=bool(row[0]), deleted=bool(row[1]))

    def delete_media_rows(self, media_id: UUID) -> tuple[int, int, int]:
        """Deletes a deleted photo's face, dnp_subject and manual_blur_region rows, through each
        table's media_id index, and returns how many of each went. The media row stays, with
        deleted_at and its hash (D-130). photo_flag rows stay too; S-24 filters them (D-177)."""
        counts = []
        for table in ("face", "dnp_subject", "manual_blur_region"):
            # `table` is one of the three literals above, never input.
            self._cur.execute(f"delete from public.{table} where media_id = %s", (media_id,))
            counts.append(self._cur.rowcount)
        return counts[0], counts[1], counts[2]

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
                " cluster_id, dnp_subject_id)"
                " values (%s, %s, %s, %s, %s, %s::extensions.vector, %s, %s, %s, %s)",
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
                        f.dnp_subject_id,
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
        face_subjects: Sequence[tuple[UUID, UUID | None]] = (),
    ) -> bool:
        """Points the row and its subjects at a regeneration's files. False when no row matched,
        and then nothing is written.

        Matches only while variant_version is still the one the job read, so nothing another
        write changed is overwritten, and a retry after a failure rebuilds the same keys.
        processed_at is set when it is null and kept when it is not, so a message re-sent from the
        archive republishes the photo (D-171). The photo's dnp_subject rows are replaced by
        `subjects` in the same transaction, so a subject never holds a key from another version.
        `face_subjects` sets each face's dnp_subject_id, by face id, to the subject the new files
        blur it for (D-178). Every file the keys name already applies every stored region, so
        publishing in this statement is safe (root invariant 1, D-55).
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
        self._replace_subjects(media_id, subjects)
        self._set_dnp_subjects(media_id, face_subjects)
        return True

    def finish_reprocess(
        self,
        media_id: UUID,
        read_version: int,
        files: tuple[str, str, list[DnpSubject]] | None,
        faces: Sequence[FaceUpdate],
    ) -> bool:
        """One photo's part of reprocess: its face rows' new matches and, when its blurred faces
        changed, its new files (D-178). False when the row was deleted or rewritten since the job
        read it, and then nothing is written.

        `files` is the public key, the public thumbnail key and the subjects, at read_version + 1.
        The row's variant_version goes up by one with them (root invariant 2) and processed_at is
        left as it is: reprocess never publishes (arch §5). Every file is in R2 before this runs,
        so a published row never points at a file that is not there (root invariant 1).
        """
        self._cur.execute(
            "select 1 from public.media where id = %s and variant_version = %s"
            " and variant_version > 0 and deleted_at is null for update",
            (media_id, read_version),
        )
        if self._cur.fetchone() is None:
            return False
        if files is not None:
            public_key, public_thumb_key, subjects = files
            self._cur.execute(
                "update public.media"
                " set public_key = %s, public_thumb_key = %s, variant_version = variant_version + 1"
                " where id = %s",
                (public_key, public_thumb_key, media_id),
            )
            self._replace_subjects(media_id, subjects)
        if faces:
            # One statement per face sets all four columns at once, so face_cluster_check sees
            # a matched face with no cluster rather than a step in between.
            self._cur.executemany(
                "update public.face"
                " set matched_subject_id = %s, similarity = %s, cluster_id = %s,"
                " dnp_subject_id = %s"
                " where id = %s and media_id = %s",
                [
                    (
                        f.matched_subject_id,
                        f.similarity,
                        f.cluster_id,
                        f.dnp_subject_id,
                        f.id,
                        media_id,
                    )
                    for f in faces
                ],
            )
        return True

    def enqueue_reprocess(self, subject_id: UUID, event_id: UUID) -> None:
        """Sends reprocess for one subject in one event through the migration's one sender,
        public.enqueue_reprocess, so the message has one shape (S-25)."""
        self._cur.execute("select public.enqueue_reprocess(%s, %s)", (subject_id, event_id))

    def _replace_subjects(self, media_id: UUID, subjects: list[DnpSubject]) -> None:
        self._cur.execute("delete from public.dnp_subject where media_id = %s", (media_id,))
        self._insert_subjects(media_id, subjects)

    def _set_dnp_subjects(
        self, media_id: UUID, face_subjects: Sequence[tuple[UUID, UUID | None]]
    ) -> None:
        if face_subjects:
            self._cur.executemany(
                "update public.face set dnp_subject_id = %s where id = %s and media_id = %s",
                [(subject, face_id, media_id) for face_id, subject in face_subjects],
            )

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
        deletes_media: bool = False,
        unpublish: Sequence[UUID] = (),
    ) -> Archive:
        """A final failure. Archives the message and, in the same transaction, unpublishes the
        photo it names (D-108) or rejects the pending reference it names as `failed` (D-172).

        When `gone_is_done` is set, a message whose row is gone, or whose photo is deleted, is
        deleted as done instead, with no archive (arch §5, D-130).

        `deletes_media` is set for media_delete, which is archived either way: on a live row
        that is a bug to look at, and on a deleted or gone row the files under its prefix are
        still there, so the message is kept to send again. It never unpublishes: the job writes
        no file a viewer could see wrong, and a live photo stays in the album (D-177).

        `unpublish` lists more photos to take out of the album in the same transaction: a
        reprocess message names no photo, so the loop passes every photo it found to change and
        had not rebuilt (D-178). A deleted or gone one is passed over.
        """
        with self.transaction() as tx:
            locked = None if media_id is None else tx.lock_media(media_id)
            if media_id is not None and gone_is_done and not deletes_media:
                if locked is None:
                    tx.delete_message(msg_id)
                    return Archive.GONE
                if locked.deleted:
                    tx.delete_message(msg_id)
                    return Archive.DELETED
            status = None if reference_id is None else tx.lock_reference(reference_id)
            if reference_id is not None and status is None and gone_is_done:
                tx.delete_message(msg_id)
                return Archive.GONE
            published = locked is not None and locked.published and not deletes_media
            if published:
                tx.unpublish(media_id)
            rejected = reference_id is not None and status == "pending"
            if rejected:
                tx.fail_reference(reference_id)
            for other in unpublish:
                row = tx.lock_media(other)
                if row is not None and row.published and not row.deleted:
                    tx.unpublish(other)
                    published = True
            tx.archive_message(msg_id)
        if published:
            return Archive.UNPUBLISHED
        return Archive.REJECTED if rejected else Archive.ARCHIVED

    # --- media ------------------------------------------------------------------------------

    def media_for_job(self, media_id: UUID) -> MediaRow | None:
        """The row a job works on, deleted or not. Every job but media_delete skips a deleted one
        (D-130)."""
        with self._statement() as cur:
            cur.execute(
                "select id, event_id, upload_key, upload_thumb_key, public_key, public_thumb_key,"
                " variant_version, processed_at is not null, deleted_at is not null"
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
            deleted=bool(row[8]),
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
                f"select {_FACE_COLUMNS} from public.face f"
                " where f.media_id = %s order by f.created_at, f.id",
                (media_id,),
            )
            rows = cur.fetchall()
        return [_stored_face(r) for r in rows]

    def event_photos(self, event_id: UUID) -> list[EventPhoto]:
        """Every photo in the event that reprocess can rebuild, with its faces: not deleted
        (D-130), written by a job, so variant_version above 0, and with at least one face. A
        photo with no face cannot change. Scoped to the one event, so no other event's photo is
        read (D-129)."""
        with self._statement() as cur:
            cur.execute(
                "select m.id, m.event_id, m.upload_key, m.upload_thumb_key, m.public_key,"
                " m.public_thumb_key, m.variant_version, m.processed_at is not null,"
                f" {_FACE_COLUMNS}"
                " from public.media m join public.face f on f.media_id = m.id"
                " where m.event_id = %s and m.deleted_at is null and m.variant_version > 0"
                " order by m.created_at, m.id, f.created_at, f.id",
                (event_id,),
            )
            rows = cur.fetchall()
        photos: dict[UUID, EventPhoto] = {}
        for r in rows:
            photo = photos.get(r[0])
            if photo is None:
                row = MediaRow(
                    id=r[0],
                    event_id=r[1],
                    upload_key=r[2],
                    upload_thumb_key=r[3],
                    public_key=r[4],
                    public_thumb_key=r[5],
                    variant_version=r[6],
                    published=bool(r[7]),
                    deleted=False,
                )
                photo = photos[r[0]] = EventPhoto(row=row, faces=[])
            photo.faces.append(_stored_face(r[8:]))
        return list(photos.values())

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
                "select id, event_id, subject_id, photo_key, status from public.face_reference"
                " where id = %s",
                (reference_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return ReferenceRow(
            id=row[0], event_id=row[1], subject_id=row[2], photo_key=row[3], status=row[4]
        )

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


_FACE_COLUMNS = (
    "f.id, f.x, f.y, f.width, f.height, f.embedding::text, f.matched_subject_id, f.similarity,"
    " f.cluster_id, f.dnp_subject_id"
)


def _stored_face(r: Sequence[Any]) -> StoredFace:
    return StoredFace(
        id=r[0],
        x=r[1],
        y=r[2],
        width=r[3],
        height=r[4],
        embedding=parse_vector(r[5]),
        matched_subject_id=r[6],
        similarity=r[7],
        cluster_id=r[8],
        dnp_subject_id=r[9],
    )


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
