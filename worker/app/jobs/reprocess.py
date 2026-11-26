"""reprocess: re-match an event's stored faces and rebuild the photos whose blurred faces changed
(spec §4.11.4.5, arch §5, D-66, D-178).

The message names one subject in one event. Do Not Publish turned on there, the subject's
references there changed, or the subject became an active member again (D-84, D-129, D-141).
The match runs over the whole event, against its references as they are now, so the subject in
the message is for the log: whatever changed for them is in the references the job reads.

1. Without arch §6's match threshold nothing is compared and nothing is written: face_process
   already blurred every face and recorded no match (D-104, D-172).
2. Reads every photo in the event that is not deleted, has been written by a job and has a face
   (D-130). No other event's photo, and no detection: every face already has its box and its
   embedding (D-66, root invariant 10).
3. Rewrites each face's match against the active members' references (D-141, D-175). A face that
   becomes matched leaves its Unknown cluster; one that loses its match joins one.
4. Plans each photo with app/variants.py against the references of members with Do Not Publish
   on, whatever their status, and compares each face's subject with face.dnp_subject_id. Only a
   photo where they differ is rebuilt: the public file, every subject's file and all their
   thumbnails, with every stored region, at the next variant_version (root invariants 2, 6, 11).
5. Commits each photo on its own and deletes the message with the last one, so a rerun after a
   failure finds the rebuilt photos unchanged and skips them (D-178). processed_at is never set.
6. A photo whose upload object is missing is unpublished and reported, and the job carries on,
   so one lost object never leaves the rest of the event unblurred (D-178).

A final failure unpublishes every photo the job would still rebuild, through
`unpublish_on_failure`, in the archive's transaction (D-108, D-178).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import sentry_sdk

from app import images, variants
from app.ai import matching
from app.ai.matching import ClusterFace
from app.db import EventPhoto, FaceUpdate, Store, Tx
from app.jobs.base import Job, JobContext, JobMessage
from app.storage import ObjectMissing

log = logging.getLogger("momentlens.worker.jobs")

NAME = "reprocess"


class Message(JobMessage):
    job: Literal["reprocess"]
    subject_id: UUID
    event_id: UUID


@dataclass(frozen=True)
class Change:
    """One photo the job writes: its faces' new rows, and the plan when its files change."""

    photo: EventPhoto
    faces: list[FaceUpdate]
    # Set when the faces any of its files blur changed, so its files are rebuilt.
    plan: variants.Plan | None


def changes(store: Store, event_id: UUID, threshold: float) -> list[Change]:
    """Every photo in the event whose face rows or files the references as they are now change.
    Reads only; the job and its final failure both call it, so the archive unpublishes exactly
    the photos a rerun would rebuild."""
    photos = store.event_photos(event_id)
    if not photos:
        return []
    active = store.active_references(event_id)
    flagged = store.flagged_references(event_id)

    matches = {
        p.row.id: matching.match([f.embedding for f in p.faces], active, threshold) for p in photos
    }
    clusters = _clusters(photos, matches)

    result = []
    for p in photos:
        updates = []
        chosen = variants.plan(p.faces, flagged, threshold)
        for i, (face, m) in enumerate(zip(p.faces, matches[p.row.id], strict=True)):
            new = FaceUpdate(
                id=face.id,
                matched_subject_id=None if m is None else m.subject_id,
                similarity=None if m is None else m.similarity,
                cluster_id=None if m is not None else clusters.get(face.id, face.cluster_id),
                dnp_subject_id=chosen.face_subjects[i],
            )
            old = FaceUpdate(
                id=face.id,
                matched_subject_id=face.matched_subject_id,
                similarity=face.similarity,
                cluster_id=face.cluster_id,
                dnp_subject_id=face.dnp_subject_id,
            )
            if not _same_match(new, old):
                updates.append(new)
        rebuild = chosen.face_subjects != tuple(f.dnp_subject_id for f in p.faces)
        if updates or rebuild:
            result.append(Change(photo=p, faces=updates, plan=chosen if rebuild else None))
    return result


def _same_match(new: FaceUpdate, old: FaceUpdate) -> bool:
    """Equal but for float noise in the similarity, which Postgres stores as real."""
    if (new.matched_subject_id, new.cluster_id, new.dnp_subject_id) != (
        old.matched_subject_id,
        old.cluster_id,
        old.dnp_subject_id,
    ):
        return False
    if new.similarity is None or old.similarity is None:
        return new.similarity is old.similarity
    return abs(new.similarity - old.similarity) < 1e-6


def _clusters(
    photos: Sequence[EventPhoto], matches: dict[UUID, list[matching.Match | None]]
) -> dict[UUID, UUID | None]:
    """A cluster for each face that loses its match, among the faces that stay in clusters
    (D-74). None for each while arch §6 has no clustering threshold (D-104, D-172)."""
    staying: list[ClusterFace] = []
    losing = []
    for p in photos:
        for face, m in zip(p.faces, matches[p.row.id], strict=True):
            if m is not None:
                continue
            if face.matched_subject_id is not None:
                losing.append(face)
            elif face.cluster_id is not None:
                staying.append(ClusterFace(face.cluster_id, face.embedding))
    if not losing:
        return {}
    found = matching.cluster([f.embedding for f in losing], staying, matching.CLUSTER_THRESHOLD)
    return {f.id: c for f, c in zip(losing, found, strict=True)}


