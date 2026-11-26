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

from app.ai.matching import ClusterFace, Reference
from app.ai.model import FaceModel
from app.db import (
    BlurRegion,
    DnpSubject,
    LockedMedia,
    MediaRow,
    NewFace,
    ReferenceRow,
    Store,
    StoredFace,
)
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
    # A photo's manual_blur_region rows, oldest first, as BlurRegion.
    regions: dict[UUID, list[BlurRegion]] = field(default_factory=dict)
    # face_reference rows by id: status, reject_reason, embedding (a list of floats or None),
    # photo_key, event_id and subject_id.
    references: dict[UUID, dict[str, Any]] = field(default_factory=dict)
    # A membership seen through its subject: event_id, subject_id, status and dnp (Do Not
    # Publish on in that event).
    members: list[dict[str, Any]] = field(default_factory=list)
    # A photo's face rows, as NewFace plus their id, in insert order.
    faces: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    # A photo's dnp_subject rows.
    subjects: dict[UUID, list[DnpSubject]] = field(default_factory=dict)


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

    def lock_media(self, media_id: UUID) -> LockedMedia | None:
        row = self._state.media.get(media_id)
        if row is None:
            return None
        return LockedMedia(
            published=row["processed_at"] is not None, deleted=row["deleted_at"] is not None
        )

    def delete_media_rows(self, media_id: UUID) -> tuple[int, int, int]:
        self._store.fault("delete_media_rows")
        state = self._state
        return (
            len(state.faces.pop(media_id, [])),
            len(state.subjects.pop(media_id, [])),
            len(state.regions.pop(media_id, [])),
        )

    def unpublish(self, media_id: UUID) -> None:
        self._state.media[media_id]["processed_at"] = None

    def finish_face_process(
        self,
        media_id: UUID,
        width: int,
        height: int,
        public_key: str,
        public_thumb_key: str,
        faces: list[NewFace],
        subjects: list[DnpSubject],
    ) -> bool:
        self._store.fault("finish_face_process")
        row = self._state.media.get(media_id)
        if row is None or row["variant_version"] != 0:
            return False
        row.update(
            width=width,
            height=height,
            public_key=public_key,
            public_thumb_key=public_thumb_key,
            variant_version=1,
            processed_at="now",
        )
        self._state.faces[media_id] = [
            {"id": uuid4(), **f.__dict__, "embedding": np.asarray(f.embedding, np.float32)}
            for f in faces
        ]
        self._state.subjects[media_id] = list(subjects)
        return True

    def finish_blur_region(
        self,
        media_id: UUID,
        read_version: int,
        public_key: str,
        public_thumb_key: str,
        subjects: list[DnpSubject],
    ) -> bool:
        self._store.fault("finish_blur_region")
        row = self._state.media.get(media_id)
        if row is None or row["variant_version"] != read_version or read_version == 0:
            return False
        row.update(
            public_key=public_key,
            public_thumb_key=public_thumb_key,
            variant_version=read_version + 1,
            processed_at=row["processed_at"] or "now",
        )
        self._state.subjects[media_id] = list(subjects)
        return True

    def lock_reference(self, reference_id: UUID) -> str | None:
        row = self._state.references.get(reference_id)
        return None if row is None else row["status"]

    def fail_reference(self, reference_id: UUID) -> None:
        row = self._state.references[reference_id]
        if row["status"] == "pending":
            row.update(status="rejected", reject_reason="failed")

    def decide_reference(
        self, reference_id: UUID, status: str, reject_reason: str | None, embedding: Any
    ) -> bool:
        self._store.fault("decide_reference")
        row = self._state.references.get(reference_id)
        if row is None or row["status"] != "pending":
            return False
        row.update(
            status=status,
            reject_reason=reject_reason,
            embedding=None if embedding is None else [float(v) for v in embedding],
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
            "event_id": uuid4(),
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

    def add_region(
        self, media_id: UUID, x: float, y: float, width: float, height: float
    ) -> BlurRegion:
        region = BlurRegion(x=x, y=y, width=width, height=height)
        self.state.regions.setdefault(media_id, []).append(region)
        return region

    def add_reference(self, reference_id: UUID | None = None, **overrides: Any) -> UUID:
        reference_id = reference_id or uuid4()
        event_id = overrides.pop("event_id", uuid4())
        self.state.references[reference_id] = {
            "event_id": event_id,
            "subject_id": uuid4(),
            "photo_key": f"users/{uuid4()}/events/{event_id}/reference_{reference_id}.jpg",
            "status": "pending",
            "reject_reason": None,
            "embedding": None,
        } | overrides
        return reference_id

    def add_member(
        self,
        event_id: UUID,
        embedding: Any,
        *,
        status: str = "active",
        dnp: bool = False,
        subject_id: UUID | None = None,
    ) -> UUID:
        """A member of the event with one accepted reference there. Returns their subject_id."""
        subject_id = subject_id or uuid4()
        self.state.members.append(
            {"event_id": event_id, "subject_id": subject_id, "status": status, "dnp": dnp}
        )
        self.add_reference(
            event_id=event_id,
            subject_id=subject_id,
            status="accepted",
            embedding=[float(v) for v in embedding],
        )
        return subject_id

    def add_face(
        self, media_id: UUID, x: float, y: float, width: float, height: float, embedding: Any
    ) -> None:
        """A stored face row, as face_process would have left it."""
        self.state.faces.setdefault(media_id, []).append(
            {
                "id": uuid4(),
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "embedding": np.asarray(embedding, np.float32),
                "matched_subject_id": None,
                "similarity": None,
                "cluster_id": None,
            }
        )

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
            # In place, so stores built with the same `shared` keep seeing one State.
            self.state.__dict__.update(before.__dict__)
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
            id=media_id,
            event_id=row["event_id"],
            upload_key=row["upload_key"],
            upload_thumb_key=row["upload_thumb_key"],
            public_key=row["public_key"],
            public_thumb_key=row["public_thumb_key"],
            variant_version=row["variant_version"],
            published=row["processed_at"] is not None,
            deleted=row["deleted_at"] is not None,
        )

    def reference_for_job(self, reference_id: UUID) -> ReferenceRow | None:
        self.fault("reference_for_job")
        row = self.state.references.get(reference_id)
        if row is None:
            return None
        return ReferenceRow(
            id=reference_id,
            event_id=row["event_id"],
            photo_key=row["photo_key"],
            status=row["status"],
        )

    def blur_regions(self, media_id: UUID) -> list[BlurRegion]:
        self.fault("blur_regions")
        return list(self.state.regions.get(media_id, []))

    def faces(self, media_id: UUID) -> list[StoredFace]:
        self.fault("faces")
        return [
            StoredFace(
                id=f["id"],
                x=f["x"],
                y=f["y"],
                width=f["width"],
                height=f["height"],
                embedding=f["embedding"],
            )
            for f in self.state.faces.get(media_id, [])
        ]

    def dnp_subjects(self, media_id: UUID) -> list[DnpSubject]:
        return list(self.state.subjects.get(media_id, []))

    def clustered_faces(self, event_id: UUID) -> list[ClusterFace]:
        return [
            ClusterFace(f["cluster_id"], f["embedding"])
            for media_id, faces in self.state.faces.items()
            if self.state.media.get(media_id, {}).get("event_id") == event_id
            for f in faces
            if f["cluster_id"] is not None
        ]

    def active_references(self, event_id: UUID) -> list[Reference]:
        return self._references(event_id, lambda m: m["status"] == "active")

    def flagged_references(self, event_id: UUID) -> list[Reference]:
        return self._references(event_id, lambda m: m["dnp"])

    def _references(self, event_id: UUID, keep: Any) -> list[Reference]:
        chosen = {
            m["subject_id"] for m in self.state.members if m["event_id"] == event_id and keep(m)
        }
        return [
            Reference(r["subject_id"], np.asarray(r["embedding"], np.float32))
            for r in self.state.references.values()
            if r["event_id"] == event_id and r["status"] == "accepted" and r["subject_id"] in chosen
        ]


