"""The loop's order, tries, lock, failure path and stop, over fakes (arch §5, D-103, D-123)."""

import threading
from uuid import uuid4

import pytest
from fakes import Crash, FakeStorage, FakeStore, drain, jpeg, make_worker

from app.db import DatabaseUnavailable
from app.jobs import REGISTRY, thumbnail_dims
from app.jobs.base import Job
from app.storage import StorageUnavailable


def photo(store, storage, data=None, **row):
    media_id = store.add_media(**row)
    storage.objects[store.state.media[media_id]["upload_key"]] = (
        jpeg(400, 300) if data is None else data
    )
    msg_id = store.send({"job": "thumbnail_dims", "media_id": str(media_id)})
    return media_id, msg_id


def test_a_failed_message_runs_again_before_a_newer_one():
    store, storage = FakeStore(), FakeStorage()
    first, _ = photo(store, storage, data=[b"not a jpeg", jpeg(400, 300)])
    second, _ = photo(store, storage)

    drain(make_worker(store, storage))

    key = {m: store.state.media[m]["upload_key"] for m in (first, second)}
    assert storage.reads == [key[first], key[first], key[second]]
    assert store.state.media[first]["variant_version"] == 1
    assert store.state.media[second]["variant_version"] == 1


def test_a_crash_counts_as_a_try():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    storage.read_faults = [Crash()]

    with pytest.raises(Crash):
        make_worker(store, storage).step()
    # The process is gone, and its session and lock with it. The message stays hidden.
    store.close()
    assert store.state.messages[msg_id].hidden

    restarted = FakeStore(shared=store)
    drain(make_worker(restarted, storage))

    assert store.state.media[media_id]["variant_version"] == 1
    assert msg_id not in store.state.messages
    assert len(storage.reads) == 2


def test_a_message_three_crashes_hid_is_archived_without_running():
    store, storage = FakeStore(), FakeStorage()
    media_id = store.add_media(processed_at="earlier")
    msg_id = store.send(
        {"job": "thumbnail_dims", "media_id": str(media_id)}, read_ct=3, hidden=True
    )
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 4
    assert store.state.media[media_id]["processed_at"] is None
    assert storage.reads == []
    assert [call["kind"] for call in worker.report.calls] == ["stopped"]


def test_startup_leaves_a_delayed_message_hidden():
    store = FakeStore()
    msg_id = store.send({"job": "thumbnail_dims", "media_id": str(uuid4())}, hidden=True)

    drain(make_worker(store))

    assert store.state.messages[msg_id].hidden
    assert store.state.messages[msg_id].read_ct == 0


def test_a_second_worker_cannot_take_the_lock():
    store, storage = FakeStore(), FakeStorage()
    first = make_worker(store, storage)
    assert not first.step()  # takes the lock, finds the queue empty
    assert store.locked

    other_store = FakeStore(shared=store)
    second = make_worker(other_store, storage)
    _, msg_id = photo(store, storage)

    assert not second.step()
    assert not other_store.locked
    assert store.state.messages[msg_id].read_ct == 0

    store.close()
    drain(second)
    assert other_store.locked
    assert msg_id not in store.state.messages


def test_a_lost_connection_reconnects_takes_the_lock_and_counts_the_try():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    store.faults["media_for_job"] = [DatabaseUnavailable("server closed the connection")]
    worker = make_worker(store, storage)

    assert not worker.step()
    assert not store.locked and not store.connected
    assert store.state.messages[msg_id].hidden

    drain(worker)

    assert store.connects == 2
    assert store.state.media[media_id]["variant_version"] == 1
    assert len(storage.reads) == 1  # the first try died before it read R2


def test_a_lost_connection_while_connecting_is_waited_out():
    store = FakeStore()
    store.faults["connect"] = [DatabaseUnavailable("no route"), DatabaseUnavailable("no route")]
    worker = make_worker(store)

    assert not worker.step()
    assert not worker.step()
    assert not worker.step()

    assert store.locked


