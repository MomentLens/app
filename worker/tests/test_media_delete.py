"""media_delete through the loop, over fakes (arch §3, arch §5, D-123, D-130, D-177)."""

from uuid import UUID, uuid4

import numpy as np
from fakes import FakeStorage, FakeStore, drain, make_worker

from app.db import DnpSubject
from app.jobs import REGISTRY
from app.storage import StorageUnavailable


def keys_of(media_id, subject_id):
    """Every object a photo with one Do Not Publish subject has at variant_version 2, and a stray
    version 1 file no row points at, as a retried job leaves (D-103)."""
    return [
        f"{media_id}/upload.jpg",
        f"{media_id}/upload_thumb.webp",
        f"{media_id}/public_v2.jpg",
        f"{media_id}/public_thumb_v2.webp",
        f"{media_id}/{subject_id}_v2.jpg",
        f"{media_id}/{subject_id}_thumb_v2.webp",
        f"{media_id}/public_v1.jpg",
    ]


def photo(store, storage, media_id=None, *, deleted=True, send=True):
    """A published photo with its files in R2, one face, one subject and one region. Deleted,
    with its media_delete message sent, unless told otherwise."""
    media_id = media_id or uuid4()
    subject_id = uuid4()
    keys = keys_of(media_id, subject_id)
    store.add_media(
        media_id,
        public_key=keys[2],
        public_thumb_key=keys[3],
        variant_version=2,
        processed_at="earlier",
        deleted_at="now" if deleted else None,
    )
    for key in keys:
        storage.objects[key] = b"bytes"
    store.add_face(media_id, 0.1, 0.1, 0.2, 0.2, np.ones(512))
    store.state.subjects[media_id] = [DnpSubject(subject_id, keys[4], keys[5])]
    store.add_region(media_id, 0.5, 0.5, 0.25, 0.25)
    msg_id = store.send({"job": "media_delete", "media_id": str(media_id)}) if send else None
    return media_id, keys, msg_id


def has_rows(store, media_id):
    state = store.state
    return media_id in state.faces and media_id in state.subjects and media_id in state.regions


def test_the_job_is_registered():
    assert "media_delete" in REGISTRY


def test_deletes_every_object_under_the_prefix_and_the_photos_rows():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage)
    worker = make_worker(store, storage)

    drain(worker)

    # The upload keys, the subject's file and thumbnail, and the stray version all go (D-130).
    assert not any(key in storage.objects for key in keys)
    assert sorted(storage.deletes) == sorted(keys)
    assert not has_rows(store, media_id)
    # The media row stays, with deleted_at, so its hash and Realtime's delete survive (D-130).
    assert store.state.media[media_id]["deleted_at"] == "now"
    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []


def test_a_neighbour_photo_sharing_a_leading_run_keeps_its_objects_and_rows():
    store, storage = FakeStore(), FakeStorage()
    media_id, _, _ = photo(store, storage)
    text = str(media_id)
    neighbour = UUID(text[:-1] + ("0" if text[-1] != "0" else "1"))
    _, neighbour_keys, _ = photo(store, storage, neighbour, deleted=False, send=False)

    drain(make_worker(store, storage))

    assert all(key in storage.objects for key in neighbour_keys)
    assert has_rows(store, neighbour)
    assert storage.lists == [f"{media_id}/"]


def test_reference_photos_under_users_survive_even_when_they_name_the_photo():
    store, storage = FakeStore(), FakeStorage()
    media_id, _, _ = photo(store, storage)
    reference = f"users/{uuid4()}/events/{uuid4()}/reference_{media_id}.jpg"
    avatar = f"users/{uuid4()}/avatar_{media_id}.jpg"
    storage.objects[reference] = storage.objects[avatar] = b"bytes"

    drain(make_worker(store, storage))

    assert reference in storage.objects
    assert avatar in storage.objects


def test_a_live_row_deletes_nothing_and_is_archived_on_the_first_try():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage, deleted=False)
    worker = make_worker(store, storage)

    drain(worker)

    assert all(key in storage.objects for key in keys)
    assert storage.deletes == []
    assert has_rows(store, media_id)
    assert store.state.archived[msg_id].read_ct == 1
    # The photo stays in the album: media_delete wrote nothing a viewer could see wrong (D-177).
    assert store.state.media[media_id]["processed_at"] == "earlier"
    assert [call["kind"] for call in worker.report.calls] == ["not_deleted"]


def test_a_gone_row_deletes_the_prefix_and_is_done():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage)
    # An event's hard delete took the row and, by cascade, its face, subject and region rows.
    for table in (
        store.state.media,
        store.state.faces,
        store.state.subjects,
        store.state.regions,
    ):
        del table[media_id]
    worker = make_worker(store, storage)

    drain(worker)

    assert not any(key in storage.objects for key in keys)
    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []


def test_an_unfinished_row_with_an_empty_prefix_deletes_its_rows_and_is_done():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage)
    for key in keys:
        del storage.objects[key]

    drain(make_worker(store, storage))

    assert storage.deletes == []
    assert not has_rows(store, media_id)
    assert msg_id not in store.state.messages
    assert store.state.archived == {}


def test_a_failed_row_delete_after_the_r2_deletes_finishes_on_the_retry():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage)
    store.faults["delete_media_rows"] = [RuntimeError("lost the row delete")]
    worker = make_worker(store, storage)

    worker.step()

    # The files went first, so the try that failed left only rows behind (arch §5).
    assert not any(key in storage.objects for key in keys)
    assert has_rows(store, media_id)
    assert store.state.messages[msg_id].read_ct == 1

    drain(worker)

    assert not has_rows(store, media_id)
    assert msg_id not in store.state.messages
    assert store.state.archived == {}


def test_an_r2_outage_costs_one_try_and_deletes_no_rows():
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)
    storage.delete_faults = [StorageUnavailable("R2 answered 503")]
    storage.probe_answers = [False, True]
    worker = make_worker(store, storage)

    worker.step()

    assert has_rows(store, media_id)
    assert storage.probes == 2
    assert not store.state.messages[msg_id].hidden

    drain(worker)

    assert not has_rows(store, media_id)
    assert store.state.archived == {}


def test_a_second_message_for_the_same_photo_is_a_no_op():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, first = photo(store, storage)
    second = store.send({"job": "media_delete", "media_id": str(media_id)})
    worker = make_worker(store, storage)

    drain(worker)

    assert sorted(storage.deletes) == sorted(keys)
    assert first not in store.state.messages
    assert second not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []


def test_three_failures_on_a_deleted_row_archive_it_and_keep_the_rows():
    store, storage = FakeStore(), FakeStorage()
    media_id, _, msg_id = photo(store, storage)
    store.state.messages[msg_id].read_ct = 2
    storage.delete_faults = [RuntimeError("refused")]
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id in store.state.archived
    assert has_rows(store, media_id)
    assert [call["kind"] for call in worker.report.calls] == ["failed"]


def test_three_failures_on_a_gone_row_archive_it_so_it_can_be_sent_again():
    store, storage = FakeStore(), FakeStorage()
    media_id, keys, msg_id = photo(store, storage)
    del store.state.media[media_id]
    store.state.messages[msg_id].read_ct = 2
    storage.delete_faults = [RuntimeError("refused")]
    worker = make_worker(store, storage)

    drain(worker)

    # Deleted as done, the files left under the prefix would stay with nothing to say so.
    assert msg_id in store.state.archived
    assert any(key in storage.objects for key in keys)
    assert [call["kind"] for call in worker.report.calls] == ["failed"]