class FakeStorage:
    """R2. An object is bytes, or a list of bytes handed out one per read, the last repeating."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes | list[bytes]] = {}
        self.reads: list[str] = []
        # Every PUT as (key, content type), and every DELETE by key, in order, failed ones included.
        self.puts: list[tuple[str, str]] = []
        self.deletes: list[str] = []
        # Every prefix listed, in order.
        self.lists: list[str] = []
        # Errors the next PUTs or DELETEs raise, in order.
        self.put_faults: list[Exception] = []
        self.delete_faults: list[Exception] = []
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

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.puts.append((key, content_type))
        if self.put_faults:
            raise self.put_faults.pop(0)
        self.objects[key] = data

    def delete(self, key: str) -> None:
        self.deletes.append(key)
        if self.delete_faults:
            raise self.delete_faults.pop(0)
        self.objects.pop(key, None)

    def list(self, prefix: str) -> list[str]:
        self.lists.append(prefix)
        return sorted(k for k in self.objects if k.startswith(prefix))

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


def noise_jpeg(width: int, height: int, seed: int = 7) -> bytes:
    """A JPEG of random pixels, so any blur shows as a large change."""
    image = np.random.default_rng(seed).integers(0, 256, (height, width, 3), dtype=np.uint8)
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert ok
    return buffer.tobytes()


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


class FakeDetector:
    """SCRFD's detect(): rows of x1, y1, x2, y2, score in pixels, and five landmarks per face."""

    def __init__(self, boxes):
        self.boxes = np.array(boxes, np.float32).reshape(-1, 5)
        self.calls = 0

    def detect(self, img, max_num=0, metric="default"):
        self.calls += 1
        kpss = []
        for x1, y1, x2, y2, _ in self.boxes:
            cx, cy, w = (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1
            kpss.append(
                [
                    [cx - w / 5, cy - w / 6],
                    [cx + w / 5, cy - w / 6],
                    [cx, cy],
                    [cx - w / 6, cy + w / 5],
                    [cx + w / 6, cy + w / 5],
                ]
            )
        return self.boxes, np.array(kpss, np.float32).reshape(-1, 5, 2)


class FakeRecognizer:
    """ArcFace's get_feat(): one 512-float row per aligned crop, never of length 1."""

    input_size = (112, 112)

    def __init__(self):
        self.crops = []

    def get_feat(self, imgs):
        self.crops.extend(imgs)
        rows = np.zeros((len(imgs), 512), np.float32)
        for i in range(len(imgs)):
            rows[i, i] = 3.0
            rows[i, 511] = 4.0
        return rows


def face_model(boxes: Any) -> FaceModel:
    """buffalo_l stand-in whose detector finds `boxes`: rows of x1, y1, x2, y2, score."""
    return FaceModel(detector=FakeDetector(boxes), recognizer=FakeRecognizer())
