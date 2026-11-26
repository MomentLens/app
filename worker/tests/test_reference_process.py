"""reference_process through the loop, over fakes (D-91, D-141, D-172, arch §5)."""

from uuid import uuid4

import pytest
from fakes import FakeStorage, FakeStore, drain, face_model, jpeg, make_worker

from app.ai import model
from app.jobs import REGISTRY

ONE = [[100, 60, 200, 210, 0.9]]
TWO = [[100, 60, 200, 210, 0.9], [250, 50, 330, 150, 0.8]]


@pytest.fixture
def faces_found(monkeypatch):
    """Sets the boxes the loaded model's detector finds."""

    def found(boxes):
        monkeypatch.setattr(model, "_loaded", face_model(boxes))

    return found


def reference(store, storage, **row):
    reference_id = store.add_reference(**row)
    storage.objects[store.state.references[reference_id]["photo_key"]] = jpeg(400, 300)
    msg_id = store.send({"job": "reference_process", "face_reference_id": str(reference_id)})
    return reference_id, msg_id


def test_the_job_is_registered():
    assert "reference_process" in REGISTRY


def test_one_face_accepts_the_reference_with_its_embedding(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    worker = make_worker(store, storage)

    drain(worker)

    row = store.state.references[reference_id]
    assert row["status"] == "accepted" and row["reject_reason"] is None
    assert len(row["embedding"]) == 512
    assert sum(v * v for v in row["embedding"]) == pytest.approx(1.0, abs=1e-5)
    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []


def test_no_face_rejects_it_as_no_face(faces_found):
    faces_found([])
    store, storage = FakeStore(), FakeStorage()
    reference_id, _ = reference(store, storage)

    drain(make_worker(store, storage))

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"], row["embedding"]) == ("rejected", "no_face", None)


def test_two_faces_reject_it_as_multiple_faces(faces_found):
    faces_found(TWO)
    store, storage = FakeStore(), FakeStorage()
    reference_id, _ = reference(store, storage)

    drain(make_worker(store, storage))

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"], row["embedding"]) == (
        "rejected",
        "multiple_faces",
        None,
    )


def test_a_second_face_below_the_detection_score_still_accepts(faces_found):
    faces_found([[100, 60, 200, 210, 0.9], [250, 50, 330, 150, 0.3]])
    store, storage = FakeStore(), FakeStorage()
    reference_id, _ = reference(store, storage)

    drain(make_worker(store, storage))

    assert store.state.references[reference_id]["status"] == "accepted"


def test_a_gone_row_deletes_the_message_as_done(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    msg_id = store.send({"job": "reference_process", "face_reference_id": str(uuid4())})
    worker = make_worker(store, storage)

    drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []
    assert storage.reads == []


@pytest.mark.parametrize("status,reason", [("accepted", None), ("rejected", "no_face")])
def test_a_decided_row_is_left_as_it_is(faces_found, status, reason):
    faces_found(TWO)
    store, storage = FakeStore(), FakeStorage()
    embedding = [0.0] * 512 if status == "accepted" else None
    reference_id, msg_id = reference(
        store, storage, status=status, reject_reason=reason, embedding=embedding
    )

    drain(make_worker(store, storage))

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"]) == (status, reason)
    assert msg_id not in store.state.messages and store.state.archived == {}


def test_a_missing_object_rejects_it_as_failed_on_the_first_try(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    storage.objects.clear()
    worker = make_worker(store, storage)

    drain(worker)

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"]) == ("rejected", "failed")
    assert store.state.archived[msg_id].read_ct == 1
    assert [c["kind"] for c in worker.report.calls] == ["missing_object"]


def test_the_third_failure_rejects_it_as_failed_in_the_archives_transaction(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    store.faults["decide_reference"] = [RuntimeError("write failed")] * 3
    worker = make_worker(store, storage)

    drain(worker)

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"]) == ("rejected", "failed")
    assert store.state.archived[msg_id].read_ct == 3
    assert [c["kind"] for c in worker.report.calls] == ["failed"]
    assert worker.report.calls[0]["reference_id"] == reference_id


def test_two_failures_then_a_success_accepts_it(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    store.faults["decide_reference"] = [RuntimeError("write failed")] * 2

    drain(make_worker(store, storage))

    assert store.state.references[reference_id]["status"] == "accepted"
    assert store.state.archived == {}


def test_a_failed_archive_leaves_the_reference_pending(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    storage.objects.clear()
    store.faults["archive_message"] = [RuntimeError("archive failed")]
    worker = make_worker(store, storage)

    with pytest.raises(RuntimeError):
        worker.step()

    assert store.state.references[reference_id]["status"] == "pending"
    assert store.state.archived == {}


def test_a_final_failure_whose_row_is_gone_deletes_the_message_as_done(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    store.faults["decide_reference"] = [RuntimeError("write failed")] * 3
    worker = make_worker(store, storage)
    worker.step()
    worker.step()
    del store.state.references[reference_id]

    drain(worker)

    assert msg_id not in store.state.messages
    assert store.state.archived == {} and worker.report.calls == []


def test_a_message_that_does_not_parse_but_names_a_reference_rejects_it_as_failed():
    store, storage = FakeStore(), FakeStorage()
    reference_id = store.add_reference()
    msg_id = store.send({"job": 7, "face_reference_id": str(reference_id)})

    drain(make_worker(store, storage))

    row = store.state.references[reference_id]
    assert (row["status"], row["reject_reason"]) == ("rejected", "failed")
    assert msg_id in store.state.archived


# --- S-25: an accepted reference sends reprocess (spec §4.11.4.5, D-141) -------------------


def test_an_accepted_reference_sends_reprocess_for_its_subject_in_its_event(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, _ = reference(store, storage)
    row = store.state.references[reference_id]
    worker = make_worker(store, storage, jobs={"reference_process": REGISTRY["reference_process"]})

    worker.step()

    (sent,) = store.state.messages.values()
    assert sent.body == {
        "job": "reprocess",
        "subject_id": str(row["subject_id"]),
        "event_id": str(row["event_id"]),
    }


@pytest.mark.parametrize("boxes", [[], TWO])
def test_a_rejected_reference_sends_nothing(faces_found, boxes):
    faces_found(boxes)
    store, storage = FakeStore(), FakeStorage()
    reference(store, storage)

    drain(make_worker(store, storage))

    assert store.state.messages == {} and store.state.archived == {}


def test_a_failed_send_leaves_the_reference_pending(faces_found):
    faces_found(ONE)
    store, storage = FakeStore(), FakeStorage()
    reference_id, msg_id = reference(store, storage)
    store.faults["enqueue_reprocess"] = [RuntimeError("send failed")]

    make_worker(store, storage).step()

    # The decision and the send commit together, or neither does.
    assert store.state.references[reference_id]["status"] == "pending"
    assert list(store.state.messages) == [msg_id]
