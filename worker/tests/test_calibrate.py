"""The S-26 calibration script's own logic, on made-up embeddings (D-173).

The real run needs the team's photos, which stay off the repo. These tests cover what decides the
numbers: the two-decimal picks, the zero-miss rule at 1 reference, and whose face is whose.
"""

from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest

from app.ai import matching
from app.ai.faces import DetectedFace
from bench import calibrate
from bench.calibrate import CalibrationError, LabelledFace, TeamPhoto

REPO = Path(__file__).resolve().parents[2]


def vector(cosine_to_axis_0: float, other_axis: int = 1) -> np.ndarray:
    """A unit vector whose cosine similarity to axis 0 is `cosine_to_axis_0`."""
    v = np.zeros(512, np.float64)
    v[0] = cosine_to_axis_0
    v[other_axis] = np.sqrt(max(0.0, 1.0 - cosine_to_axis_0**2))
    return (v / np.linalg.norm(v)).astype(np.float32)


def face(x: float, width: float, score: float = 0.9, embedding=None) -> DetectedFace:
    return DetectedFace(
        x, 0.1, width, width, score, embedding if embedding is not None else vector(1.0)
    )


def labelled(person, kind, emb, score=0.9, photo=None):
    return LabelledFace(person, photo or f"{person}/{kind}_1.jpg", kind, face(0.1, 0.2, score, emb))


# The two-decimal picks


def test_a_float32_score_stored_under_its_hundredth_picks_the_hundredth_below():
    # float32 stores 0.47 as 0.46999999, and match() compares in float32, so 0.47 would miss it.
    assert calibrate.pick_match_threshold([np.float32(0.47)]) == 0.46


@pytest.mark.parametrize(
    ("genuine", "expected"),
    [
        ([0.43, 0.9], 0.43),  # exactly on a hundredth, which floor(x * 100) gets wrong
        ([0.4299, 0.9], 0.42),
        ([np.float32(0.43)], 0.43),
        ([0.999], 0.99),
    ],
)
def test_the_match_value_is_the_highest_hundredth_at_or_under_every_genuine_score(
    genuine, expected
):
    assert calibrate.pick_match_threshold(genuine) == expected


@pytest.mark.parametrize(
    ("different", "expected"),
    [
        ([0.43, 0.1], 0.44),  # a pair at exactly 0.43 would join a cluster at 0.43
        ([0.4301], 0.44),
        ([0.4299], 0.43),
        ([-0.2], -0.19),
    ],
)
def test_the_cluster_value_is_the_lowest_hundredth_above_every_different_person_pair(
    different, expected
):
    assert calibrate.pick_cluster_threshold(different) == expected


def test_no_scores_is_an_error_rather_than_a_number():
    with pytest.raises(CalibrationError):
        calibrate.pick_match_threshold([])
    with pytest.raises(CalibrationError):
        calibrate.pick_cluster_threshold([])


# The zero-miss rule at 1 reference, through the worker's own matching.match


def team(scores_a_event: list[float]) -> list[LabelledFace]:
    """Person a: three selfies on axis 0 and event faces at the given cosines to it. Person b:
    a selfie and an event face on axis 5, far from a."""
    faces = [labelled("a", "selfie", vector(1.0), photo=f"a/selfie_{i}.jpg") for i in (1, 2, 3)]
    faces += [
        labelled("a", "event", vector(s, other_axis=i + 1), photo=f"a/event_{i}.jpg")
        for i, s in enumerate(scores_a_event)
    ]
    b = np.zeros(512, np.float32)
    b[5] = 1
    faces += [labelled("b", "selfie", b), labelled("b", "event", b)]
    return faces


def test_the_picked_match_value_misses_no_team_face_at_1_reference():
    result = calibrate.analyse(team([0.475, 0.81, 0.62]), {}, detection_score=0.5)
    assert result.match_threshold == 0.47
    assert result.genuine_misses == []


