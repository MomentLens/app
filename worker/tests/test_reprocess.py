"""reprocess through the loop, over fakes (spec §4.11.4.5, arch §5, D-66, D-69, D-129, D-130,
D-178).

Each photo is published by face_process first, the way a real one is, with the fake detector
finding the same three faces in every photo. Face i's embedding is `embedding(i)`, so a reference
equal to it matches face i at similarity 1 and every other face at 0.64. The tests set their own
threshold of 0.9 (D-104). Then the test changes the event's references or Do Not Publish and sends
reprocess.
"""

from uuid import uuid4

import numpy as np
import pytest
from fakes import FakeStorage, FakeStore, drain, make_worker, noise_jpeg
from test_face_process import (
    HEIGHT,
    REGION,
    REGION_CORE,
    WIDTH,
    blurred_faces,
    changed,
    detected,  # noqa: F401  (a fixture)
    embedding,
    pixels,
    plain,
)

from app.ai import faces, matching
from app.jobs import REGISTRY, reprocess


@pytest.fixture
def threshold(monkeypatch):
    monkeypatch.setattr(matching, "MATCH_THRESHOLD", 0.9)
    return 0.9


@pytest.fixture
def world(detected):  # noqa: F811
    detected()
    return FakeStore(), FakeStorage()


def publish(store, storage, event_id, *, regions=()):
    """A photo in the event, published by face_process. Returns its media_id."""
    media_id = store.add_media(event_id=event_id)
    storage.objects[f"{media_id}/upload.jpg"] = noise_jpeg(WIDTH, HEIGHT)
    storage.objects[f"{media_id}/upload_thumb.webp"] = b"client thumbnail"
    for r in regions:
        store.add_region(media_id, *r)
    store.send({"job": "face_process", "media_id": str(media_id)})
    drain(make_worker(store, storage))
    assert store.state.media[media_id]["variant_version"] == 1
    return media_id


def send(store, subject_id, event_id):
    return store.send(
        {"job": "reprocess", "subject_id": str(subject_id), "event_id": str(event_id)}
    )


def set_dnp(store, subject_id, on=True):
    for m in store.state.members:
        if m["subject_id"] == subject_id:
            m["dnp"] = on


def files(store, media_id):
    """The keys the row and its subject rows point at, as {None: public, subject: own}."""
    row = store.state.media[media_id]
    result = {None: (row["public_key"], row["public_thumb_key"])}
    for s in store.state.subjects.get(media_id, []):
        result[s.subject_id] = (s.variant_key, s.variant_thumb_key)
    return result


def blurred(store, storage, media_id):
    """Which faces each file blurs, by subject, None for the public file."""
    return {
        who: blurred_faces(storage, media_id, key, thumb)
        for who, (key, thumb) in files(store, media_id).items()
    }


def test_the_job_is_registered():
    assert "reprocess" in REGISTRY


# --- negative tests from the card ----------------------------------------------------------


def test_do_not_publish_turned_on_after_upload_blurs_the_subject_everywhere_but_their_file(
    world, threshold
):
    store, storage = world
    event_id = uuid4()
    a = store.add_member(event_id, embedding(0), dnp=True)
    s = store.add_member(event_id, embedding(1))
    media_id = publish(store, storage, event_id)
    assert blurred(store, storage, media_id) == {None: {0}, a: set()}

    set_dnp(store, s)
    msg_id = send(store, s, event_id)
    worker = make_worker(store, storage)
    drain(worker)

    # The public file and thumbnail blur S; S's own shows S; A's file, which showed S, blurs S
    # now (D-69). Two subjects, so three files and three thumbnails (root invariant 11).
    assert blurred(store, storage, media_id) == {None: {0, 1}, a: {1}, s: {0}}
    assert store.state.media[media_id]["variant_version"] == 2
    assert files(store, media_id)[None] == (
        f"{media_id}/public_v2.jpg",
        f"{media_id}/public_thumb_v2.webp",
    )
    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []
    assert [f["dnp_subject_id"] for f in store.state.faces[media_id]] == [a, s, None]


def test_a_new_reference_blurs_a_subjects_real_face_when_a_wrong_match_already_named_them(
    world, threshold
):
    store, storage = world
    event_id = uuid4()
    # A's first reference matches face 0, a relative; face 1 is A.
    a = store.add_member(event_id, embedding(0), dnp=True)
    media_id = publish(store, storage, event_id)
    assert blurred(store, storage, media_id) == {None: {0}, a: set()}

    store.add_reference(
        event_id=event_id,
        subject_id=a,
        status="accepted",
        embedding=[float(v) for v in embedding(1)],
    )
    send(store, a, event_id)
    drain(make_worker(store, storage))

    # The subject set is still {A}, and the photo is rebuilt anyway (D-178).
    assert blurred(store, storage, media_id) == {None: {0, 1}, a: set()}
    assert store.state.media[media_id]["variant_version"] == 2


