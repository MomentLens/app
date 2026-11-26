"""blur_region through the loop, over fakes (arch §3, arch §5, D-83, D-103, D-108, D-171)."""

from uuid import uuid4

import numpy as np
from fakes import FakeStorage, FakeStore, drain, face_model, make_worker, noise_jpeg

from app import blur, images
from app.ai import matching, model
from app.db import DnpSubject
from app.jobs import REGISTRY
from app.storage import StorageUnavailable

# 640x512 with a region on 16-pixel boundaries: JPEG codes 16x16 blocks, so every block outside
# the region gets the same input as an unblurred encode. The decoder smooths colour across block
# edges, so the one-pixel ring just outside the region is the only outside change (RING).
WIDTH, HEIGHT = 640, 512
RECT = (0.25, 0.25, 0.25, 0.25)  # pixels 160..320 across, 128..256 down
RING = 1


def photo(store, storage, *, version=1, published=True, regions=(RECT,), **row):
    """A photo with its files in R2, its regions and its message. Published, with its public keys
    pointing at the upload, unless `row` says otherwise."""
    media_id = uuid4()
    fields = {
        "public_key": f"{media_id}/upload.jpg",
        "public_thumb_key": f"{media_id}/upload_thumb.webp",
        "variant_version": version,
        "processed_at": "earlier" if published else None,
        "width": WIDTH,
        "height": HEIGHT,
    } | row
    store.add_media(media_id, **fields)
    storage.objects[f"{media_id}/upload.jpg"] = noise_jpeg(WIDTH, HEIGHT)
    storage.objects[f"{media_id}/upload_thumb.webp"] = b"client thumbnail"
    for r in regions:
        store.add_region(media_id, *r)
    msg_id = store.send({"job": "blur_region", "media_id": str(media_id)})
    return media_id, msg_id


def decoded(data):
    return images.decode(data).astype(int)


def test_the_job_is_registered():
    assert "blur_region" in REGISTRY


def test_writes_new_versioned_files_and_points_the_row_at_them():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=3)
    worker = make_worker(store, storage)

    drain(worker)

    row = store.state.media[media_id]
    assert row["public_key"] == f"{media_id}/public_v4.jpg"
    assert row["public_thumb_key"] == f"{media_id}/public_thumb_v4.webp"
    assert row["variant_version"] == 4
    assert storage.puts == [
        (f"{media_id}/public_v4.jpg", "image/jpeg"),
        (f"{media_id}/public_thumb_v4.webp", "image/webp"),
    ]
    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []


def test_pixels_outside_the_region_are_unchanged_and_inside_changed_in_the_full_file():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)
    upload = storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    out = decoded(storage.objects[store.state.media[media_id]["public_key"]])
    plain = decoded(blur.encode_full(images.decode(upload)))
    near = np.zeros((HEIGHT, WIDTH), bool)
    near[128 - RING : 256 + RING, 160 - RING : 320 + RING] = True
    assert np.array_equal(out[~near], plain[~near])
    assert np.abs(out[128:256, 160:320] - plain[128:256, 160:320]).mean() > 40


def test_pixels_outside_the_region_are_unchanged_and_inside_changed_in_the_thumbnail():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)
    upload = storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    out = decoded(storage.objects[store.state.media[media_id]["public_thumb_key"]])
    plain = decoded(blur.thumbnail(images.decode(upload)))
    assert out.shape[:2] == (240, 300)
    # The region is 75..150 across and 60..120 down at 300x240. WebP predicts each block from
    # its neighbours, so a margin of one 16-pixel block is left out on either side.
    diff = np.abs(out - plain).mean(axis=2)
    outside = np.ones(diff.shape, bool)
    outside[44:136, 59:166] = False
    assert diff[outside].mean() < 3
    assert diff[64:116, 79:146].mean() > 10


def test_the_upload_keys_are_never_written_or_deleted():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)
    upload_keys = {f"{media_id}/upload.jpg", f"{media_id}/upload_thumb.webp"}

    drain(make_worker(store, storage))

    assert not upload_keys & {key for key, _ in storage.puts}
    assert storage.deletes == []
    assert upload_keys <= storage.objects.keys()


def test_the_replaced_versioned_files_are_deleted_after_the_commit():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, version=2)
    old = {
        "public_key": f"{media_id}/public_v2.jpg",
        "public_thumb_key": f"{media_id}/public_thumb_v2.webp",
    }
    store.state.media[media_id].update(old)
    for key in old.values():
        storage.objects[key] = b"old"

    drain(make_worker(store, storage))

    assert storage.deletes == list(old.values())
    assert store.state.media[media_id]["variant_version"] == 3


def test_a_failed_commit_deletes_nothing_and_leaves_the_row():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=2)
    store.state.media[media_id].update(
        public_key=f"{media_id}/public_v2.jpg", public_thumb_key=f"{media_id}/public_thumb_v2.webp"
    )
    before = dict(store.state.media[media_id])
    store.faults["delete_message"] = [RuntimeError("delete failed")]

    make_worker(store, storage).step()

    assert store.state.media[media_id] == before
    assert storage.deletes == []
    assert not store.state.messages[msg_id].hidden


