"""R2 errors sorted into missing, unavailable and everything else."""

import io
from uuid import UUID

import boto3
import pytest
from botocore.config import Config
from botocore.exceptions import (
    ClientError,
    EndpointConnectionError,
    IncompleteReadError,
    ResponseStreamingError,
)
from botocore.response import StreamingBody
from botocore.stub import Stubber

from app import storage as storage_module
from app.storage import PROBE_KEY, ObjectMissing, Storage, StorageUnavailable, media_prefix

BUCKET = "momentlens-test"


@pytest.fixture
def stubbed():
    # Placeholder credentials: the stubber answers every call, and nothing leaves the process.
    client = boto3.client(
        "s3",
        endpoint_url="https://account.r2.cloudflarestorage.com",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        config=Config(region_name="auto", retries={"max_attempts": 1}),
    )
    with Stubber(client) as stubber:
        yield Storage(client, BUCKET), stubber, client
        stubber.assert_no_pending_responses()


def body(data):
    return StreamingBody(io.BytesIO(data), len(data))


def test_read_returns_the_bytes(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response(
        "get_object", {"Body": body(b"jpeg bytes")}, {"Bucket": BUCKET, "Key": "a/upload.jpg"}
    )
    assert storage.read("a/upload.jpg") == b"jpeg bytes"


def test_no_such_key_is_missing(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "NoSuchKey", http_status_code=404)
    with pytest.raises(ObjectMissing):
        storage.read("a/upload.jpg")


def test_no_such_bucket_is_an_outage_not_a_missing_photo(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "NoSuchBucket", http_status_code=404)
    with pytest.raises(StorageUnavailable, match="R2_"):
        storage.read("a/upload.jpg")


def test_a_5xx_is_unavailable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "InternalError", http_status_code=500)
    with pytest.raises(StorageUnavailable):
        storage.read("a/upload.jpg")


@pytest.mark.parametrize(("status", "code"), [(401, "Unauthorized"), (403, "AccessDenied")])
def test_a_refused_key_is_an_outage(stubbed, status, code):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", code, http_status_code=status)
    with pytest.raises(StorageUnavailable, match="R2_"):
        storage.read("a/upload.jpg")


def test_another_4xx_is_an_ordinary_failure(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "InvalidRange", http_status_code=416)
    with pytest.raises(ClientError):
        storage.read("a/upload.jpg")


def test_no_connection_is_unavailable(stubbed, monkeypatch):
    storage, _, client = stubbed

    def refuse(**_kwargs):
        raise EndpointConnectionError(endpoint_url="https://account.r2.cloudflarestorage.com")

    monkeypatch.setattr(client, "get_object", refuse)
    with pytest.raises(StorageUnavailable):
        storage.read("a/upload.jpg")


def test_a_body_cut_short_is_unavailable(stubbed, monkeypatch):
    storage, _, client = stubbed

    class ShortBody(io.BytesIO):
        def read(self, *_args):
            raise IncompleteReadError(actual_bytes=1, expected_bytes=2)

    monkeypatch.setattr(client, "get_object", lambda **_kwargs: {"Body": ShortBody()})
    with pytest.raises(StorageUnavailable):
        storage.read("a/upload.jpg")


def test_a_connection_reset_mid_body_is_unavailable(stubbed, monkeypatch):
    storage, _, client = stubbed

    class ResetBody(io.BytesIO):
        def read(self, *_args):
            raise ResponseStreamingError(error=ConnectionResetError("reset by peer"))

    monkeypatch.setattr(client, "get_object", lambda **_kwargs: {"Body": ResetBody()})
    with pytest.raises(StorageUnavailable):
        storage.read("a/upload.jpg")


def test_the_probe_counts_no_such_key_as_reachable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error(
        "get_object",
        "NoSuchKey",
        http_status_code=404,
        expected_params={"Bucket": BUCKET, "Key": PROBE_KEY},
    )
    assert storage.reachable()


def test_the_probe_counts_an_object_at_its_key_as_reachable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response("get_object", {"Body": body(b"")}, {"Bucket": BUCKET, "Key": PROBE_KEY})
    assert storage.reachable()


@pytest.mark.parametrize(
    ("status", "code"),
    [(503, "InternalError"), (401, "Unauthorized"), (403, "AccessDenied"), (404, "NoSuchBucket")],
)
def test_the_probe_counts_a_5xx_or_a_refusal_as_unreachable(stubbed, status, code):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", code, http_status_code=status)
    assert not storage.reachable()


