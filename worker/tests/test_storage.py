"""R2 errors sorted into missing, unavailable and everything else."""

import io

import boto3
import pytest
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError, IncompleteReadError
from botocore.response import StreamingBody
from botocore.stub import Stubber

from app.storage import PROBE_KEY, ObjectMissing, Storage, StorageUnavailable

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


def test_no_such_bucket_is_not_a_missing_photo(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "NoSuchBucket", http_status_code=404)
    with pytest.raises(ClientError):
        storage.read("a/upload.jpg")


def test_a_5xx_is_unavailable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "InternalError", http_status_code=500)
    with pytest.raises(StorageUnavailable):
        storage.read("a/upload.jpg")


def test_a_403_is_neither_missing_nor_unavailable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("get_object", "AccessDenied", http_status_code=403)
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


def test_the_probe_counts_a_404_as_reachable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error(
        "head_object",
        "404",
        http_status_code=404,
        expected_params={"Bucket": BUCKET, "Key": PROBE_KEY},
    )
    assert storage.reachable()


def test_the_probe_counts_a_5xx_as_unreachable(stubbed):
    storage, stubber, _ = stubbed
    stubber.add_client_error("head_object", "InternalError", http_status_code=503)
    assert not storage.reachable()


def test_the_probe_counts_no_connection_as_unreachable(stubbed, monkeypatch):
    storage, _, client = stubbed

    def refuse(**_kwargs):
        raise EndpointConnectionError(endpoint_url="https://account.r2.cloudflarestorage.com")

    monkeypatch.setattr(client, "head_object", refuse)
    assert not storage.reachable()
