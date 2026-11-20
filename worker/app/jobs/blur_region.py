"""blur_region: rebuild a photo's public file and thumbnail with every stored region (D-83).

A manual_blur_region row added or deleted sends this message (arch:manual_blur_region). No ML.
The job reads the photo's regions as they are now, so two quick draws run twice and the second
run carries both.

- With regions, it blurs the upload, writes the public file and thumbnail at the next version's
  keys, then points the row at them. A retry before the commit rewrites the same keys, which no
  row points at yet (D-103).
- With none left, it points the public keys back at the upload keys and writes no object (arch §3,
  root invariant 13).
- Either way the update bumps variant_version (root invariant 2) and sets processed_at when it is
  null, so a message re-sent from the archive republishes the photo (D-171).
- After the commit it deletes the files the row stopped pointing at, never an upload key.

Before S-21 no photo has a Do Not Publish file, so N is 0 and this writes 1 file and 1 thumbnail
(root invariant 11). S-21 adds the subjects' files, and the no-region case then also needs no
subject file before it points back at the upload.
"""

from __future__ import annotations

import logging
from typing import Literal

from app import blur, images, storage
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
    if row.variant_version == 0:
        # No job has written the row, so it has no public files to rebuild and add_blur_region
        # refuses it as unprocessed.
        log.info(
            "%s variant_version=0, nothing published to rebuild, so the message is done", where
        )
        return

    regions = ctx.store.blur_regions(media_id)
    version = row.variant_version + 1
    if regions:
        # The upload key comes from the row, which the API wrote (root invariant 12).
        blurred = blur.apply_regions(images.decode(ctx.storage.read(row.upload_key)), regions)
        full_key = storage.public_key(media_id, version)
        thumb_key = storage.public_thumb_key(media_id, version)
        ctx.storage.put(full_key, blur.encode_full(blurred), "image/jpeg")
        ctx.storage.put(thumb_key, blur.thumbnail(blurred), "image/webp")
    else:
        full_key, thumb_key = row.upload_key, row.upload_thumb_key

    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.finish_blur_region(media_id, row.variant_version, full_key, thumb_key)

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
        "%s %s with %d region(s) at variant_version=%s%s",
        where,
        "blurred" if regions else "pointed back at the upload",
        len(regions),
        version,
        "" if row.published else ", republished (D-171)",
    )

    keep = {row.upload_key, row.upload_thumb_key, full_key, thumb_key}
    for old in (row.public_key, row.public_thumb_key):
        if old is None or old in keep:
            continue
        try:
            ctx.storage.delete(old)
        except Exception:
            # The row already points at the new files. The old one stays until media_delete.
            log.warning("%s could not delete the replaced %s", where, old, exc_info=True)


JOB = Job(name=NAME, message=Message, run=run)
