"""python -m app.ai.fetch_model: buffalo_l.zip checked against worker/models.sha256 before
anything is unpacked, and not fetched again when the right file is already there (D-169)."""

import hashlib
import re
import zipfile

import pytest

from app.ai import fetch_model, model

MODEL_FILES = {
    model.DETECTION_FILE: b"detector",
    model.RECOGNITION_FILE: b"recognizer",
    "genderage.onnx": b"unused",
}


def make_zip(path, files=MODEL_FILES):
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def source(tmp_path):
    """A release zip somewhere else, and the hash models.sha256 would hold for it."""
    folder = tmp_path / "release"
    folder.mkdir()
    path = folder / "buffalo_l.zip"
    return path, make_zip(path)


@pytest.fixture
def root(tmp_path):
    return tmp_path / ".insightface" / "models"


class Downloads:
    def __init__(self, source_path):
        self.source_path = source_path
        self.urls = []

    def __call__(self, url, destination):
        self.urls.append(url)
        destination.write_bytes(self.source_path.read_bytes())


def test_the_committed_hash_file_holds_one_sha256_for_the_zip():
    expected = fetch_model.expected_hash()
    assert re.fullmatch(r"[0-9a-f]{64}", expected)


def test_a_fresh_machine_downloads_checks_and_unpacks(source, root):
    path, digest = source
    download = Downloads(path)

    assert fetch_model.fetch(root, digest, download) == "fetched"

    assert download.urls == [fetch_model.URL]
    assert (root / "buffalo_l" / model.DETECTION_FILE).read_bytes() == b"detector"
    assert (root / "buffalo_l" / model.RECOGNITION_FILE).read_bytes() == b"recognizer"
    assert sorted(p.name for p in root.iterdir()) == ["buffalo_l", "buffalo_l.zip"]


def test_a_wrong_hash_fails_and_unpacks_nothing(source, root):
    path, _digest = source
    download = Downloads(path)

    with pytest.raises(fetch_model.FetchError) as error:
        fetch_model.fetch(root, "0" * 64, download)

    assert "0" * 64 in str(error.value)
    assert not (root / "buffalo_l").exists()
    assert not (root / "buffalo_l.zip").exists()
    assert list(root.iterdir()) == []


def test_a_wrong_hash_leaves_a_working_model_alone(source, root):
    path, digest = source
    fetch_model.fetch(root, digest, Downloads(path))
    (root / "buffalo_l.zip").write_bytes(b"truncated")

    with pytest.raises(fetch_model.FetchError):
        fetch_model.fetch(root, "0" * 64, Downloads(path))

    assert (root / "buffalo_l" / model.DETECTION_FILE).read_bytes() == b"detector"


def test_the_right_file_already_there_is_not_fetched(source, root):
    path, digest = source
    fetch_model.fetch(root, digest, Downloads(path))

    download = Downloads(path)
    assert fetch_model.fetch(root, digest, download) == "present"
    assert download.urls == []


def test_the_right_zip_with_a_missing_model_file_unpacks_again_without_a_fetch(source, root):
    path, digest = source
    fetch_model.fetch(root, digest, Downloads(path))
    (root / "buffalo_l" / model.RECOGNITION_FILE).unlink()

    download = Downloads(path)
    assert fetch_model.fetch(root, digest, download) == "unpacked"
    assert download.urls == []
    assert (root / "buffalo_l" / model.RECOGNITION_FILE).read_bytes() == b"recognizer"


@pytest.mark.parametrize("damage", [b"recog", b"recognizeX"], ids=["truncated", "same size"])
def test_a_corrupt_model_file_unpacks_again_without_a_fetch(source, root, damage):
    path, digest = source
    fetch_model.fetch(root, digest, Downloads(path))
    (root / "buffalo_l" / model.RECOGNITION_FILE).write_bytes(damage)

    download = Downloads(path)
    assert fetch_model.fetch(root, digest, download) == "unpacked"
    assert download.urls == []
    assert (root / "buffalo_l" / model.RECOGNITION_FILE).read_bytes() == b"recognizer"
    assert sorted(p.name for p in root.iterdir()) == ["buffalo_l", "buffalo_l.zip"]


def test_a_download_slower_than_the_limit_fails(monkeypatch, tmp_path):
    class Trickle:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, size):
            return b"x"

    monkeypatch.setattr(fetch_model.urllib.request, "urlopen", lambda url, timeout: Trickle())
    clock = iter(range(0, 100_000, 100))
    monkeypatch.setattr(fetch_model.time, "monotonic", lambda: next(clock))

    with pytest.raises(fetch_model.FetchError, match="more than 600 s"):
        fetch_model.download(fetch_model.URL, tmp_path / "buffalo_l.zip.part")


def test_a_stale_zip_is_replaced(source, root):
    path, digest = source
    root.mkdir(parents=True)
    (root / "buffalo_l.zip").write_bytes(b"an older release")

    download = Downloads(path)
    assert fetch_model.fetch(root, digest, download) == "fetched"
    assert download.urls == [fetch_model.URL]
    assert (root / "buffalo_l.zip").read_bytes() == path.read_bytes()


def test_a_zip_without_both_model_files_unpacks_nothing(tmp_path, root):
    path = tmp_path / "short.zip"
    digest = make_zip(path, {model.DETECTION_FILE: b"detector"})

    with pytest.raises(fetch_model.FetchError) as error:
        fetch_model.fetch(root, digest, Downloads(path))

    assert model.RECOGNITION_FILE in str(error.value)
    assert not (root / "buffalo_l").exists()


def test_a_failed_download_leaves_no_partial_file(root):
    def broken(url, destination):
        destination.write_bytes(b"half")
        raise OSError("connection reset")

    with pytest.raises(OSError):
        fetch_model.fetch(root, "0" * 64, broken)
    assert list(root.iterdir()) == []


def test_main_exits_1_on_a_wrong_hash(monkeypatch, source, tmp_path, capsys):
    path, _digest = source
    monkeypatch.setattr(fetch_model, "models_root", lambda: tmp_path / "models")
    monkeypatch.setattr(fetch_model, "expected_hash", lambda: "0" * 64)
    monkeypatch.setattr(fetch_model, "download", Downloads(path))

    assert fetch_model.main() == 1