def test_a_value_one_hundredth_higher_misses_a_team_face():
    faces = team([0.475, 0.81, 0.62])
    references = calibrate.references(faces, detection_score=0.5)
    misses = calibrate.genuine_misses(faces, references, 0.48, detection_score=0.5)
    # One event face, missed against each of a's three selfies.
    assert [m.face.photo for m in misses] == ["a/event_0.jpg"] * 3


def test_an_event_face_under_the_detection_score_fails_the_detection_check_not_the_match():
    faces = team([0.815])
    faces.append(labelled("a", "event", vector(0.30), score=0.45, photo="a/event_9.jpg"))
    result = calibrate.analyse(faces, {}, detection_score=0.5)
    assert [f.photo for f in result.team_faces_under_detection_score] == ["a/event_9.jpg"]
    # The worker never stores that face, so it does not pull the match value down to 0.30.
    assert result.match_threshold == 0.81


def test_a_selfie_with_two_faces_is_not_a_reference():
    faces = team([0.81])
    faces.append(labelled("a", "selfie", vector(0.2), photo="a/selfie_4.jpg"))
    counts = {"a/selfie_4.jpg": 2}
    refs = calibrate.references(faces, detection_score=0.5, faces_per_photo=counts)
    assert "a/selfie_4.jpg" not in [r.photo for r in refs]


def test_bench_faces_and_the_other_person_are_impostors_and_a_close_one_is_counted():
    bench = {"x.jpg": [face(0.1, 0.1, 0.9, vector(0.95, 7)), face(0.5, 0.1, 0.9, vector(0.1, 8))]}
    result = calibrate.analyse(team([0.475, 0.81]), bench, detection_score=0.5)
    assert result.match_threshold == 0.47
    # The 0.95 bench face matches each of a's three selfies at 0.47.
    assert result.bench_false_matches == 3
    assert result.bench_pairs == 2 * 4  # two bench faces against a's three selfies and b's one
    assert result.highest_impostor >= 0.95 - 1e-6


def test_a_rank_1_error_is_reported():
    faces = team([0.81])
    # An event face of b that sits closer to a's selfies than to b's.
    faces.append(labelled("b", "event", vector(0.9, 9), photo="b/event_2.jpg"))
    result = calibrate.analyse(faces, {}, detection_score=0.5)
    assert [f.photo for f in result.rank_1_errors] == ["b/event_2.jpg"]


def test_the_cluster_value_sits_above_same_photo_bench_pairs():
    bench = {"x.jpg": [face(0.1, 0.1, 0.9, vector(1.0, 7)), face(0.5, 0.1, 0.9, vector(0.9, 7))]}
    result = calibrate.analyse(team([0.81]), bench, detection_score=0.5)
    assert result.cluster_threshold > result.highest_different_person_pair
    assert result.highest_different_person_pair >= 0.9 - 1e-6
    existing = [matching.ClusterFace(uuid4(), vector(1.0, 7))]
    (joined,) = matching.cluster([vector(0.9, 7)], existing, result.cluster_threshold)
    assert joined != existing[0].cluster_id


# Whose face is whose


def touch(root: Path, *names: str) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"jpeg")


def test_the_layout_names_the_person_and_the_kind(tmp_path):
    touch(tmp_path, "a/selfie_1.jpg", "a/event_1.jpg", "b/selfie_1.jpeg", "b/event_1.jpg")
    touch(tmp_path, "group/b-a_1.jpg")
    photos = calibrate.parse_layout(tmp_path)
    assert TeamPhoto("a/selfie_1.jpg", "selfie", ("a",)) in photos
    assert TeamPhoto("b/selfie_1.jpeg", "selfie", ("b",)) in photos
    assert TeamPhoto("group/b-a_1.jpg", "group", ("b", "a")) in photos
    assert len(photos) == 5