def test_an_r2_outage_costs_one_try_and_holds_the_queue_until_r2_answers():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage)
    storage.read_faults = [StorageUnavailable("R2 did not answer")]
    storage.probe_answers = [False, False, True]
    worker = make_worker(store, storage)

    assert worker.step()

    assert storage.probes == 3
    message = store.state.messages[msg_id]
    assert message.read_ct == 1 and not message.hidden
    assert store.state.media[media_id]["variant_version"] == 0

    drain(worker)
    assert store.state.media[media_id]["variant_version"] == 1
    assert store.state.archived == {}


def test_the_archive_and_the_unpublish_commit_together():
    store, storage = FakeStore(), FakeStorage()
    media_id, msg_id = photo(store, storage, data=b"not a jpeg", processed_at="earlier")
    store.state.messages[msg_id].read_ct = 2
    store.faults["archive_message"] = [RuntimeError("archive failed")]

    with pytest.raises(RuntimeError):
        make_worker(store, storage).step()

    assert store.state.media[media_id]["processed_at"] == "earlier"
    assert msg_id in store.state.messages
    assert store.state.archived == {}


def test_stop_lets_the_job_in_progress_finish_and_reads_nothing_more():
    store, storage = FakeStore(), FakeStorage()
    first, first_msg = photo(store, storage)
    _, second_msg = photo(store, storage)
    stop = threading.Event()

    def stop_midway(ctx, message):
        stop.set()  # SIGTERM arrives while this job runs
        thumbnail_dims.run(ctx, message)

    jobs = {"thumbnail_dims": Job("thumbnail_dims", thumbnail_dims.Message, stop_midway)}
    make_worker(store, storage, jobs=jobs, stop=stop).run()

    assert store.state.media[first]["variant_version"] == 1
    assert first_msg not in store.state.messages
    assert store.state.messages[second_msg].read_ct == 0


@pytest.mark.parametrize(
    "body",
    [
        "a string",
        ["a", "list"],
        {"media_id": "4b3c1d7e-2f7a-4f43-8d1b-0a8b6c5e9f10"},
        {"job": 7},
        {"job": "thumbnail_dims", "media_id": "not-a-uuid"},
        {"job": "thumbnail_dims"},
    ],
)
def test_a_message_that_does_not_parse_is_archived_on_the_first_try(body):
    store, storage = FakeStore(), FakeStorage()
    msg_id = store.send(body)
    worker = make_worker(store, storage)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 1
    assert [call["kind"] for call in worker.report.calls] == ["malformed"]
    assert storage.reads == []


def test_a_message_that_does_not_parse_but_names_a_photo_unpublishes_it():
    store = FakeStore()
    media_id = store.add_media(processed_at="earlier")
    msg_id = store.send({"media_id": str(media_id)})

    drain(make_worker(store))

    assert msg_id in store.state.archived
    assert store.state.media[media_id]["processed_at"] is None


def test_an_unknown_job_is_archived_on_the_first_try_and_unpublishes_its_photo():
    store = FakeStore()
    media_id = store.add_media(processed_at="earlier")
    msg_id = store.send({"job": "face_process", "media_id": str(media_id)})
    worker = make_worker(store)

    drain(worker)

    assert store.state.archived[msg_id].read_ct == 1
    assert store.state.media[media_id]["processed_at"] is None
    assert [call["kind"] for call in worker.report.calls] == ["unknown_job"]


def test_an_unknown_job_is_archived_even_when_its_row_is_gone():
    store = FakeStore()
    msg_id = store.send({"job": "face_process", "media_id": str(uuid4())})

    drain(make_worker(store))

    assert msg_id in store.state.archived


def test_registry_names_match_their_message_models():
    assert "thumbnail_dims" in REGISTRY
    for name, job in REGISTRY.items():
        assert job.name == name
        assert job.message.model_validate({"job": name, "media_id": str(uuid4())}).job == name
