"""Matching and Unknown clustering (D-74, D-104, D-141, D-172, D-173).

Every threshold here is this file's own (D-104). The worker's are None until arch §6 records a
measured value, and a test here reads arch §6 to keep the constants equal to it (D-173).
"""

import re
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest

from app.ai import faces, matching
from app.ai.matching import Reference

ARCHITECTURE = Path(__file__).resolve().parents[2] / "docs" / "ARCHITECTURE.md"

# A test's own thresholds, never the worker's (D-104).
MATCH_AT = 0.6
CLUSTER_AT = 0.6


def unit(*pairs):
    """A 512-float vector of length 1 with the given (index, value) entries."""
    v = np.zeros(512, np.float32)
    for i, value in pairs:
        v[i] = value
    return v / np.linalg.norm(v)


def arch_6_values() -> dict[str, str]:
    """The Value cell of each row in arch §6's table, keyed by its Threshold cell."""
    text = ARCHITECTURE.read_text(encoding="utf-8")
    heading = re.search(r"^## 6\. Similarity thresholds$", text, re.MULTILINE)
    assert heading, "arch §6 has no '## 6. Similarity thresholds' heading"
    section = text[heading.end() :]
    following = re.search(r"^## ", section, re.MULTILINE)
    section = section[: following.start()] if following else section
    rows = {}
    for line in section.splitlines():
        if not line.startswith("| ") or line.startswith("|---"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        rows[cells[0]] = cells[2]
    return rows


def arch_6_number(cell: str) -> float | None:
    """None for "not measured", otherwise the number the cell opens with."""
    if cell.startswith("not measured"):
        return None
    number = re.match(r"-?\d+(\.\d+)?", cell)
    assert number, f"arch §6 value {cell!r} is neither 'not measured' nor a number"
    return float(number.group())


def arch_6_value(row_starts_with: str) -> float | None:
    rows = arch_6_values()
    (cell,) = [value for name, value in rows.items() if name.startswith(row_starts_with)]
    return arch_6_number(cell)


def test_the_constants_equal_arch_6():
    assert arch_6_value("Match") == matching.MATCH_THRESHOLD
    assert arch_6_value("Unknown clustering") == matching.CLUSTER_THRESHOLD
    assert arch_6_value("Face detection score") == faces.DETECTION_SCORE


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("not measured", None),
        ("0.43", 0.43),
        ("0.5, SCRFD's default, with no minimum face size", 0.5),
    ],
)
def test_an_arch_6_cell_reads_as_none_or_its_number(cell, expected):
    assert arch_6_number(cell) == expected


def test_no_threshold_means_no_match_even_for_the_same_face():
    subject = uuid4()
    face = unit((0, 1))
    assert matching.match([face], [Reference(subject, face)], threshold=None) == [None]


def test_no_threshold_means_no_cluster():
    faces = [unit((0, 1)), unit((0, 1))]
    assert matching.cluster(faces, [], threshold=None) == [None, None]


def at_cosine(cosine: float) -> np.ndarray:
    """A unit vector at `cosine` to unit((0, 1))."""
    return unit((0, cosine), (1, float(np.sqrt(1 - cosine**2))))


def test_the_worker_match_threshold_fails_closed_or_holds_at_its_value():
    subject = uuid4()
    reference = [Reference(subject, unit((0, 1)))]
    threshold = matching.MATCH_THRESHOLD
    if threshold is None:
        # Even an identical face matches nobody (D-104).
        assert matching.match([unit((0, 1))], reference, threshold) == [None]
        return
    above, below = at_cosine(threshold + 0.001), at_cosine(threshold - 0.001)
    over, under = matching.match([above, below], reference, threshold)
    assert over is not None and over.subject_id == subject
    assert under is None


def test_the_worker_cluster_threshold_fails_closed_or_holds_at_its_value():
    cluster_id = uuid4()
    existing = [matching.ClusterFace(cluster_id, unit((0, 1)))]
    threshold = matching.CLUSTER_THRESHOLD
    if threshold is None:
        # Even an identical face gets no cluster (D-172).
        assert matching.cluster([unit((0, 1))], existing, threshold) == [None]
        return
    assert matching.cluster([at_cosine(threshold + 0.001)], existing, threshold) == [cluster_id]
    assert matching.cluster([at_cosine(threshold - 0.001)], existing, threshold) != [cluster_id]


def test_a_face_matches_the_subject_with_the_closest_reference():
    near, far = uuid4(), uuid4()
    face = unit((0, 1), (1, 0.2))
    refs = [
        Reference(far, unit((0, 1), (1, 1))),
        Reference(near, unit((0, 1), (1, 0.1))),
        Reference(near, unit((2, 1))),
    ]
    (result,) = matching.match([face], refs, threshold=MATCH_AT)
    assert result is not None
    assert result.subject_id == near
    assert result.similarity == pytest.approx(float(face @ refs[1].embedding), abs=1e-6)


def test_a_face_below_the_threshold_matches_nobody():
    face = unit((0, 1))
    refs = [Reference(uuid4(), unit((0, 1), (1, 2)))]  # cosine about 0.45
    assert matching.match([face], refs, threshold=MATCH_AT) == [None]


def test_no_references_means_no_match():
    assert matching.match([unit((0, 1))], [], threshold=MATCH_AT) == [None]


def test_no_faces_means_no_results():
    assert matching.match([], [Reference(uuid4(), unit((0, 1)))], threshold=MATCH_AT) == []
    assert matching.cluster([], [], threshold=CLUSTER_AT) == []


def test_an_unnormalised_embedding_compares_by_angle_only():
    subject = uuid4()
    (result,) = matching.match(
        [unit((0, 1)) * 7], [Reference(subject, unit((0, 1)) * 0.5)], threshold=MATCH_AT
    )
    assert result is not None and result.similarity == pytest.approx(1.0)


def test_a_face_joins_the_closest_existing_cluster_over_the_threshold():
    a, b = uuid4(), uuid4()
    existing = [
        matching.ClusterFace(a, unit((0, 1), (1, 0.1))),
        matching.ClusterFace(b, unit((0, 1), (1, 1))),
    ]
    assert matching.cluster([unit((0, 1))], existing, threshold=CLUSTER_AT) == [a]


def test_unlike_faces_get_new_clusters_and_like_ones_in_a_batch_share_one():
    existing = [matching.ClusterFace(uuid4(), unit((5, 1)))]
    first, second, third = matching.cluster(
        [unit((0, 1)), unit((0, 1), (1, 0.05)), unit((2, 1))], existing, threshold=CLUSTER_AT
    )
    assert first is not None and third is not None
    assert first == second
    assert third != first
    assert existing[0].cluster_id not in (first, third)
