"""thumbnail_dims: publish a finished upload with its size, until S-21 replaces it (D-72).

No ML, and no object written: completion refused any photo without its client thumbnail, so
both upload keys already hold files (D-122). It acts only on a row no job has written, so a
message sent back from the archive never points another job's files back at the unblurred
upload (D-123).
"""

from __future__ import annotations

import logging
from typing import Literal

from app import images
from app.db import Tx
from app.jobs.base import Job, JobContext, MediaMessage

log = logging.getLogger("momentlens.worker.jobs")

NAME = "thumbnail_dims"


class Message(MediaMessage):
    job: Literal["thumbnail_dims"]


def run(ctx: JobContext, message: Message) -> None:
    where = ctx.where

    row = ctx.store.media_for_job(message.media_id)
    if row is None:
        log.info("%s the row is gone, so the message is done (arch §5)", where)
        return
    if row.variant_version != 0:
        log.info(
            "%s variant_version=%s, another job already wrote this row, so the message is done",
            where,
            row.variant_version,
        )
        return

    # The key comes from the row, which the API wrote. The worker never builds an upload key
    # (root invariant 12).
    width, height = images.dimensions(ctx.storage.read(row.upload_key))

    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.finish_thumbnail_dims(message.media_id, width, height)

    ctx.commit(write)
    if written:
        log.info("%s published at %sx%s, variant_version=1", where, width, height)
    else:
        log.info("%s the row changed or went before the update, so nothing was written", where)


JOB = Job(name=NAME, message=Message, run=run)