def test_a_failed_put_leaves_the_row_and_the_retry_rewrites_the_same_keys():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=5)
    before = dict(store.state.media[media_id])
    storage.put_faults = [RuntimeError("PUT failed")]
    worker = make_worker(store, storage)

    worker.step()

    assert store.state.media[media_id] == before
    assert store.state.messages[msg_id].read_ct == 1

    drain(worker)

    full, thumb = f"{media_id}/public_v6.jpg", f"{media_id}/public_thumb_v6.webp"
    assert [key for key, _ in storage.puts] == [full, full, thumb]
    assert store.state.media[media_id]["public_key"] == full
    assert store.state.media[media_id]["variant_version"] == 6


def test_an_r2_outage_on_put_leaves_the_row():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)
    before = dict(store.state.media[media_id])
    storage.put_faults = [StorageUnavailable("R2 answered 503")]

    make_worker(store, storage).step()

    assert store.state.media[media_id] == before


def test_a_gone_row_is_done_with_nothing_read():
    store, storage = FakeStore(), FakeStorage()
    msg_id = store.send({"job": "blur_region", "media_id": str(uuid4())})
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []
    assert storage.reads == [] and storage.puts == []


def test_a_deleted_photo_is_done_with_nothing_read_or_written():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, deleted_at="now")
    before = dict(store.state.media[media_id])
    worker = make_worker(store, storage)

    drain(worker)

    # Nobody can restore a deleted photo, so nothing keeps its files current (D-130).
    assert store.state.media[media_id] == before
    assert media_id not in store.state.subjects
    assert storage.reads == [] and storage.puts == [] and storage.deletes == []
    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []


def test_version_0_is_done_with_nothing_read_or_written():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=0, published=False, public_key=None)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["variant_version"] == 0 and row["processed_at"] is None
    assert msg_id not in store.state.messages
    assert storage.reads == [] and storage.puts == []


def test_processed_at_is_kept_when_set():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)

    drain(make_worker(store, storage))

    assert store.state.media[media_id]["processed_at"] == "earlier"


def test_processed_at_is_set_when_null_so_a_resent_message_republishes():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, published=False)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["processed_at"] is not None
    assert row["public_key"] == f"{media_id}/public_v2.jpg"


def test_three_failures_unpublish_and_the_resent_message_republishes():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    storage.put_faults = [RuntimeError("PUT failed")] * 3
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 3
    assert store.state.media[media_id]["processed_at"] is None

    store.send({"job": "blur_region", "media_id": str(media_id)})
    drain(worker)

    row = store.state.media[media_id]
    assert row["processed_at"] is not None and row["variant_version"] == 2


def test_with_no_region_left_the_public_keys_go_back_to_the_upload_and_nothing_is_put():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=2, regions=())
    old = (f"{media_id}/public_v2.jpg", f"{media_id}/public_thumb_v2.webp")
    store.state.media[media_id].update(public_key=old[0], public_thumb_key=old[1])

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["public_key"] == row["upload_key"]
    assert row["public_thumb_key"] == row["upload_thumb_key"]
    assert row["variant_version"] == 3
    assert storage.puts == [] and storage.reads == []
    assert storage.deletes == list(old)
    assert msg_id not in store.state.messages


def test_every_stored_region_is_applied():
    store, storage = FakeStore(), FakeStorage()
    second = (0.625, 0.5, 0.25, 0.25)  # pixels 400..560 across, 256..384 down
    media_id, _ = photo(store, storage, regions=(RECT, second))
    upload = storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    out = decoded(storage.objects[store.state.media[media_id]["public_key"]])
    plain = decoded(blur.encode_full(images.decode(upload)))
    assert np.abs(out[128:256, 160:320] - plain[128:256, 160:320]).mean() > 40
    assert np.abs(out[256:384, 400:560] - plain[256:384, 400:560]).mean() > 40


def test_a_failed_delete_after_the_commit_is_logged_and_the_job_is_done(caplog):
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=2)
    store.state.media[media_id].update(
        public_key=f"{media_id}/public_v2.jpg", public_thumb_key=f"{media_id}/public_thumb_v2.webp"
    )
    storage.delete_faults = [StorageUnavailable("R2 answered 503")]
    worker = make_worker(store, storage)

    with caplog.at_level("WARNING", logger="momentlens.worker.jobs"):
        drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []
    assert len(storage.deletes) == 2
    assert any("could not delete" in r.getMessage() for r in caplog.records)


# --- S-21: subjects' files, and faces from the stored rows (D-57, D-66, D-83) ------------------

# Two stored faces as fractions of 640x512, far apart: pixels 48..128 and 496..576 across, 64..176
# down. Their cores sit inside each grown ellipse and clear of RECT.
FACES = [(48 / 640, 64 / 512, 80 / 640, 112 / 512), (496 / 640, 64 / 512, 80 / 640, 112 / 512)]
FACE_CORES = [(100, 140, 68, 108), (100, 140, 516, 556)]


