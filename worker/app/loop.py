"""The consumer loop: one message at a time from `jobs`, oldest first, under the queue lock.

The rules are arch §5's, from D-103, D-108 and D-123:

- One reader. The worker holds a Postgres advisory lock while it reads, and a second worker
  logs that the queue is taken and waits.
- A try is a read, counted by pgmq's read_ct, so a crash counts as one. After a failed try the
  message goes back to the head of the line, and the worker waits and reads it again before any
  newer one. Taking the lock unhides every message a stopped worker left hidden.
- The third failure archives the message and clears its photo's processed_at in one
  transaction, then logs it and reports it to Sentry. A missing upload object, a message that
  does not parse and an unknown job are archived on their first try.
- A message whose photo row is gone is deleted as done, with no archive and no report.
- A lost connection to Postgres or R2 is waited out here, never by exiting, because every exit
  costs the unit's 10-second RestartSec and a fresh start. R2 refusing the worker's key or
  bucket is waited out the same way.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import sentry_sdk
from pydantic import ValidationError

from app.db import Archive, DatabaseUnavailable, Store
from app.images import DecodeError
from app.jobs.base import Job, JobContext, JobMessage
from app.queue import Message
from app.storage import ObjectMissing, Storage, StorageUnavailable

log = logging.getLogger("momentlens.worker.loop")

MAX_TRIES = 3
VISIBILITY_TIMEOUT_S = 120
POLL_INTERVAL_S = 1.0
RETRY_WAIT_S = 5.0
LOCK_WAIT_S = 10.0

# Errors that say what went wrong in their message, so their traceback adds nothing to the log.
_EXPECTED = (DecodeError, StorageUnavailable)


def report_archive(
    *,
    kind: str,
    job: str | None,
    msg_id: int,
    media_id: UUID | None,
    read_ct: int,
    reason: str,
    error: BaseException | None = None,
) -> None:
    """Sends one archived message to Sentry, the only thing the worker reports (D-123).

    A no-op while Sentry is off. The event carries ids and the reason, never a photo or a person.
    """
    with sentry_sdk.new_scope() as scope:
        scope.set_tag("job", job or "unknown")
        scope.set_tag("archive_reason", kind)
        scope.set_context(
            "message",
            {"msg_id": msg_id, "media_id": str(media_id) if media_id else None, "read_ct": read_ct},
        )
        scope.fingerprint = ["worker-archive", job or "unknown", kind]
        if error is not None and not isinstance(error, _EXPECTED):
            sentry_sdk.capture_exception(error)
        else:
            sentry_sdk.capture_message(
                f"Archived a {job or 'malformed'} message: {reason}", "error"
            )


@dataclass
class Worker:
    store: Store
    storage: Storage
    jobs: Mapping[str, Job]
    stop: threading.Event
    report: Callable[..., None] = report_archive
    retry_wait_s: float = RETRY_WAIT_S
    poll_interval_s: float = POLL_INTERVAL_S
    lock_wait_s: float = LOCK_WAIT_S
    # First wait and longest wait, doubling between.
    reconnect_wait_s: tuple[float, float] = (1.0, 60.0)
    storage_wait_s: tuple[float, float] = (5.0, 60.0)
    _reconnect_wait: float = field(init=False)
    _waiting_for_lock: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        self._reconnect_wait = self.reconnect_wait_s[0]

    def run(self) -> None:
        """Runs until `stop` is set. A job in progress finishes first."""
        while not self.stop.is_set():
            self.step()

    def step(self) -> bool:
        """One pass: take the queue if needed, then read and handle one message.

        True when a message was handled. An error that is not about a connection propagates,
        and main exits so systemd restarts the worker.
        """
        try:
            if not self.store.locked and not self._take_queue():
                return False
            message = self.store.read(VISIBILITY_TIMEOUT_S)
            self._reconnect_wait = self.reconnect_wait_s[0]
            if message is None:
                self.stop.wait(self.poll_interval_s)
                return False
            self._handle(message)
            return True
        except DatabaseUnavailable as error:
            log.warning(
                "lost the database connection (%s), connecting again in %.0fs",
                error,
                self._reconnect_wait,
            )
            self.store.close()
            self.stop.wait(self._reconnect_wait)
            self._reconnect_wait = min(self._reconnect_wait * 2, self.reconnect_wait_s[1])
            return False

    # --- taking the queue -------------------------------------------------------------------

    def _take_queue(self) -> bool:
        self.store.connect()
        if not self.store.try_lock():
            if not self._waiting_for_lock:
                log.warning(
                    "the %s queue is taken: another worker holds its lock. Waiting until that"
                    " worker stops (hb §13.4)",
                    self.store.queue,
                )
                self._waiting_for_lock = True
            self.stop.wait(self.lock_wait_s)
            return False
        self._waiting_for_lock = False
        unhidden = self.store.unhide()
        log.info("took the %s queue lock", self.store.queue)
        if unhidden:
            log.warning(
                "made %d message(s) a stopped worker left hidden readable again, each read"
                " counted as a try: msg_ids=%s",
                len(unhidden),
                unhidden,
            )
        return True

    # --- one message ------------------------------------------------------------------------

    def _handle(self, message: Message) -> None:
        parsed = self._parse(message)
        if parsed is None:
            return
        job, body = parsed
        media_id: UUID | None = getattr(body, "media_id", None)
        where = _where(job.name, message, media_id)

        if message.read_ct > MAX_TRIES:
            self._final(
                message,
                job.name,
                media_id,
                kind="stopped",
                known=True,
                reason=f"{message.read_ct - 1} earlier reads never finished, so the worker"
                " stopped during each try",
            )
            return

        ctx = JobContext(self.store, self.storage, message.msg_id)
        started = time.monotonic()
        try:
            job.run(ctx, body)
            if not ctx.committed:
                self.store.delete(message.msg_id)
        except DatabaseUnavailable:
            raise
        except ObjectMissing as error:
            self._final(
                message, job.name, media_id, kind="missing_object", known=True, reason=str(error)
            )
        except StorageUnavailable as error:
            self._failed_try(message, job.name, media_id, error)
            self._wait_for_storage()
        except Exception as error:
            self._failed_try(message, job.name, media_id, error)
        else:
            log.info("%s done in %dms", where, (time.monotonic() - started) * 1000)

    def _parse(self, message: Message) -> tuple[Job, JobMessage] | None:
        body = message.body
        name = body.get("job") if isinstance(body, dict) else None
        if not isinstance(name, str):
            self._final(
                message,
                None,
                _media_id_in(body),
                kind="malformed",
                known=False,
                reason="the message has no job name",
            )
            return None
        job = self.jobs.get(name)
        if job is None:
            self._final(
                message,
                name,
                _media_id_in(body),
                kind="unknown_job",
                known=False,
                reason=f"this worker has no job named {name!r}",
            )
            return None
        try:
            return job, job.message.model_validate(body)
        except ValidationError as error:
            self._final(
                message,
                name,
                _media_id_in(body),
                kind="malformed",
                known=False,
                reason=f"the message does not parse: {_summary(error)}",
            )
            return None

    def _failed_try(
        self, message: Message, job: str, media_id: UUID | None, error: Exception
    ) -> None:
        trace = None if isinstance(error, _EXPECTED) else error
        if message.read_ct >= MAX_TRIES:
            self._final(
                message,
                job,
                media_id,
                kind="failed",
                known=True,
                reason=f"failed {MAX_TRIES} tries, the last with {type(error).__name__}: {error}",
                error=error,
            )
            return
        log.warning(
            "%s failed with %s: %s. Reading it again in %.0fs, before any newer message",
            _where(job, message, media_id),
            type(error).__name__,
            error,
            self.retry_wait_s,
            exc_info=trace,
        )
        self.store.retry_later(message.msg_id)
        self.stop.wait(self.retry_wait_s)

    def _final(
        self,
        message: Message,
        job: str | None,
        media_id: UUID | None,
        *,
        kind: str,
        known: bool,
        reason: str,
        error: Exception | None = None,
    ) -> None:
        """Archives the message, or deletes it as done when its known job's row is gone."""
        where = _where(job, message, media_id)
        result = self.store.archive(message.msg_id, media_id, gone_is_done=known)
        if result is Archive.GONE:
            log.info("%s the row is gone, so the message is done (arch §5)", where)
            return
        unpublished = (
            " Cleared processed_at, so the photo left the album (D-108)."
            if result is Archive.UNPUBLISHED
            else ""
        )
        log.error(
            "%s archived, %s: %s.%s Send it from pgmq.a_%s back to %s to run it again (arch §5)",
            where,
            kind,
            reason,
            unpublished,
            self.store.queue,
            self.store.queue,
            exc_info=None if error is None or isinstance(error, _EXPECTED) else error,
        )
        self.report(
            kind=kind,
            job=job,
            msg_id=message.msg_id,
            media_id=media_id,
            read_ct=message.read_ct,
            reason=reason,
            error=error,
        )

    def _wait_for_storage(self) -> None:
        """Holds the next read until R2 answers, so an outage costs one try, not three."""
        wait = self.storage_wait_s[0]
        failed = False
        while not self.stop.is_set():
            if self.storage.reachable():
                if failed:
                    log.info("R2 answers again")
                return
            failed = True
            log.warning(
                "R2 does not answer or refuses the worker's R2_* settings, checking again in"
                " %.0fs before the next read",
                wait,
            )
            self.stop.wait(wait)
            wait = min(wait * 2, self.storage_wait_s[1])


def _where(job: str | None, message: Message, media_id: UUID | None) -> str:
    return f"job={job or '?'} msg_id={message.msg_id} media_id={media_id} try={message.read_ct}"


def _media_id_in(body: Any) -> UUID | None:
    """The photo a message names, when it names one, even if the rest does not parse."""
    if not isinstance(body, dict):
        return None
    try:
        return UUID(str(body.get("media_id")))
    except ValueError:
        return None


def _summary(error: ValidationError) -> str:
    # Field names and pydantic's messages, never the values, which could be anything.
    return "; ".join(
        f"{'.'.join(str(part) for part in item['loc']) or 'message'}: {item['msg']}"
        for item in error.errors()
    )
