"""What every job is made of, and what the loop hands it."""

from __future__ import annotations

from collections.abc import Callable
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


@dataclass(frozen=True)
class Job:
    name: str
    message: type[JobMessage]
    run: Callable[[JobContext, Any], None]
    # Runs once at startup, before the loop reads anything. S-18 loads the InsightFace model
    # here, once, and keeps it resident (worker/AGENTS.md).
    setup: Callable[[], None] | None = None


@dataclass
class JobContext:
    store: Store
    storage: Storage
    msg_id: int
    # The loop's prefix for this message's log lines: job, msg_id, media_id and try.
    where: str
    committed: bool = False

    def commit(self, write: Callable[[Tx], None]) -> None:
        """Runs `write` and deletes this job's message in one transaction (D-123).

        A job makes every row write through here. A job that returns without calling it has
        nothing to write, and the loop deletes its message as done.
        """
        with self.store.transaction() as tx:
            write(tx)
            tx.delete_message(self.msg_id)
        self.committed = True
