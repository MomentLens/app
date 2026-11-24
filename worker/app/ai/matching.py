"""Every similarity comparison in the system: matching to references, and Unknown clusters (D-74).

Both thresholds mirror arch §6, and tests/test_matching.py reads arch §6 to keep them equal
(D-173). While a threshold is None the worker fails closed: nothing matches and nothing is
clustered, and S-21's face_process blurs every detected face (D-104, D-172). Never put an example
number here. The values come from `python -m bench.calibrate` on the team's photos, and arch §6
changes in the same commit. A test passes its own threshold, never these (D-104).

Matching in an event reads only the accepted references active members added to that event
(D-141). The caller picks those rows; these functions compare whatever they are given.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID, uuid4

import numpy as np

# arch §6, Match, used by face_process and reprocess: not measured.
MATCH_THRESHOLD: float | None = None
# arch §6, Unknown clustering, used by face_process: not measured.
CLUSTER_THRESHOLD: float | None = None


@dataclass(frozen=True)
class Reference:
    """One accepted face_reference: its subject and its embedding."""

    subject_id: UUID
    embedding: np.ndarray


@dataclass(frozen=True)
class Match:
    subject_id: UUID
    # Cosine similarity to that subject's closest reference.
    similarity: float


@dataclass(frozen=True)
class ClusterFace:
    """An unmatched face already in an Unknown cluster: its cluster_id and its embedding."""

    cluster_id: UUID
    embedding: np.ndarray


def match(
    faces: Sequence[np.ndarray], references: Sequence[Reference], threshold: float | None
) -> list[Match | None]:
    """For each face, the subject whose closest reference is most similar, when that similarity
    is at least `threshold`. None for every face while there is no threshold (D-104)."""
    if threshold is None or not references or not faces:
        return [None] * len(faces)
    similarity = _unit(faces) @ _unit([r.embedding for r in references]).T
    results: list[Match | None] = []
    for row in similarity:
        best = int(np.argmax(row))
        score = float(row[best])
        results.append(Match(references[best].subject_id, score) if score >= threshold else None)
    return results


def cluster(
    faces: Sequence[np.ndarray], existing: Sequence[ClusterFace], threshold: float | None
) -> list[UUID | None]:
    """A cluster_id for each unmatched face: the cluster of the most similar face already
    clustered, when that is at least `threshold`, otherwise a new one. Faces earlier in `faces`
    count as clustered for later ones. None for every face while there is no threshold (D-104,
    D-172)."""
    if threshold is None:
        return [None] * len(faces)
    members = list(existing)
    results: list[UUID | None] = []
    for face in faces:
        vector = _unit([face])[0]
        chosen: UUID | None = None
        if members:
            row = _unit([m.embedding for m in members]) @ vector
            best = int(np.argmax(row))
            if float(row[best]) >= threshold:
                chosen = members[best].cluster_id
        if chosen is None:
            chosen = uuid4()
        members.append(ClusterFace(chosen, vector))
        results.append(chosen)
    return results


def _unit(vectors: Sequence[np.ndarray]) -> np.ndarray:
    matrix = np.asarray(vectors, np.float32).reshape(len(vectors), -1)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