@pytest.mark.parametrize(
    "bad",
    [
        "a/IMG_0001.jpg",  # not selfie_ or event_
        "a/selfie_1.heic",  # OpenCV cannot read HEIC
        "ab/selfie_1.jpg",  # a person is one letter
        "group/a-z_1.jpg",  # z has no folder
        "group/a_1.jpg",  # a group shot names at least two people
        "notes.txt",  # nothing loose at the top
    ],
)
def test_a_file_outside_the_layout_stops_the_run(tmp_path, bad):
    touch(tmp_path, "a/selfie_1.jpg", "a/event_1.jpg", "b/selfie_1.jpg", "b/event_1.jpg", bad)
    with pytest.raises(CalibrationError):
        calibrate.parse_layout(tmp_path)


def test_a_person_with_no_selfie_stops_the_run(tmp_path):
    touch(tmp_path, "a/selfie_1.jpg", "a/event_1.jpg", "b/event_1.jpg")
    with pytest.raises(CalibrationError, match="b"):
        calibrate.parse_layout(tmp_path)


def test_a_solo_photo_takes_its_largest_face_and_warns_about_the_rest():
    photo = TeamPhoto("a/event_1.jpg", "event", ("a",))
    small, large = face(0.7, 0.05), face(0.2, 0.3)
    found, extra = calibrate.assign(photo, [small, large])
    assert [(f.person, f.face) for f in found] == [("a", large)]
    assert extra == [small]


def test_a_group_shot_assigns_its_largest_faces_left_to_right():
    photo = TeamPhoto("group/b-a-c_1.jpg", "group", ("b", "a", "c"))
    left, middle, right, background = (
        face(0.05, 0.2),
        face(0.4, 0.2),
        face(0.75, 0.2),
        face(0.3, 0.02),
    )
    found, extra = calibrate.assign(photo, [right, background, left, middle])
    assert [(f.person, f.face) for f in found] == [("b", left), ("a", middle), ("c", right)]
    assert extra == [background]


def test_a_group_shot_missing_a_face_labels_nobody():
    photo = TeamPhoto("group/a-b-c_1.jpg", "group", ("a", "b", "c"))
    found, _ = calibrate.assign(photo, [face(0.1, 0.2), face(0.5, 0.2)])
    assert found == []


def test_a_solo_photo_with_no_face_labels_nobody():
    assert calibrate.assign(TeamPhoto("a/event_1.jpg", "event", ("a",)), []) == ([], [])


# The photos stay out of git (card Q5), and the manifest pins them


def test_a_team_folder_inside_the_repo_is_refused():
    with pytest.raises(CalibrationError):
        calibrate.check_outside_repo(REPO / "worker" / "bench")


def test_a_team_folder_outside_the_repo_is_accepted(tmp_path):
    calibrate.check_outside_repo(tmp_path)


def test_the_manifest_round_trips_and_catches_a_changed_photo(tmp_path):
    photos = tmp_path / "team"
    touch(photos, "a/selfie_1.jpg", "a/event_1.jpg")
    manifest = tmp_path / "calibration.sha256"
    calibrate.write_manifest(photos, manifest)
    calibrate.verify_team(photos, manifest)

    (photos / "a/event_1.jpg").write_bytes(b"another jpeg")
    with pytest.raises(CalibrationError, match="a/event_1.jpg"):
        calibrate.verify_team(photos, manifest)


def test_the_manifest_catches_a_photo_added_after_it(tmp_path):
    photos = tmp_path / "team"
    touch(photos, "a/selfie_1.jpg")
    manifest = tmp_path / "calibration.sha256"
    calibrate.write_manifest(photos, manifest)
    touch(photos, "a/event_1.jpg")
    with pytest.raises(CalibrationError, match="a/event_1.jpg"):
        calibrate.verify_team(photos, manifest)


def test_the_manifest_uses_forward_slashes_on_every_platform(tmp_path):
    photos = tmp_path / "team"
    touch(photos, "a/selfie_1.jpg")
    manifest = tmp_path / "calibration.sha256"
    calibrate.write_manifest(photos, manifest)
    assert manifest.read_text(encoding="utf-8").strip().endswith("  a/selfie_1.jpg")
