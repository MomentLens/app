"""face_process: detect, match and blur a finished upload, then publish it (arch §5, D-72).

complete_upload sends this message when the photo's upload is done (S-21's migration). It replaced
thumbnail_dims, so a photo is never published before its faces are blurred.

1. Acts only on a row no job has written, variant_version 0. Any other row's message is done, so a
   message re-sent from the archive never undoes another job's files (D-123). So is a deleted
   photo's: nobody can restore it, and media_delete is queued behind (D-130).
2. Detects faces once and keeps each box and embedding. Nothing detects this photo again
   (D-66, root invariant 10).
3. Matches every face against the accepted references active members added to this event, for
   recognition, and clusters the unmatched ones (D-74, D-141, D-175).
4. Asks app/variants.py which faces each file blurs, against the references of members with Do
   Not Publish on in this event, whatever their status (D-129, D-175). While arch §6 has no match
   threshold every face is blurred and nobody is a subject (D-104, D-172).
5. Writes the public file and one file per subject, each with its thumbnail and every stored
   region, at variant_version 1's keys. A photo with no face to blur and no region keeps the
   upload keys and writes no object (root invariants 6, 11, 13).
6. One transaction sets the size, the keys, variant_version 1 and processed_at, and inserts the
   face and dnp_subject rows, with the message's delete. Every file is in R2 before it commits
   (root invariant 1).
"""

from __future__ import annotations

import logging
from typing import Literal

from app import images, variants
from app.ai import faces, matching
from app.db import NewFace, Tx
from app.jobs.base import Job, JobContext, MediaMessage

log = logging.getLogger("momentlens.worker.jobs")

NAME = "face_process"


class Message(MediaMessage):
    job: Literal["face_process"]


def run(ctx: JobContext, message: Message) -> None:
    where = ctx.where
    media_id = message.media_id

    row = ctx.store.media_for_job(media_id)
    if row is None:
        log.info("%s the row is gone, so the message is done (arch §5)", where)
        return
    if row.deleted:
        log.info("%s the photo is deleted, so the message is done (D-130)", where)
        return
    if row.variant_version != 0:
        log.info(
            "%s variant_version=%s, a job already wrote this row, so the message is done",
            where,
            row.variant_version,
        )
        return

    # The key comes from the row, which the API wrote (root invariant 12). Read as stored: Stage 1
    # already turned it upright (D-99).
    image = images.decode(ctx.storage.read(row.upload_key))
    height, width = image.shape[:2]
    found = faces.detect(image)
    embeddings = [f.embedding for f in found]

    # Read at call time, so a test's own threshold reaches it (D-104). With no threshold there is
    # nothing to compare, so no reference is read.
    match_threshold = matching.MATCH_THRESHOLD
    compare = bool(found) and match_threshold is not None
    recognised = matching.match(
        embeddings,
        ctx.store.active_references(row.event_id) if compare else [],
        match_threshold,
    )
    unmatched = [i for i, m in enumerate(recognised) if m is None]
    cluster_threshold = matching.CLUSTER_THRESHOLD
    existing = (
        ctx.store.clustered_faces(row.event_id)
        if unmatched and cluster_threshold is not None
        else []
    )
    clusters = dict(
        zip(
            unmatched,
            matching.cluster([embeddings[i] for i in unmatched], existing, cluster_threshold),
            strict=True,
        )
    )

    chosen = variants.plan(
        found,
        ctx.store.flagged_references(row.event_id) if compare else [],
        match_threshold,
    )
    regions = ctx.store.blur_regions(media_id)
    files = variants.write(
        ctx.storage,
        media_id,
        1,
        row.upload_key,
        row.upload_thumb_key,
        lambda: image,
        found,
        chosen,
        regions,
    )

    new_faces = [
        NewFace(
            x=f.x,
            y=f.y,
            width=f.width,
            height=f.height,
            embedding=f.embedding,
            matched_subject_id=None if m is None else m.subject_id,
            similarity=None if m is None else m.similarity,
            cluster_id=clusters.get(i),
        )
        for i, (f, m) in enumerate(zip(found, recognised, strict=True))
    ]

    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.finish_face_process(
            media_id,
            width,
            height,
            files.public_key,
            files.public_thumb_key,
            new_faces,
            files.subjects,
        )

    ctx.commit(write)
    if not written:
        # Files written above sit at version 1 keys no row points at; media_delete removes them.
        log.info("%s the row changed or went before the update, so nothing was written", where)
        return
    log.info(
        "%s published at %sx%s, variant_version=1, %d face(s), %d blurred in the public file,"
        " %d Do Not Publish subject(s), %d region(s), match threshold %s",
        where,
        width,
        height,
        len(found),
        len(chosen.public),
        len(files.subjects),
        len(regions),
        "not measured" if match_threshold is None else match_threshold,
    )


JOB = Job(name=NAME, message=Message, run=run)
