"""Which faces each of a photo's files blurs, and the one writer of those files (arch §5, D-57).

`plan` is the one function that decides which faces are blurred. face_process, blur_region and
reprocess all call it, so no job can blur a different set. `write` is the one place that
turns a plan into files, so every regeneration applies the same faces and every stored region
(root invariant 6).

- While arch §6 has no match threshold, every file blurs every face of the photo and nobody is a
  subject: the worker fails closed (D-104, D-172).
- With one, a face is a Do Not Publish face when it matches a reference of a subject whose
  membership in the photo's event has Do Not Publish on, whatever that membership's status
  (D-175). The public file blurs every such face. Each subject's own file blurs the same faces
  except the ones matched to that subject. N subjects give N+1 files and N+1 thumbnails, never 2^N
  (root invariant 11).
- A face matching a flagged reference at or above the threshold is blurred even when it matches an
  unflagged subject better. Blurring leans toward a match when uncertain (spec §4.11.4.5), so the
  caller passes flagged references only, never the whole event's.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

import numpy as np

from app import blur, storage
from app.ai import matching
from app.ai.matching import Reference
from app.db import BlurRegion, DnpSubject, MediaRow

log = logging.getLogger("momentlens.worker.jobs")


class Face(Protocol):
    """A detected or stored face: the detector's box as fractions, and its embedding."""

    x: float
    y: float
    width: float
    height: float
    embedding: np.ndarray


class Writer(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def delete(self, key: str) -> None: ...


@dataclass(frozen=True)
class Plan:
    # Indexes into the photo's faces, in their order.
    public: tuple[int, ...]
    # Each subject's own file: the faces it blurs. Ordered by subject_id, so a retry writes the
    # same keys in the same order.
    subjects: dict[UUID, tuple[int, ...]] = field(default_factory=dict)
    # Each face's Do Not Publish subject, the one it is blurred for, or None. The job stores it as
    # face.dnp_subject_id, and reprocess rebuilds a photo only where this differs (D-178).
    face_subjects: tuple[UUID | None, ...] = ()


@dataclass(frozen=True)
class Files:
    public_key: str
    public_thumb_key: str
    subjects: list[DnpSubject]


def plan(faces: Sequence[Face], flagged: Sequence[Reference], threshold: float | None) -> Plan:
    """Which faces the public file and each subject's file blur. `flagged` holds only the
    references of subjects with Do Not Publish on in the photo's event (Store.flagged_references).
    `threshold` is arch §6's match threshold, or None while it is not measured."""
    if threshold is None:
        # Every face blurred for nobody in particular, so no face has a subject (D-172).
        return Plan(public=tuple(range(len(faces))), face_subjects=(None,) * len(faces))
    hidden: list[int] = []
    own: dict[UUID, set[int]] = {}
    matches = matching.match([f.embedding for f in faces], flagged, threshold)
    for i, match in enumerate(matches):
        if match is not None:
            hidden.append(i)
            own.setdefault(match.subject_id, set()).add(i)
    return Plan(
        public=tuple(hidden),
        subjects={
            subject: tuple(i for i in hidden if i not in own[subject])
            for subject in sorted(own, key=str)
        },
        face_subjects=tuple(None if m is None else m.subject_id for m in matches),
    )


def write(
    writer: Writer,
    media_id: UUID,
    version: int,
    upload_key: str,
    upload_thumb_key: str,
    load: Callable[[], np.ndarray],
    faces: Sequence[Face],
    chosen: Plan,
    regions: Sequence[BlurRegion],
) -> Files:
    """Writes the photo's public file and every subject's file, each with its thumbnail, at
    `version`'s keys, and returns the keys for the row.

    With no face to blur and no region there is nothing to write: the public keys are the upload
    keys and there is no subject (arch §3, root invariant 13). `load` is called only otherwise, so
    that case reads nothing from R2. A lone subject's file is still written at its own key even
    when it blurs nothing, because a subject's row never points at an upload key
    (arch:dnp_subject). Thumbnails are cut from each blurred file (arch §5).

    Nothing here touches a key a row points at: `version` is one above the row's, and a retry
    rewrites the same keys, which no row points at yet (D-103).
    """
    if not chosen.public and not regions:
        return Files(upload_key, upload_thumb_key, [])

    image = load()

    def put(key: str, thumb_key: str, blurred: tuple[int, ...]) -> None:
        out = blur.apply(image, [faces[i] for i in blurred], regions)
        writer.put(key, blur.encode_full(out), "image/jpeg")
        writer.put(thumb_key, blur.thumbnail(out), "image/webp")

    public_key = storage.public_key(media_id, version)
    public_thumb_key = storage.public_thumb_key(media_id, version)
    put(public_key, public_thumb_key, chosen.public)

    subjects = []
    for subject_id, blurred in chosen.subjects.items():
        subject = DnpSubject(
            subject_id=subject_id,
            variant_key=storage.subject_key(media_id, subject_id, version),
            variant_thumb_key=storage.subject_thumb_key(media_id, subject_id, version),
        )
        put(subject.variant_key, subject.variant_thumb_key, blurred)
        subjects.append(subject)
    return Files(public_key, public_thumb_key, subjects)


def delete_replaced(
    writer: Writer, where: str, row: MediaRow, old_subjects: Sequence[DnpSubject], files: Files
) -> None:
    """After a regeneration commits, deletes the files the rows stopped pointing at: the row's
    old public keys and every old subject's keys. Never an upload key, and never a key the new
    rows point at (D-103). A failed delete is logged; the object stays until media_delete."""
    keep = {row.upload_key, row.upload_thumb_key, files.public_key, files.public_thumb_key}
    keep.update(k for s in files.subjects for k in (s.variant_key, s.variant_thumb_key))
    replaced = [row.public_key, row.public_thumb_key]
    replaced += [k for s in old_subjects for k in (s.variant_key, s.variant_thumb_key)]
    for old in replaced:
        if old is None or old in keep:
            continue
        try:
            writer.delete(old)
        except Exception:
            # The rows already point at the new files. The old one stays until media_delete.
            log.warning("%s could not delete the replaced %s", where, old, exc_info=True)