def unit(i):
    row = np.zeros(512, np.float32)
    row[i], row[511] = 0.6, 0.8
    return row


def with_faces(store, media_id):
    for i, box in enumerate(FACES):
        store.add_face(media_id, *box, embedding=unit(i))


def core_changed(out, ref, core):
    y0, y1, x0, x1 = core
    return np.abs(out[y0:y1, x0:x1] - ref[y0:y1, x0:x1]).mean()


def test_subjects_files_are_rebuilt_with_every_region_and_their_own_face_clear(monkeypatch):
    monkeypatch.setattr(matching, "MATCH_THRESHOLD", 0.9)
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, version=1)
    with_faces(store, media_id)
    event_id = store.state.media[media_id]["event_id"]
    a = store.add_member(event_id, unit(0), dnp=True)
    b = store.add_member(event_id, unit(1), dnp=True)
    upload = storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["variant_version"] == 2
    subjects = {s.subject_id: s for s in store.state.subjects[media_id]}
    assert set(subjects) == {a, b}
    assert subjects[a].variant_key == f"{media_id}/{a}_v2.jpg"
    assert subjects[b].variant_thumb_key == f"{media_id}/{b}_thumb_v2.webp"
    assert len(storage.puts) == 6

    ref = decoded(blur.encode_full(images.decode(upload)))
    thumb_ref = decoded(blur.thumbnail(images.decode(upload)))
    files = {
        "public": (row["public_key"], row["public_thumb_key"], {0, 1}),
        "a": (subjects[a].variant_key, subjects[a].variant_thumb_key, {1}),
        "b": (subjects[b].variant_key, subjects[b].variant_thumb_key, {0}),
    }
    for name, (key, thumb_key, hidden) in files.items():
        out = decoded(storage.objects[key])
        assert core_changed(out, ref, (128, 256, 160, 320)) > 40, f"{name}: region"
        thumb = decoded(storage.objects[thumb_key])
        assert core_changed(thumb, thumb_ref, (64, 116, 79, 146)) > 10, f"{name}: thumb region"
        for i, core in enumerate(FACE_CORES):
            diff = core_changed(out, ref, core)
            assert (diff > 40) if i in hidden else (diff < 3), f"{name}: face {i} at {diff}"


def test_the_last_region_deleted_on_a_fail_closed_photo_keeps_its_faces_blurred():
    assert matching.MATCH_THRESHOLD is None, "arch §6 has a value now; update this test"
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, version=2, regions=())
    old = (f"{media_id}/public_v2.jpg", f"{media_id}/public_thumb_v2.webp")
    store.state.media[media_id].update(public_key=old[0], public_thumb_key=old[1])
    with_faces(store, media_id)
    upload = storage.objects[f"{media_id}/upload.jpg"]

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert row["public_key"] == f"{media_id}/public_v3.jpg"
    assert row["public_key"] != row["upload_key"]
    assert row["public_thumb_key"] == f"{media_id}/public_thumb_v3.webp"
    out = decoded(storage.objects[row["public_key"]])
    ref = decoded(blur.encode_full(images.decode(upload)))
    for core in FACE_CORES:
        assert core_changed(out, ref, core) > 40
    assert storage.deletes == list(old)
    assert msg_id not in store.state.messages


def test_the_replaced_subject_files_are_deleted_after_the_commit(monkeypatch):
    monkeypatch.setattr(matching, "MATCH_THRESHOLD", 0.9)
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, version=4)
    with_faces(store, media_id)
    a = store.add_member(store.state.media[media_id]["event_id"], unit(0), dnp=True)
    old = DnpSubject(a, f"{media_id}/{a}_v4.jpg", f"{media_id}/{a}_thumb_v4.webp")
    store.state.subjects[media_id] = [old]
    storage.objects[old.variant_key] = b"old"
    storage.objects[old.variant_thumb_key] = b"old"

    drain(make_worker(store, storage))

    (new,) = store.state.subjects[media_id]
    assert new.variant_key == f"{media_id}/{a}_v5.jpg"
    assert old.variant_key in storage.deletes and old.variant_thumb_key in storage.deletes
    assert f"{media_id}/upload.jpg" not in storage.deletes


def test_a_subject_who_is_no_longer_in_the_photo_loses_their_row_and_files(monkeypatch):
    monkeypatch.setattr(matching, "MATCH_THRESHOLD", 0.9)
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, version=4)
    gone = uuid4()
    old = DnpSubject(gone, f"{media_id}/{gone}_v4.jpg", f"{media_id}/{gone}_thumb_v4.webp")
    store.state.subjects[media_id] = [old]

    drain(make_worker(store, storage))

    assert store.state.subjects[media_id] == []
    assert old.variant_key in storage.deletes and old.variant_thumb_key in storage.deletes


def test_blur_region_never_detects(monkeypatch):
    loaded = face_model([[48, 64, 128, 176, 0.9]])
    monkeypatch.setattr(model, "_loaded", loaded)
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage)
    with_faces(store, media_id)

    drain(make_worker(store, storage))

    assert loaded.detector.calls == 0
    assert store.state.media[media_id]["variant_version"] == 2
