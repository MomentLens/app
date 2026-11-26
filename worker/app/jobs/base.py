"""What every job is made of, and what the loop hands it."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict

if TYPE_CHECKING:
    from app.db import Store, Tx
    from app.storage import Storage


class JobMessage(BaseModel):
    """A message body. Fields a job does not declare are ignored."""

    model_config = ConfigDict(frozen=True)

    job: str


class MediaMessage(JobMessage):
    """A message about one photo. A final failure clears that photo's processed_at (D-108)."""

    media_id: UUID


class ReferenceMessage(JobMessage):
    """A message about one reference photo. A final failure rejects it as `failed` (D-172)."""

    face_reference_id: UUID


class ArchiveNow(Exception):
    """A message a retry cannot help, which the loop archives on its first try and reports. `kind`
    is the archive reason Sentry groups by."""

    def __init__(self, kind: str, reason: str) -> None:
        super().__init__(reason)
        self.kind = kind


@dataclass(frozen=True)
class Job:
    name: str
    message: type[JobMessage]
    run: Callable[[JobContext, Any], None]
    # Runs once at startup, after main.py has loaded the InsightFace model and before the loop
    # reads anything. A job that needs the model calls app.ai.model.get_model() (D-169).
    setup: Callable[[], None] | None = None
    # For a job whose message names no one photo: the photos its final failure takes out of the
    # album, in the archive's transaction. reprocess passes every photo it found to change and
    # has not rebuilt (D-108, D-178).
    unpublish_on_failure: Callable[[Store, Any], Sequence[UUID]] | None = None


@dataclass
class JobContext:
    store: Store
    storage: Storage
    msg_id: int
    # The loop's prefix for this message's log lines: job, msg_id, the row's id and try.
    where: str
    committed: bool = False

    def commit(self, write: Callable[[Tx], None], *, last: bool = True) -> None:
        """Runs `write` and deletes this job's message in one transaction (D-123).

        A job makes every row write through here. A job that returns without calling it has
        nothing to write, and the loop deletes its message as done. `last=False` commits `write`
        and keeps the message: reprocess commits each photo on its own and deletes the message
        with the last one (D-178).
        """
        with self.store.transaction() as tx:
            write(tx)
            if last:
                tx.delete_message(self.msg_id)
        if last:
            self.committed = True
