"""reference_process: accept a reference photo that shows exactly one face (D-91, D-141, D-172).

The API inserts the face_reference row as `pending` and sends this message in one transaction
(arch:face_reference). The job counts the faces the detector finds at arch §6's score:

- one: `accepted`, with that face's embedding, which matching in the reference's event reads
- none: `rejected`, `no_face`
- several: `rejected`, `multiple_faces`, and the app shows spec §4.2's message

The decision commits with the message's delete. A row the API deleted, or one already decided,
means the message is done. A final failure sets the row `rejected` with `failed` in the archive's
transaction, so the app stops polling (app/db.py, Store.archive).

From S-25 an accepted reference then enqueues `reprocess` for its subject in its event. S-20
enqueues nothing, because the worker would archive a job it does not have (D-172).
"""

from __future__ import annotations

import logging
from typing import Literal

from app import images
from app.ai import faces
from app.db import Tx
from app.jobs.base import Job, JobContext, ReferenceMessage

log = logging.getLogger("momentlens.worker.jobs")

NAME = "reference_process"


class Message(ReferenceMessage):
    job: Literal["reference_process"]


def run(ctx: JobContext, message: Message) -> None:
    where = ctx.where
    row = ctx.store.reference_for_job(message.face_reference_id)
    if row is None:
        log.info("%s the reference is gone, so the message is done (D-172)", where)
        return
    if row.status != "pending":
        # Decided already; a message re-sent from the archive never overwrites the decision.
        log.info("%s the reference is already %s, so the message is done", where, row.status)
        return

    # The key comes from the row, which the API wrote (root invariant 12). Read as stored: Stage 1
    # already applied the orientation (D-99, D-172).
    found = faces.detect(images.decode(ctx.storage.read(row.photo_key)))
    if len(found) == 1:
        status, reason, embedding = "accepted", None, found[0].embedding
    else:
        status, reason, embedding = "rejected", "no_face" if not found else "multiple_faces", None

    written = False

    def write(tx: Tx) -> None:
        nonlocal written
        written = tx.decide_reference(row.id, status, reason, embedding)

    ctx.commit(write)
    if not written:
        log.info("%s the reference was deleted or decided before the update", where)
        return
    log.info(
        "%s %s with %d face(s) at score >= %s, event_id=%s",
        where,
        status if reason is None else f"{status} as {reason}",
        len(found),
        faces.DETECTION_SCORE,
        row.event_id,
    )


JOB = Job(name=NAME, message=Message, run=run)
