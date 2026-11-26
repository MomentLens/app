"""blur_region: rebuild a photo's files with every stored region (D-83).

A manual_blur_region row added or deleted sends this message (arch:manual_blur_region). No ML: the
faces are the rows face_process stored, and matching compares their stored embeddings, so nothing
detects again (D-66, root invariant 10). The job reads the photo's regions as they are now, so two
quick draws run twice and the second run carries both.

- A deleted photo's message is done with nothing read: nobody can restore it, and media_delete
  is queued behind (D-130).
- app/variants.py decides which faces the public file and each Do Not Publish subject's file blur,
  the same function face_process uses, against the event's flagged references as they are now.
- With a face to blur or a region, it writes the public file and every subject's file, each with
  its thumbnail, at the next version's keys, then points the row and the subject rows at them. A
  retry before the commit rewrites the same keys, which no row points at yet (D-103).
- With neither, it points the public keys back at the upload keys, keeps no subject and writes no
  object (arch §3, root invariant 13). While arch §6 has no match threshold every face is one to
  blur, so a photo with a face never points back at the upload.
- Either way the update bumps variant_version (root invariant 2) and sets processed_at when it is
  null, so a message re-sent from the archive republishes the photo (D-171).
- After the commit it deletes the files the rows stopped pointing at, never an upload key.
"""

from __future__ import annotations

import logging
from typing import Literal

from app import images, variants
from app.ai import matching
from app.db import Tx
from app.jobs.base import Job, JobContext, MediaMessage

log = logging.getLogger("momentlens.worker.jobs")

NAME = "blur_region"


class Message(MediaMessage):
    job: Literal["blur_region"]


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
    if row.variant_version == 0:
        # No job has written the row, so it has no public files to rebuild and add_blur_region
        # refuses it as unprocessed.
        log.info(
            "%s variant_version=0, nothing published to rebuild, so the message is done", where
        )
        return

    regions = ctx.store.blur_regions(media_id)
    stored = ctx.store.faces(media_id)
    old_subjects = ctx.store.dnp_subjects(media_id)
    # Read at call time, so a test's own threshold reaches it (D-104).
    threshold = matching.MATCH_THRESHOLD
    flagged = ctx.store.flagged_references(row.event_id) if stored and threshold is not None else []
    chosen = variants.plan(stored, flagged, threshold)
    version = row.variant_version + 1
    # The upload key comes from the row, which the API wrote (root invariant 12).
    files = variants.write(
        ctx.storage,
        media_id,
        version,
        row.upload_key,
        row.upload_thumb_key,
        lambda: images.decode(ctx.storage.read(row.upload_key)),
        stored,
        chosen,
        regions,
    )

    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.finish_blur_region(
            media_id,
            row.variant_version,
            files.public_key,
            files.public_thumb_key,
            files.subjects,
        )

    ctx.commit(write)
    if not written:
        # Files written above sit at keys no row points at; media_delete removes them.
        log.info(
            "%s the row changed or went before the update (variant_version was %s), so nothing"
            " was written",
            where,
            row.variant_version,
        )
        return

    log.info(
        "%s %s with %d face(s) blurred in the public file, %d Do Not Publish subject(s) and %d"
        " region(s) at variant_version=%s%s",
        where,
        "pointed back at the upload" if files.public_key == row.upload_key else "rebuilt",
        len(chosen.public),
        len(files.subjects),
        len(regions),
        version,
        "" if row.published else ", republished (D-171)",
    )

    keep = {row.upload_key, row.upload_thumb_key, files.public_key, files.public_thumb_key}
    keep.update(k for s in files.subjects for k in (s.variant_key, s.variant_thumb_key))
    replaced = [row.public_key, row.public_thumb_key]
    replaced += [k for s in old_subjects for k in (s.variant_key, s.variant_thumb_key)]
    for old in replaced:
        if old is None or old in keep:
            continue
        try:
            ctx.storage.delete(old)
        except Exception:
            # The rows already point at the new files. The old one stays until media_delete.
            log.warning("%s could not delete the replaced %s", where, old, exc_info=True)


JOB = Job(name=NAME, message=Message, run=run)
