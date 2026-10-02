"""In-memory stand-ins for Postgres with pgmq, and for R2.

FakeStore keeps pgmq's semantics the loop depends on: a read takes the oldest visible message,
counts it in read_ct and hides it; make_visible puts it back; unhide reveals what a stopped
worker hid. tests/test_dev_sql.py checks the real queue does the same. Store.archive is the real
method, run over FakeTx, so the tests here exercise its transaction boundary.
"""

from __future__ import annotations

import copy
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import numpy as np

from app.db import MediaRow, Store
from app.images import cv2
from app.queue import Message
from app.storage import ObjectMissing


class Crash(BaseException):
    """The process dying mid-job. BaseException, so no handler in the loop catches it."""


@dataclass
class FakeMessage:
    msg_id: int
    body: Any
    read_ct: int = 0
    hidden: bool = False


@dataclass
class State:
    messages: dict[int, FakeMessage] = field(default_factory=dict)
    archived: dict[int, FakeMessage] = field(default_factory=dict)
    media: dict[UUID, dict[str, Any]] = field(default_factory=dict)


class FakeTx:
    def __init__(self, store: FakeStore) -> None:
        self._store = store

    @property
    def _state(self) -> State:
        return self._store.state

    def delete_message(self, msg_id: int) -> None:
        self._store.fault("delete_message")
        self._state.messages.pop(msg_id, None)

    def archive_message(self, msg_id: int) -> None:
        self._store.fault("archive_message")
        message = self._state.messages.pop(msg_id, None)
        if message is not None:
            self._state.archived[msg_id] = message

    def lock_media(self, media_id: UUID) -> bool | None:
        row = self._state.media.get(media_id)
        return None if row is None else row["processed_at"] is not None

    def unpublish(self, media_id: UUID) -> None:
        self._state.media[media_id]["processed_at"] = None

    def finish_thumbnail_dims(self, media_id: UUID, width: int, height: int) -> bool:
        self._store.fault("finish_thumbnail_dims")
        row = self._state.media.get(media_id)
        if row is None or row["variant_version"] != 0:
            return False
        row.update(
            width=width,
            height=height,
            public_key=row["upload_key"],
            public_thumb_key=row["upload_thumb_key"],
            variant_version=row["variant_version"] + 1,
            processed_at="now",
        )
        return True


class FakeStore:
    """One worker's session. Stores built with the same `shared` see one database and lock."""

    def __init__(self, shared: FakeStore | None = None, queue_name: str = "jobs") -> None:
        self.state: State = shared.state if shared else State()
        self._locks: set[str] = shared._locks if shared else set()
        self._next_id: list[int] = shared._next_id if shared else [1]
        self.queue = queue_name
        self.locked = False
        self.connected = False
        self.connects = 0
        # Method name to the errors its next calls raise, in order.
        self.faults: dict[str, list[BaseException]] = {}

    archive = Store.archive

    def fault(self, name: str) -> None:
        pending = self.faults.get(name)
        if pending:
            raise pending.pop(0)

    # --- test setup -------------------------------------------------------------------------

    def send(self, body: Any, *, read_ct: int = 0, hidden: bool = False) -> int:
        msg_id = self._next_id[0]
        self._next_id[0] += 1
        self.state.messages[msg_id] = FakeMessage(msg_id, body, read_ct, hidden)
        return msg_id

    def add_media(self, media_id: UUID | None = None, **overrides: Any) -> UUID:
        media_id = media_id or uuid4()
        self.state.media[media_id] = {
            "upload_key": f"{media_id}/upload.jpg",
            "upload_thumb_key": f"{media_id}/upload_thumb.webp",
            "public_key": None,
            "public_thumb_key": None,
            "variant_version": 0,
            "width": None,
            "height": None,
            "processed_at": None,
            "deleted_at": None,
        } | overrides
        return media_id

    # --- the Store interface ----------------------------------------------------------------

    def connect(self) -> None:
        self.fault("connect")
        if not self.connected:
            self.connected = True
            self.connects += 1

    def close(self) -> None:
        if self.locked:
            self._locks.discard(self.queue)
        self.connected = False
        self.locked = False

    def try_lock(self) -> bool:
        self.fault("try_lock")
        if self.queue in self._locks and not self.locked:
            return False
        self._locks.add(self.queue)
        self.locked = True
        return True

    @contextmanager
    def transaction(self) -> Iterator[FakeTx]:
        self.fault("transaction")
        before = copy.deepcopy(self.state)
        try:
            yield FakeTx(self)
        except BaseException:
            self.state.messages, self.state.archived, self.state.media = (
                before.messages,
                before.archived,
                before.media,
            )
            raise

    def read(self, visibility_timeout_s: int) -> Message | None:
        self.fault("read")
        visible = [m for m in self.state.messages.values() if not m.hidden]
        if not visible:
            return None
        message = min(visible, key=lambda m: m.msg_id)
        message.read_ct += 1
        message.hidden = True
        return Message(message.msg_id, message.read_ct, copy.deepcopy(message.body))

    def delete(self, msg_id: int) -> None:
        self.fault("delete")
        self.state.messages.pop(msg_id, None)

    def retry_later(self, msg_id: int) -> None:
        self.fault("retry_later")
        self.state.messages[msg_id].hidden = False

    def unhide(self) -> list[int]:
        unhidden = []
        for message in self.state.messages.values():
            if message.hidden and message.read_ct > 0:
                message.hidden = False
                unhidden.append(message.msg_id)
        return sorted(unhidden)

    def media_for_job(self, media_id: UUID) -> MediaRow | None:
        self.fault("media_for_job")
        row = self.state.media.get(media_id)
        if row is None:
            return None
        return MediaRow(
            id=media_id, upload_key=row["upload_key"], variant_version=row["variant_version"]
        )


