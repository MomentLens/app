"""Matching and Unknown clustering (D-74, D-104, D-141, D-172).

Every threshold here is this file's own (D-104). The worker's are None until arch §6 records a
measured value.
"""

from uuid import uuid4

import numpy as np
import pytest

from app.ai import matching
from app.ai.matching import Reference

# A test's own thresholds, never the worker's (D-104).
MATCH_AT = 0.6
CLUSTER_AT = 0.6


def unit(*pairs):
    """A 512-float vector of length 1 with the given (index, value) entries."""
    v = np.zeros(512, np.float32)
    for i, value in pairs:
        v[i] = value
    return v / np.linalg.norm(v)


def test_the_worker_has_no_threshold_until_arch_6_records_one():
    assert matching.MATCH_THRESHOLD is None
    assert matching.CLUSTER_THRESHOLD is None


def test_no_threshold_means_no_match_even_for_the_same_face():
    subject = uuid4()
    face = unit((0, 1))
    assert matching.match([face], [Reference(subject, face)], threshold=None) == [None]


def test_no_threshold_means_no_cluster():
    faces = [unit((0, 1)), unit((0, 1))]
    assert matching.cluster(faces, [], threshold=None) == [None, None]


def test_the_worker_defaults_match_nothing():
    face = unit((0, 1))
    assert matching.match([face], [Reference(uuid4(), face)], matching.MATCH_THRESHOLD) == [None]
    assert matching.cluster([face], [], matching.CLUSTER_THRESHOLD) == [None]


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
