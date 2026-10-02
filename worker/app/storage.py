"""R2 for the worker: read an object, and tell a missing file apart from an outage.

The loop treats the two differently. A missing upload is archived on its first try, because a
retry cannot bring it back (D-123). An outage costs the try in flight, and the loop then waits
for R2 to answer before it reads the next message, so an outage costs one try, not three. R2
refusing the worker's key or bucket counts as an outage, so a wrong R2_* value holds the queue
instead of archiving every message it reaches (D-123).
"""

from __future__ import annotations

from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    HTTPClientError,
    IncompleteReadError,
)
from botocore.exceptions import (
    ConnectionError as BotoConnectionError,
)

from app.config import Settings

# Never written. A GET of it answers NoSuchKey while R2 is up and accepts the worker's key and
# bucket, which is all the probe asks. A HEAD would not do: its 404 has no body, so it cannot tell
# NoSuchKey from NoSuchBucket.
PROBE_KEY = "momentlens-worker-probe"

# What R2 answers when the worker's key is wrong or lacks access to the bucket.
_REFUSED = (401, 403)


class ObjectMissing(Exception):
    """The key is not in the bucket."""


class StorageUnavailable(Exception):
    """R2 did not answer, answered with a 5xx after boto's own retries, or refused the worker's
    key or bucket."""


class Storage:
    def __init__(self, client: Any, bucket: str) -> None:
        self._client = client
        self._bucket = bucket

    @classmethod
    def from_settings(cls, settings: Settings) -> Storage:
        client = boto3.client(
            "s3",
            endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            config=Config(
                # As apps/api/src/lib/r2.ts: R2 takes region auto, and checksums only where the
                # S3 API requires them.
                region_name="auto",
                signature_version="s3v4",
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                retries={"mode": "standard", "max_attempts": 3},
                connect_timeout=5,
                read_timeout=30,
            ),
        )
        return cls(client, settings.r2_bucket)

    def read(self, key: str) -> bytes:
        """The object's bytes. Raises ObjectMissing or StorageUnavailable, or boto's error."""
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
            with response["Body"] as body:
                return body.read()
        except (ClientError, BotoCoreError) as error:
            raise _classify(error, key) from error

    def reachable(self) -> bool:
        """True when R2 answers the probe with NoSuchKey or the object, so it is up and accepts
        the worker's key and bucket."""
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=PROBE_KEY)
            response["Body"].close()
        except ClientError as error:
            return _code(error) == "NoSuchKey"
        except BotoCoreError:
            return False
        return True


def _status(error: ClientError) -> int:
    return int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)


def _code(error: ClientError) -> str:
    return str(error.response.get("Error", {}).get("Code") or "")


def _classify(error: ClientError | BotoCoreError, key: str) -> Exception:
    if isinstance(error, ClientError):
        status, code = _status(error), _code(error)
        # NoSuchBucket is a 404 too. Only NoSuchKey says the file is missing.
        if code == "NoSuchKey":
            return ObjectMissing(f"no object at {key}")
        if code == "NoSuchBucket" or status in _REFUSED:
            return StorageUnavailable(
                f"R2 refused {key} with {status} {code}. Check the worker's R2_* settings (D-123)"
            )
        if status >= 500:
            return StorageUnavailable(f"R2 answered {status} for {key}")
        return error
    if isinstance(error, BotoConnectionError | HTTPClientError | IncompleteReadError):
        return StorageUnavailable(f"R2 did not answer for {key}: {error}")
    return error