class FakeStorage:
    """R2. An object is bytes, or a list of bytes handed out one per read, the last repeating."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes | list[bytes]] = {}
        self.reads: list[str] = []
        # Errors the next reads raise, in order, before any object is looked up.
        self.read_faults: list[Exception] = []
        # What the next probes answer, in order. True once the list runs out.
        self.probe_answers: list[bool] = []
        self.probes = 0

    def read(self, key: str) -> bytes:
        self.reads.append(key)
        if self.read_faults:
            raise self.read_faults.pop(0)
        value = self.objects.get(key)
        if value is None:
            raise ObjectMissing(f"no object at {key}")
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        return value

    def reachable(self) -> bool:
        self.probes += 1
        return self.probe_answers.pop(0) if self.probe_answers else True


class Reports:
    """Stands in for Sentry. Each call is one archived message reported."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


def jpeg(width: int, height: int, *, orientation: int | None = None) -> bytes:
    """A JPEG of the given stored size, optionally carrying an EXIF orientation tag."""
    image = np.zeros((height, width, 3), np.uint8)
    image[:, : width // 2] = 255
    ok, buffer = cv2.imencode(".jpg", image)
    assert ok
    data = buffer.tobytes()
    if orientation is None:
        return data
    # One IFD entry, tag 0x0112 (Orientation), type SHORT, count 1, big-endian TIFF.
    ifd = (
        (1).to_bytes(2, "big")
        + (0x0112).to_bytes(2, "big")
        + (3).to_bytes(2, "big")
        + (1).to_bytes(4, "big")
        + orientation.to_bytes(2, "big")
        + b"\x00\x00"
        + (0).to_bytes(4, "big")
    )
    payload = b"Exif\x00\x00" + b"MM\x00\x2a" + (8).to_bytes(4, "big") + ifd
    app1 = b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    return data[:2] + app1 + data[2:]


def make_worker(
    store: FakeStore | None = None,
    storage: FakeStorage | None = None,
    jobs: Any = None,
    stop: Any = None,
) -> Any:
    """A Worker over fakes, with every wait at zero. Its reports are on `worker.report`."""
    import threading

    from app.jobs import REGISTRY
    from app.loop import Worker

    return Worker(
        store or FakeStore(),
        storage or FakeStorage(),
        REGISTRY if jobs is None else jobs,
        stop or threading.Event(),
        report=Reports(),
        retry_wait_s=0,
        poll_interval_s=0,
        lock_wait_s=0,
        reconnect_wait_s=(0, 0),
        storage_wait_s=(0, 0),
    )


def drain(worker: Any, limit: int = 50) -> None:
    """Steps until no message is left to read."""
    for _ in range(limit):
        handled = worker.step()
        visible = [m for m in worker.store.state.messages.values() if not m.hidden]
        if not handled and not visible:
            return
    raise AssertionError(f"the queue did not drain in {limit} steps")
