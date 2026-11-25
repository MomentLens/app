"""face_process through the loop, over fakes (arch §3, arch §5, D-57, D-69, D-104, D-172, D-175).

The fake recognizer gives the i-th face the detector finds the embedding `embedding(i)`, so a
reference equal to it matches that face at similarity 1 and every other face at 0.64. A test that
needs a match threshold sets its own, never the module's (D-104).
"""

from uuid import uuid4

import numpy as np
import pytest
from fakes import FakeStorage, FakeStore, drain, face_model, make_worker, noise_jpeg

from app import blur, images
from app.ai import matching, model
from app.jobs import REGISTRY

WIDTH, HEIGHT = 640, 512
# Three faces in a row, far enough apart that their grown ellipses never meet.
BOXES = [
    [48, 64, 128, 176, 0.9],
    [272, 64, 352, 176, 0.9],
    [496, 64, 576, 176, 0.9],
]
# A pixel square inside each face's ellipse, as (y0, y1, x0, x1), full size and at 300x240.
CORES = [(100, 140, 68, 108), (100, 140, 292, 332), (100, 140, 516, 556)]
THUMB_CORES = [(48, 64, 33, 49), (48, 64, 138, 154), (48, 64, 243, 259)]
# A blur region clear of every face: pixels 160..480 across, 320..448 down.
REGION = (0.25, 0.625, 0.5, 0.25)
REGION_CORE = (336, 432, 176, 464)
REGION_THUMB_CORE = (160, 200, 84, 216)


def embedding(i):
    """What the fake recognizer returns for the i-th face, normalised."""
    row = np.zeros(512, np.float32)
    row[i], row[511] = 0.6, 0.8
    return row


@pytest.fixture
def detected(monkeypatch):
    """Loads a model whose detector finds `boxes`, and returns it."""

    def load(boxes=BOXES):
        loaded = face_model(boxes)
        monkeypatch.setattr(model, "_loaded", loaded)
        return loaded

    return load


@pytest.fixture
def threshold(monkeypatch):
    """A match threshold for this test only. 0.9 separates 1.0 from 0.64."""
    monkeypatch.setattr(matching, "MATCH_THRESHOLD", 0.9)
    return 0.9


def photo(store, storage, *, version=0, regions=()):
    event_id = uuid4()
    media_id = store.add_media(event_id=event_id, variant_version=version)
    storage.objects[f"{media_id}/upload.jpg"] = noise_jpeg(WIDTH, HEIGHT)
    storage.objects[f"{media_id}/upload_thumb.webp"] = b"client thumbnail"
    for r in regions:
        store.add_region(media_id, *r)
    msg_id = store.send({"job": "face_process", "media_id": str(media_id)})
    return media_id, event_id, msg_id


def pixels(storage, key):
    return images.decode(storage.objects[key]).astype(int)


def plain(storage, media_id):
    """The upload as the worker would encode it with nothing blurred: full size, then thumbnail."""
    image = images.decode(storage.objects[f"{media_id}/upload.jpg"])
    return (
        images.decode(blur.encode_full(image)).astype(int),
        images.decode(blur.thumbnail(image)).astype(int),
    )


def changed(out, ref, core):
    y0, y1, x0, x1 = core
    return np.abs(out[y0:y1, x0:x1] - ref[y0:y1, x0:x1]).mean()


def blurred_faces(storage, media_id, key, thumb_key):
    """Which of the three faces the file and its thumbnail blur. Asserts the two agree."""
    full_ref, thumb_ref = plain(storage, media_id)
    full, thumb = pixels(storage, key), pixels(storage, thumb_key)
    result = set()
    for i, (core, thumb_core) in enumerate(zip(CORES, THUMB_CORES, strict=True)):
        in_full, in_thumb = changed(full, full_ref, core), changed(thumb, thumb_ref, thumb_core)
        assert (in_full > 40) == (in_thumb > 10), f"face {i}: file {in_full}, thumbnail {in_thumb}"
        assert in_full > 40 or in_full < 3, f"face {i} half blurred: {in_full}"
        if in_full > 40:
            result.add(i)
    return result


def test_the_job_is_registered_and_thumbnail_dims_is_gone():
    assert "face_process" in REGISTRY
    assert "thumbnail_dims" not in REGISTRY


# --- negative tests from the card ----------------------------------------------------------