def test_the_probe_counts_no_connection_as_unreachable(stubbed, monkeypatch):
    storage, _, client = stubbed

    def refuse(**_kwargs):
        raise EndpointConnectionError(endpoint_url="https://account.r2.cloudflarestorage.com")

    monkeypatch.setattr(client, "get_object", refuse)
    assert not storage.reachable()


def test_put_sends_the_bytes_and_their_type(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response(
        "put_object",
        {},
        {"Bucket": BUCKET, "Key": "a/public_v2.jpg", "Body": b"jpeg", "ContentType": "image/jpeg"},
    )
    storage.put("a/public_v2.jpg", b"jpeg", "image/jpeg")


def test_put_answered_with_a_5xx_is_unavailable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("put_object", "InternalError", http_status_code=503)
    with pytest.raises(StorageUnavailable):
        storage.put("a/public_v2.jpg", b"jpeg", "image/jpeg")


def test_put_refused_is_an_outage(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("put_object", "AccessDenied", http_status_code=403)
    with pytest.raises(StorageUnavailable, match="R2_"):
        storage.put("a/public_v2.jpg", b"jpeg", "image/jpeg")


def test_delete_names_the_key(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response("delete_object", {}, {"Bucket": BUCKET, "Key": "a/public_v1.jpg"})
    storage.delete("a/public_v1.jpg")


def test_delete_answered_with_a_5xx_is_unavailable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("delete_object", "InternalError", http_status_code=500)
    with pytest.raises(StorageUnavailable):
        storage.delete("a/public_v1.jpg")


def test_the_worker_builds_its_keys_with_forward_slashes_on_every_platform():
    media_id = UUID("6f1c2a52-0d3e-4c55-9b51-0b8e9d1f2a33")
    assert storage_module.public_key(media_id, 4) == f"{media_id}/public_v4.jpg"
    assert storage_module.public_thumb_key(media_id, 4) == f"{media_id}/public_thumb_v4.webp"


def test_subject_keys_carry_the_photo_the_subject_and_the_version():
    media_id = UUID("6f1c2e9a-0b7d-4c3e-9a51-2d8e4f6a7b10")
    subject_id = UUID("0d4e8b2a-7c1f-4a6e-b3d9-5e2f1a8c4b70")
    assert storage_module.subject_key(media_id, subject_id, 3) == f"{media_id}/{subject_id}_v3.jpg"
    assert (
        storage_module.subject_thumb_key(media_id, subject_id, 3)
        == f"{media_id}/{subject_id}_thumb_v3.webp"
    )


def test_list_follows_every_page(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response(
        "list_objects_v2",
        {
            "Contents": [{"Key": "a/upload.jpg"}, {"Key": "a/upload_thumb.webp"}],
            "IsTruncated": True,
            "NextContinuationToken": "page-2",
        },
        {"Bucket": BUCKET, "Prefix": "a/"},
    )
    stubber.add_response(
        "list_objects_v2",
        {"Contents": [{"Key": "a/public_v1.jpg"}], "IsTruncated": False},
        {"Bucket": BUCKET, "Prefix": "a/", "ContinuationToken": "page-2"},
    )
    assert storage.list("a/") == ["a/upload.jpg", "a/upload_thumb.webp", "a/public_v1.jpg"]


def test_list_of_an_empty_prefix_is_empty(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response(
        "list_objects_v2", {"IsTruncated": False}, {"Bucket": BUCKET, "Prefix": "a/"}
    )
    assert storage.list("a/") == []


@pytest.mark.parametrize(("status", "code"), [(403, "AccessDenied"), (404, "NoSuchBucket")])
def test_list_refused_is_an_outage(stubbed, status, code):
    storage, stubber, _ = stubbed
    stubber.add_client_error("list_objects_v2", code, http_status_code=status)
    with pytest.raises(StorageUnavailable):
        storage.list("a/")


def test_the_media_prefix_ends_at_the_photos_own_folder():
    # The slash keeps out every key of a photo whose id starts with this one's.
    media_id = UUID("6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e")
    assert media_prefix(media_id) == "6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e/"


def test_a_truncated_list_with_no_next_page_fails_the_try(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_response(
        "list_objects_v2",
        {"Contents": [{"Key": "a/upload.jpg"}], "IsTruncated": True},
        {"Bucket": BUCKET, "Prefix": "a/"},
    )
    # A partial list would let media_delete finish and leave the rest of the prefix (D-177).
    with pytest.raises(RuntimeError):
        storage.list("a/")
