"""Fetches buffalo_l for the worker: `python -m app.ai.fetch_model`, run from worker/.

`scripts/provision.sh` and `scripts/deploy.sh` run it as the worker's user before the worker
starts, and a developer runs it once on their own machine. It downloads `buffalo_l.zip` from
InsightFace's `model-zoo` release, checks it against `worker/models.sha256` and unpacks it into
`~/.insightface/models/buffalo_l`, where app/ai/model.py loads it. A zip already there with the
right hash is not downloaded again (D-169).

Exit 0 when the model is in place, 1 when it is not.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import sys
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path

from app.ai.model import MODEL_FILES, missing_files, model_dir

URL = "https://github.com/deepinsight/insightface/releases/download/model-zoo/buffalo_l.zip"
ZIP_NAME = "buffalo_l.zip"
HASH_FILE = Path(__file__).resolve().parents[2] / "models.sha256"

log = logging.getLogger("momentlens.worker.fetch_model")


class FetchError(Exception):
    """The download is not the file models.sha256 names, or it lacks a model file."""


def expected_hash(path: Path = HASH_FILE) -> str:
    """The SHA-256 models.sha256 records for buffalo_l.zip, in `sha256sum` format."""
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == ZIP_NAME:
            return parts[0].lower()
    raise FetchError(f"{path} has no line for {ZIP_NAME}")


def models_root() -> Path:
    return model_dir().parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    # GitHub answers with a redirect to its file host, which urllib follows.
    with urllib.request.urlopen(url, timeout=60) as response, destination.open("wb") as file:
        shutil.copyfileobj(response, file, 1 << 20)


def _unpack(zip_path: Path, folder: Path) -> None:
    """Unpacks into a sibling folder, then swaps it in, so an interrupted unpack never leaves
    a folder the worker would load half of."""
    staging = folder.with_name(folder.name + ".unpacking")
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(staging)
    missing = missing_files(staging)
    if missing:
        shutil.rmtree(staging)
        raise FetchError(f"{zip_path} has no {' or '.join(missing)}")
    shutil.rmtree(folder, ignore_errors=True)
    staging.rename(folder)


def fetch(root: Path, expected: str, download: Callable[[str, Path], None] = download) -> str:
    """Puts buffalo_l under `root`. Returns "present", "unpacked" or "fetched"."""
    root.mkdir(parents=True, exist_ok=True)
    zip_path = root / ZIP_NAME
    folder = root / zip_path.stem

    if zip_path.is_file() and sha256(zip_path) == expected:
        if not missing_files(folder):
            return "present"
        _unpack(zip_path, folder)
        return "unpacked"

    partial = root / (ZIP_NAME + ".part")
    try:
        log.info("downloading %s", URL)
        download(URL, partial)
        actual = sha256(partial)
        if actual != expected:
            raise FetchError(
                f"{URL} has SHA-256 {actual}, but worker/models.sha256 expects {expected}. "
                "Nothing was unpacked. If InsightFace replaced the file, D-169 says to reopen."
            )
        # Check the contents before the zip replaces anything, so a bad release leaves a
        # working model where it is.
        with zipfile.ZipFile(partial) as archive:
            missing = [name for name in MODEL_FILES if name not in archive.namelist()]
        if missing:
            raise FetchError(f"{URL} has no {' or '.join(missing)}")
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(zip_path)
    _unpack(zip_path, folder)
    return "fetched"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    root = models_root()
    try:
        result = fetch(root, expected_hash(), download)
    except (FetchError, OSError) as error:
        log.error("buffalo_l is not in place: %s", error)
        return 1
    folder = root / Path(ZIP_NAME).stem
    if result == "present":
        log.info("buffalo_l is already in %s with the right hash, nothing fetched", folder)
    else:
        log.info("buffalo_l %s into %s", result, folder)
    return 0


if __name__ == "__main__":
    sys.exit(main())