def run(ctx: JobContext, message: Message) -> None:
    where = ctx.where
    # Read at call time, so a test's own threshold reaches it (D-104).
    threshold = matching.MATCH_THRESHOLD
    if threshold is None:
        log.info(
            "%s arch §6 has no match threshold, so every face stays blurred and nothing is"
            " written (D-172)",
            where,
        )
        return

    work = changes(ctx.store, message.event_id, threshold)
    if not work:
        log.info("%s subject_id=%s nothing changed in the event", where, message.subject_id)
        return

    rebuilt = matched = skipped = missing = 0
    for n, change in enumerate(work):
        last = n == len(work) - 1
        outcome = _photo(ctx, change, last=last)
        if outcome == "rebuilt":
            rebuilt += 1
        elif outcome == "matched":
            matched += 1
        elif outcome == "missing":
            missing += 1
        else:
            skipped += 1
    log.info(
        "%s subject_id=%s %d photo(s) rebuilt, %d with only their matches rewritten, %d"
        " unpublished for a missing upload, %d changed under the job and left",
        where,
        message.subject_id,
        rebuilt,
        matched,
        missing,
        skipped,
    )


def _photo(ctx: JobContext, change: Change, *, last: bool) -> str:
    row = change.photo.row
    where = f"{ctx.where} media_id={row.id}"

    if change.plan is None:
        written = _commit(ctx, row.id, row.variant_version, None, change.faces, last)
        return "matched" if written else "skipped"

    old_subjects = ctx.store.dnp_subjects(row.id)
    regions = ctx.store.blur_regions(row.id)
    version = row.variant_version + 1
    try:
        # The upload key comes from the row, which the API wrote (root invariant 12).
        files = variants.write(
            ctx.storage,
            row.id,
            version,
            row.upload_key,
            row.upload_thumb_key,
            lambda: images.decode(ctx.storage.read(row.upload_key)),
            change.photo.faces,
            change.plan,
            regions,
        )
    except ObjectMissing as error:
        _missing(ctx, where, row.id, error, last)
        return "missing"

    written = _commit(
        ctx,
        row.id,
        row.variant_version,
        (files.public_key, files.public_thumb_key, files.subjects),
        change.faces,
        last,
    )
    if not written:
        # Files written above sit at keys no row points at; media_delete removes them.
        log.info(
            "%s deleted or rewritten since the job read it (variant_version was %s), so it was"
            " left",
            where,
            row.variant_version,
        )
        return "skipped"
    log.info(
        "%s rebuilt at variant_version=%s with %d face(s) blurred in the public file, %d Do Not"
        " Publish subject(s) and %d region(s)",
        where,
        version,
        len(change.plan.public),
        len(files.subjects),
        len(regions),
    )
    variants.delete_replaced(ctx.storage, where, row, old_subjects, files)
    return "rebuilt"


def _commit(
    ctx: JobContext,
    media_id: UUID,
    read_version: int,
    files: tuple[str, str, list] | None,
    faces: list[FaceUpdate],
    last: bool,
) -> bool:
    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.finish_reprocess(media_id, read_version, files, faces)

    ctx.commit(write, last=last)
    return written


def _missing(ctx: JobContext, where: str, media_id: UUID, error: ObjectMissing, last: bool) -> None:
    """Unpublishes a photo whose upload object is gone and reports it, so the job can carry on
    with the rest of the event (D-178)."""

    def write(tx: Tx) -> None:
        locked = tx.lock_media(media_id)
        if locked is not None and locked.published and not locked.deleted:
            tx.unpublish(media_id)

    ctx.commit(write, last=last)
    log.error("%s %s, so the photo was unpublished and the job carried on (D-178)", where, error)
    with sentry_sdk.new_scope() as scope:
        scope.set_tag("job", NAME)
        scope.set_tag("archive_reason", "missing_object")
        scope.set_context("photo", {"media_id": str(media_id)})
        scope.fingerprint = ["worker-reprocess", "missing_object"]
        sentry_sdk.capture_message(
            "reprocess unpublished a photo whose upload object is missing", "error"
        )


def unpublish_on_failure(store: Store, message: Message) -> list[UUID]:
    """Every photo the job would still rebuild, for the archive to unpublish (D-178). Photos
    already rebuilt plan the same as they are stored, so they stay up."""
    threshold = matching.MATCH_THRESHOLD
    if threshold is None:
        return []
    return [c.photo.row.id for c in changes(store, message.event_id, threshold) if c.plan]


JOB = Job(name=NAME, message=Message, run=run, unpublish_on_failure=unpublish_on_failure)