def test_another_events_photos_and_deleted_and_unwritten_photos_are_left(world, threshold):
    store, storage = world
    event_id, other_event = uuid4(), uuid4()
    s = store.add_member(event_id, embedding(0))
    store.add_member(other_event, embedding(0), subject_id=s)
    mine = publish(store, storage, event_id)
    theirs = publish(store, storage, other_event)
    deleted = publish(store, storage, event_id)
    store.state.media[deleted]["deleted_at"] = "now"
    unwritten = store.add_media(event_id=event_id)
    store.add_face(unwritten, 0.1, 0.1, 0.1, 0.1, embedding(0))
    before = {m: dict(store.state.media[m]) for m in (theirs, deleted, unwritten)}
    faces_before = {m: [dict(f) for f in store.state.faces[m]] for m in (theirs, unwritten)}
    storage.puts.clear()

    for m in store.state.members:
        m["dnp"] = True
    send(store, s, event_id)
    drain(make_worker(store, storage))

    assert store.state.media[mine]["variant_version"] == 2
    for m, row in before.items():
        assert store.state.media[m] == row
    for m, rows in faces_before.items():
        assert [f["dnp_subject_id"] for f in store.state.faces[m]] == [
            f["dnp_subject_id"] for f in rows
        ]
    assert {key.split("/")[0] for key, _ in storage.puts} == {str(mine)}


def test_every_file_still_carries_the_stored_region(world, threshold):
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0))
    media_id = publish(store, storage, event_id, regions=[REGION])

    set_dnp(store, s)
    send(store, s, event_id)
    drain(make_worker(store, storage))

    full_ref, _ = plain(storage, media_id)
    keys = files(store, media_id)
    assert set(keys) == {None, s}
    for key, _thumb in keys.values():
        assert changed(pixels(storage, key), full_ref, REGION_CORE) > 40


def test_reprocess_never_detects(world, threshold, monkeypatch):
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0))
    media_id = publish(store, storage, event_id)

    def refuse(_image):
        raise AssertionError("reprocess ran detection")

    monkeypatch.setattr(faces, "detect", refuse)
    set_dnp(store, s)
    msg_id = send(store, s, event_id)
    worker = make_worker(store, storage)
    drain(worker)

    assert worker.report.calls == [] and msg_id not in store.state.messages
    assert store.state.media[media_id]["variant_version"] == 2


def test_no_pointed_at_key_is_overwritten_and_processed_at_and_upload_keys_are_kept(
    world, threshold
):
    store, storage = world
    event_id = uuid4()
    a = store.add_member(event_id, embedding(0), dnp=True)
    s = store.add_member(event_id, embedding(1))
    media_id = publish(store, storage, event_id)
    pointed = {k for pair in files(store, media_id).values() for k in pair}
    processed_at = store.state.media[media_id]["processed_at"]
    uploads = {f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp"}
    storage.puts.clear()

    set_dnp(store, s)
    send(store, s, event_id)
    drain(make_worker(store, storage))

    put = {key for key, _ in storage.puts}
    assert not put & pointed and not put & uploads
    assert not uploads & set(storage.deletes)
    assert uploads <= storage.objects.keys()
    # The version 1 files the rows stopped pointing at are gone; a's own and the public.
    assert set(storage.deletes) == pointed
    assert store.state.media[media_id]["processed_at"] == processed_at
    assert store.state.media[media_id]["upload_key"] == f"{media_id}/upload.jpg"
    assert a in files(store, media_id)


class FailFor(FakeStorage):
    """R2 refusing every PUT under one photo's prefix, `times` times."""

    def __init__(self, base, media_id, times):
        super().__init__()
        self.__dict__.update(base.__dict__)
        self.media_id, self.times = str(media_id), times

    def put(self, key, data, content_type):
        if key.startswith(self.media_id + "/") and self.times > 0:
            self.times -= 1
            self.puts.append((key, content_type))
            raise RuntimeError("PUT refused")
        super().put(key, data, content_type)


def two_changing_photos(store, storage):
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0))
    first = publish(store, storage, event_id)
    second = publish(store, storage, event_id)
    set_dnp(store, s)
    return event_id, s, first, second


def test_a_rerun_after_a_mid_job_failure_rebuilds_nothing_twice(world, threshold):
    store, base = world
    event_id, s, first, second = two_changing_photos(store, base)
    storage = FailFor(base, second, times=1)
    storage.puts.clear()
    msg_id = send(store, s, event_id)
    worker = make_worker(store, storage)

    worker.step()
    # The first photo committed on its own; the message is still there for the second.
    assert store.state.media[first]["variant_version"] == 2
    assert store.state.media[second]["variant_version"] == 1
    assert msg_id in store.state.messages

    drain(worker)

    assert store.state.media[first]["variant_version"] == 2
    assert store.state.media[second]["variant_version"] == 2
    first_puts = [key for key, _ in storage.puts if key.startswith(f"{first}/")]
    assert len(first_puts) == len(set(first_puts)) == 4
    assert msg_id not in store.state.messages and store.state.archived == {}