def test_two_subjects_give_three_files_and_three_thumbnails(detected, threshold):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, msg_id = photo(store, storage)
    a = store.add_member(event_id, embedding(0), dnp=True)
    b = store.add_member(event_id, embedding(1), dnp=True)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["variant_version"] == 1 and row["processed_at"] is not None
    assert row["public_key"] == f"{media_id}/public_v1.jpg"
    assert row["public_thumb_key"] == f"{media_id}/public_thumb_v1.webp"
    first, second = sorted((a, b), key=str)
    assert sorted(storage.puts) == sorted(
        [
            (f"{media_id}/public_v1.jpg", "image/jpeg"),
            (f"{media_id}/public_thumb_v1.webp", "image/webp"),
            (f"{media_id}/{first}_v1.jpg", "image/jpeg"),
            (f"{media_id}/{first}_thumb_v1.webp", "image/webp"),
            (f"{media_id}/{second}_v1.jpg", "image/jpeg"),
            (f"{media_id}/{second}_thumb_v1.webp", "image/webp"),
        ]
    )
    subjects = {s.subject_id: s for s in store.state.subjects[media_id]}
    assert set(subjects) == {a, b}
    assert subjects[a].variant_key == f"{media_id}/{a}_v1.jpg"
    assert subjects[a].variant_thumb_key == f"{media_id}/{a}_thumb_v1.webp"

    assert blurred_faces(storage, media_id, row["public_key"], row["public_thumb_key"]) == {0, 1}
    own_a = subjects[a]
    assert blurred_faces(storage, media_id, own_a.variant_key, own_a.variant_thumb_key) == {1}
    own_b = subjects[b]
    assert blurred_faces(storage, media_id, own_b.variant_key, own_b.variant_thumb_key) == {0}
    assert msg_id not in store.state.messages


def test_every_file_and_thumbnail_carries_the_stored_regions(detected, threshold):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage, regions=(REGION,))
    store.add_member(event_id, embedding(0), dnp=True)
    store.add_member(event_id, embedding(1), dnp=True)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    files = [(row["public_key"], row["public_thumb_key"])] + [
        (s.variant_key, s.variant_thumb_key) for s in store.state.subjects[media_id]
    ]
    assert len(files) == 3
    full_ref, thumb_ref = plain(storage, media_id)
    for key, thumb_key in files:
        assert changed(pixels(storage, key), full_ref, REGION_CORE) > 40, key
        assert changed(pixels(storage, thumb_key), thumb_ref, REGION_THUMB_CORE) > 10, thumb_key


def test_each_thumbnail_is_blurred_with_its_own_file(detected, threshold):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    a = store.add_member(event_id, embedding(2), dnp=True)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    (own,) = store.state.subjects[media_id]
    assert own.subject_id == a
    # blurred_faces asserts the thumbnail blurs exactly the faces its file blurs.
    assert blurred_faces(storage, media_id, row["public_key"], row["public_thumb_key"]) == {2}
    assert blurred_faces(storage, media_id, own.variant_key, own.variant_thumb_key) == set()


def test_a_message_resent_on_a_written_row_writes_nothing(detected):
    loaded = detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage, version=2)
    store.state.media[media_id].update(
        public_key=f"{media_id}/public_v2.jpg",
        public_thumb_key=f"{media_id}/public_thumb_v2.webp",
        processed_at="earlier",
    )
    before = dict(store.state.media[media_id])
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.media[media_id] == before
    assert storage.reads == [] and storage.puts == [] and storage.deletes == []
    assert media_id not in store.state.faces and media_id not in store.state.subjects
    assert loaded.detector.calls == 0
    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []


# --- fail closed while arch §6 has no threshold ----------------------------------------------


def test_with_no_threshold_every_face_is_blurred_and_nobody_is_a_subject(detected):
    assert matching.MATCH_THRESHOLD is None, "arch §6 has a value now; update this test"
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    store.add_member(event_id, embedding(0), dnp=True)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert [key for key, _ in storage.puts] == [
        f"{media_id}/public_v1.jpg",
        f"{media_id}/public_thumb_v1.webp",
    ]
    assert blurred_faces(storage, media_id, row["public_key"], row["public_thumb_key"]) == {
        0,
        1,
        2,
    }
    assert store.state.subjects[media_id] == []
    faces = store.state.faces[media_id]
    assert len(faces) == 3
    assert all(
        f["matched_subject_id"] is None and f["similarity"] is None and f["cluster_id"] is None
        for f in faces
    )


def test_no_face_points_the_public_keys_at_the_upload_and_writes_no_object(detected):
    detected([])
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["public_key"] == row["upload_key"]
    assert row["public_thumb_key"] == row["upload_thumb_key"]
    assert (row["width"], row["height"]) == (WIDTH, HEIGHT)
    assert row["variant_version"] == 1 and row["processed_at"] is not None
    assert storage.puts == [] and storage.deletes == []
    assert store.state.faces[media_id] == [] and store.state.subjects[media_id] == []
    assert msg_id not in store.state.messages


