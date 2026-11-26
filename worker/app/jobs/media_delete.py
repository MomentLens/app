"""media_delete: empty a deleted photo's R2 prefix and delete its rows (arch §5, D-130, D-177).

S-22's delete_media sets the row's deleted_at and sends this message in one transaction. The job
runs after any message for the photo already in the queue, so files an earlier job wrote go too.

- Row deleted: every object under `{media_id}/`, the upload keys included (arch §3), then the
  photo's face, dnp_subject and manual_blur_region rows with the message's delete. R2 goes first,
  so a try that fails between the two leaves only rows, and the retry lists an empty prefix and
  finishes them (D-123). The media row stays, with deleted_at and its hash (D-130).
- Row gone, after an event's hard delete: every object under the prefix, then the message is
  done. The cascade already took the rows (D-177).
- Row live, with no deleted_at: a bug or a hand-sent message. Nothing is deleted, and the loop
  archives it on its first try and reports it. processed_at is kept, so the photo stays in the
  album (D-177).

A second message for the same photo finds an empty prefix and no rows, and is done (D-160). An
upload whose PUT lands after this job leaves up to two objects nobody serves (D-177).
"""

from __future__ import annotations

import logging
from typing import Literal

from app.db import Tx
from app.jobs.base import ArchiveNow, Job, JobContext, MediaMessage
from app.storage import media_prefix

log = logging.getLogger("momentlens.worker.jobs")

NAME = "media_delete"


class Message(MediaMessage):
    job: Literal["media_delete"]


def run(ctx: JobContext, message: Message) -> None:
    where = ctx.where
    media_id = message.media_id

    row = ctx.store.media_for_job(media_id)
    if row is not None and not row.deleted:
        raise ArchiveNow(
            "not_deleted",
            "the photo has no deleted_at, so nothing was deleted. Only delete_media should send"
            " this job (D-177)",
        )

    prefix = media_prefix(media_id)
    keys = ctx.storage.list(prefix)
    # One DELETE per key. A failure stops here, and the retry lists what is left.
    for key in keys:
        ctx.storage.delete(key)

    if row is None:
        log.info(
            "%s the row is gone, so deleted %d object(s) under %s and the message is done (D-177)",
            where,
            len(keys),
            prefix,
        )
        return

    counts = (0, 0, 0)

    def write(tx: Tx) -> None:
        nonlocal counts
        counts = tx.delete_media_rows(media_id)

    ctx.commit(write)
    log.info(
        "%s deleted %d object(s) under %s, %d face, %d dnp_subject and %d manual_blur_region"
        " row(s)",
        where,
        len(keys),
        prefix,
        *counts,
    )


JOB = Job(name=NAME, message=Message, run=run)