def test_a_final_failure_unpublishes_only_the_photos_not_yet_rebuilt(world, threshold):
    store, base = world
    event_id, s, first, second = two_changing_photos(store, base)
    storage = FailFor(base, second, times=99)
    msg_id = send(store, s, event_id)
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id in store.state.archived
    assert store.state.media[first]["processed_at"] is not None
    assert store.state.media[first]["variant_version"] == 2
    assert store.state.media[second]["processed_at"] is None
    assert store.state.media[second]["variant_version"] == 1
    (call,) = worker.report.calls
    assert call["job"] == "reprocess" and call["kind"] == "failed"


def test_a_missing_upload_unpublishes_that_photo_only_and_the_job_carries_on(
    world, threshold, monkeypatch
):
    store, storage = world
    event_id, s, first, second = two_changing_photos(store, storage)
    del storage.objects[f"{first}/upload.jpg"]
    reported = []
    monkeypatch.setattr(reprocess.sentry_sdk, "capture_message", lambda *a, **k: reported.append(a))
    msg_id = send(store, s, event_id)
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.media[first]["processed_at"] is None
    assert store.state.media[first]["variant_version"] == 1
    assert store.state.media[second]["processed_at"] is not None
    assert store.state.media[second]["variant_version"] == 2
    assert msg_id not in store.state.messages and store.state.archived == {}
    assert len(reported) == 1


def test_with_no_threshold_nothing_is_written(world, threshold, monkeypatch):
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0))
    media_id = publish(store, storage, event_id)
    before = dict(store.state.media[media_id])
    faces_before = [dict(f) for f in store.state.faces[media_id]]
    storage.puts.clear()

    monkeypatch.setattr(matching, "MATCH_THRESHOLD", None)
    set_dnp(store, s)
    msg_id = send(store, s, event_id)
    drain(make_worker(store, storage))

    assert store.state.media[media_id] == before
    assert [f["matched_subject_id"] for f in store.state.faces[media_id]] == [
        f["matched_subject_id"] for f in faces_before
    ]
    assert storage.puts == [] and msg_id not in store.state.messages


# --- matches rewritten (D-178) --------------------------------------------------------------


def test_a_reference_added_after_upload_is_matched_without_rebuilding_the_files(
    world, threshold, monkeypatch
):
    monkeypatch.setattr(matching, "CLUSTER_THRESHOLD", 0.9)
    store, storage = world
    event_id = uuid4()
    media_id = publish(store, storage, event_id)
    assert store.state.faces[media_id][0]["cluster_id"] is not None
    storage.puts.clear()

    s = store.add_member(event_id, embedding(0))
    send(store, s, event_id)
    drain(make_worker(store, storage))

    face = store.state.faces[media_id][0]
    assert face["matched_subject_id"] == s and face["similarity"] == pytest.approx(1.0)
    # A matched face leaves its Unknown cluster.
    assert face["cluster_id"] is None
    assert store.state.media[media_id]["variant_version"] == 1 and storage.puts == []


def test_a_removed_members_faces_lose_their_match_and_join_a_cluster(world, threshold, monkeypatch):
    monkeypatch.setattr(matching, "CLUSTER_THRESHOLD", 0.9)
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0))
    first = publish(store, storage, event_id)
    second = publish(store, storage, event_id)
    assert store.state.faces[first][0]["matched_subject_id"] == s

    store.state.members[0]["status"] = "removed"
    send(store, s, event_id)
    drain(make_worker(store, storage))

    one, two = store.state.faces[first][0], store.state.faces[second][0]
    assert one["matched_subject_id"] is None and one["similarity"] is None
    assert one["cluster_id"] is not None and one["cluster_id"] == two["cluster_id"]


def test_a_removed_subject_with_do_not_publish_stays_blurred(world, threshold):
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0), dnp=True)
    media_id = publish(store, storage, event_id)
    storage.puts.clear()

    store.state.members[0]["status"] = "removed"
    send(store, s, event_id)
    drain(make_worker(store, storage))

    # Not recognised any more, still blurred, nothing rebuilt (D-175).
    face = store.state.faces[media_id][0]
    assert face["matched_subject_id"] is None and face["dnp_subject_id"] == s
    assert store.state.media[media_id]["variant_version"] == 1 and storage.puts == []


def test_a_rerun_with_nothing_changed_writes_nothing(world, threshold):
    store, storage = world
    event_id = uuid4()
    s = store.add_member(event_id, embedding(0), dnp=True)
    media_id = publish(store, storage, event_id)
    before = dict(store.state.media[media_id])
    storage.puts.clear()

    msg_id = send(store, s, event_id)
    drain(make_worker(store, storage))

    assert store.state.media[media_id] == before and storage.puts == []
    assert msg_id not in store.state.messages


def test_the_plan_names_each_faces_subject():
    from app import variants
    from app.ai.matching import Reference

    class F:
        def __init__(self, i):
            self.x = self.y = self.width = self.height = 0.1
            self.embedding = embedding(i)

    a = uuid4()
    chosen = variants.plan([F(0), F(1)], [Reference(a, embedding(1))], 0.9)
    assert chosen.face_subjects == (None, a)
    unmeasured = variants.plan([F(0), F(1)], [Reference(a, embedding(1))], None)
    assert unmeasured.face_subjects == (None, None) and unmeasured.public == (0, 1)
    assert np.allclose(F(0).embedding, embedding(0))