# --- who counts as a subject ---------------------------------------------------------------


@pytest.mark.parametrize("status", ["removed", "blocked", "pending"])
def test_a_flagged_member_of_any_status_is_still_blurred(detected, threshold, status):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    gone = store.add_member(event_id, embedding(0), dnp=True, status=status)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert blurred_faces(storage, media_id, row["public_key"], row["public_thumb_key"]) == {0}
    assert [s.subject_id for s in store.state.subjects[media_id]] == [gone]
    # Recognition reads active members only (D-175).
    assert store.state.faces[media_id][0]["matched_subject_id"] is None


def test_an_active_member_without_do_not_publish_is_recognised_and_not_blurred(detected, threshold):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    seen = store.add_member(event_id, embedding(1))

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["public_key"] == row["upload_key"] and storage.puts == []
    face = store.state.faces[media_id][1]
    assert face["matched_subject_id"] == seen
    assert face["similarity"] == pytest.approx(1.0, abs=1e-5)
    assert face["cluster_id"] is None
    assert [f["matched_subject_id"] for f in store.state.faces[media_id]] == [None, seen, None]


def test_a_flagged_member_of_another_event_blurs_nothing(detected, threshold):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, _ = photo(store, storage)
    store.add_member(uuid4(), embedding(0), dnp=True)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["public_key"] == row["upload_key"] and storage.puts == []
    assert store.state.subjects[media_id] == []


def test_a_lone_subject_gets_a_file_at_their_own_key_with_nothing_blurred(detected, threshold):
    detected([BOXES[0]])
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    lone = store.add_member(event_id, embedding(0), dnp=True)

    drain(make_worker(store, storage))

    (own,) = store.state.subjects[media_id]
    assert own.variant_key == f"{media_id}/{lone}_v1.jpg"
    assert own.variant_key != store.state.media[media_id]["upload_key"]
    assert own.variant_key in storage.objects and own.variant_thumb_key in storage.objects


def test_unmatched_faces_get_unknown_clusters_once_there_is_a_threshold(
    detected, threshold, monkeypatch
):
    monkeypatch.setattr(matching, "CLUSTER_THRESHOLD", 0.9)
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, event_id, _ = photo(store, storage)
    store.add_member(event_id, embedding(0))

    drain(make_worker(store, storage))

    faces = store.state.faces[media_id]
    assert faces[0]["cluster_id"] is None and faces[0]["matched_subject_id"] is not None
    assert faces[1]["cluster_id"] is not None and faces[2]["cluster_id"] is not None
    assert faces[1]["cluster_id"] != faces[2]["cluster_id"]


# --- the one detection pass and the retry ----------------------------------------------------


def test_detection_runs_once_and_stores_the_box_as_fractions(detected):
    loaded = detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, _ = photo(store, storage)

    drain(make_worker(store, storage))

    assert loaded.detector.calls == 1
    first = store.state.faces[media_id][0]
    assert (first["x"], first["y"]) == pytest.approx((48 / WIDTH, 64 / HEIGHT))
    assert (first["width"], first["height"]) == pytest.approx((80 / WIDTH, 112 / HEIGHT))
    assert len(first["embedding"]) == 512


def test_a_failed_put_writes_no_row_and_the_retry_rewrites_the_same_keys(detected):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)
    before = dict(store.state.media[media_id])
    storage.put_faults = [RuntimeError("PUT failed")]
    worker = make_worker(store, storage)

    worker.step()

    assert store.state.media[media_id] == before
    assert media_id not in store.state.faces
    assert store.state.messages[msg_id].read_ct == 1

    drain(worker)

    full = f"{media_id}/public_v1.jpg"
    assert [key for key, _ in storage.puts] == [full, full, f"{media_id}/public_thumb_v1.webp"]
    assert store.state.media[media_id]["public_key"] == full
    assert len(store.state.faces[media_id]) == 3


def test_three_failures_archive_the_message_and_leave_the_photo_unpublished(detected):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)
    storage.put_faults = [RuntimeError("PUT failed")] * 3
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 3
    row = store.state.media[media_id]
    assert row["processed_at"] is None and row["variant_version"] == 0
    assert media_id not in store.state.faces


def test_a_missing_upload_is_archived_on_the_first_try(detected):
    detected()
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)
    del storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    assert store.state.archived[msg_id].read_ct == 1
    assert store.state.media[media_id]["processed_at"] is None
