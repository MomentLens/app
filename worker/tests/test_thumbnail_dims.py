"""thumbnail_dims through the loop, over fakes (arch §5, D-72, D-122, D-123)."""

from uuid import uuid4

from fakes import FakeStorage, FakeStore, drain, jpeg, make_worker

from app.storage import ObjectMissing


def photo(store, storage, data=None, **row):
    """A finished upload with its file in R2 and its thumbnail_dims message on the queue."""
    media_id = store.add_media(**row)
    key = store.state.media[media_id]["upload_key"]
    storage.objects[key] = jpeg(400, 300) if data is None else data
    msg_id = store.send({"job": "thumbnail_dims", "media_id": str(media_id)})
    return media_id, msg_id


def test_publishes_with_the_public_keys_copied_from_the_row():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    worker = make_worker(store, storage)

    drain(worker)

    row = store.state.media[media_id]
    assert (row["width"], row["height"]) == (400, 300)
    assert row["public_key"] == row["upload_key"]
    assert row["public_thumb_key"] == row["upload_thumb_key"]
    assert row["variant_version"] == 1
    assert row["processed_at"] is not None
    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []


def test_the_jobs_log_lines_carry_the_loops_prefix(caplog):
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)

    with caplog.at_level("INFO", logger="momentlens.worker.jobs"):
        drain(make_worker(store, storage))

    prefix = f"job=thumbnail_dims msg_id={msg_id} media_id={media_id} try=1"
    assert [r.getMessage() for r in caplog.records if "published" in r.getMessage()] == [
        f"{prefix} published at 400x300, variant_version=1"
    ]


def test_reads_the_upload_key_from_the_row_and_builds_none():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, upload_key="written/by-the-api.jpg")

    drain(make_worker(store, storage))

    assert storage.reads == ["written/by-the-api.jpg"]
    assert store.state.media[media_id]["public_key"] == "written/by-the-api.jpg"


def test_processes_a_soft_deleted_row():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, deleted_at="yesterday")

    drain(make_worker(store, storage))

    assert store.state.media[media_id]["variant_version"] == 1


def test_stores_the_size_as_stored_and_ignores_the_orientation_tag():
    store, storage = FakeStore(), FakeStorage()
    media_id, _ = photo(store, storage, data=jpeg(400, 300, orientation=6))

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert (row["width"], row["height"]) == (400, 300)


def test_a_gone_row_is_deleted_as_done_with_no_archive_and_no_report():
    store, storage = FakeStore(), FakeStorage()
    msg_id = store.send({"job": "thumbnail_dims", "media_id": str(uuid4())})
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []
    assert storage.reads == []


def test_a_row_another_job_wrote_is_untouched_and_its_message_deleted():
    store, storage = FakeStore(), FakeStorage()
    written = {
        "variant_version": 2,
        "public_key": "x/public_v2.jpg",
        "public_thumb_key": "x/public_thumb_v2.webp",
        "processed_at": "earlier",
        "width": 10,
        "height": 20,
    }
    media_id, msg_id = photo(store, storage, **written)

    drain(make_worker(store, storage))

    row = store.state.media[media_id]
    assert {key: row[key] for key in written} == written
    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert storage.reads == []


def test_a_missing_upload_is_archived_on_the_first_try():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    storage.objects.clear()
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 1
    assert store.state.media[media_id]["variant_version"] == 0
    assert [call["kind"] for call in worker.report.calls] == ["missing_object"]


def test_a_decode_failure_writes_nothing_and_puts_the_message_back():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, data=b"not a jpeg")
    worker = make_worker(store, storage)

    assert worker.step()

    row = store.state.media[media_id]
    assert row["variant_version"] == 0 and row["width"] is None and row["processed_at"] is None
    message = store.state.messages[msg_id]
    assert message.read_ct == 1 and not message.hidden
    assert store.state.archived == {}


def test_the_third_failure_archives_and_clears_processed_at_when_it_was_set():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, data=b"not a jpeg", processed_at="earlier")
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 3
    assert store.state.media[media_id]["processed_at"] is None
    assert len(storage.reads) == 3
    assert [call["kind"] for call in worker.report.calls] == ["failed"]


def test_the_row_write_and_the_message_delete_commit_together():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    store.faults["delete_message"] = [RuntimeError("delete failed")]

    make_worker(store, storage).step()

    row = store.state.media[media_id]
    assert row["variant_version"] == 0 and row["width"] is None and row["processed_at"] is None
    assert not store.state.messages[msg_id].hidden


def test_a_final_failure_on_a_row_that_went_meanwhile_deletes_the_message_as_done():
    store = FakeStore()

    class VanishingStorage(FakeStorage):
        def read(self, key):
            store.state.media.clear()
            raise ObjectMissing(f"no object at {key}")

    storage = VanishingStorage()
    _, msg_id = photo(store, storage)
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {}
    assert worker.report.calls == []
