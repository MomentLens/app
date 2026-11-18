"""The InsightFace model: loaded once at startup from the folder deploy fills, never downloaded,
warmed up before the loop starts (D-40, D-169)."""

import numpy as np
import pytest
from insightface.model_zoo import model_zoo
from insightface.utils import storage

from app.ai import model

DETECTOR = model.DETECTION_FILE
RECOGNIZER = model.RECOGNITION_FILE


class FakeDetector:
    def __init__(self):
        self.prepared = None
        self.detected = []

    def prepare(self, ctx_id, **kwargs):
        self.prepared = (ctx_id, kwargs)

    def detect(self, img, **kwargs):
        self.detected.append(img.shape)
        return np.zeros((0, 5)), None


class FakeRecognizer:
    input_size = (112, 112)

    def __init__(self):
        self.prepared = None
        self.embedded = []

    def prepare(self, ctx_id, **kwargs):
        self.prepared = ctx_id

    def get_feat(self, imgs):
        self.embedded.append([img.shape for img in imgs])
        return np.zeros((len(imgs), 512), np.float32)


@pytest.fixture(autouse=True)
def nothing_loaded(monkeypatch):
    monkeypatch.setattr(model, "_loaded", None)


@pytest.fixture
def no_download(monkeypatch):
    """Any download InsightFace could start fails the test."""

    def refuse(*args, **kwargs):
        raise AssertionError(f"a download was attempted: {args}")

    monkeypatch.setattr(storage, "download_file", refuse)
    monkeypatch.setattr(model_zoo, "download_onnx", refuse)


@pytest.fixture
def opened(monkeypatch):
    """Replaces ONNX Runtime with fakes and records each file opened and its arguments."""
    calls = []
    fakes = {DETECTOR: FakeDetector(), RECOGNIZER: FakeRecognizer()}

    def fake_get_model(name, **kwargs):
        calls.append((name, kwargs))
        return fakes[name.replace("\\", "/").rsplit("/", 1)[-1]]

    monkeypatch.setattr(model.model_zoo, "get_model", fake_get_model)
    return calls, fakes


def model_folder(tmp_path, *files):
    folder = tmp_path / "buffalo_l"
    folder.mkdir()
    for name in files:
        (folder / name).write_bytes(b"onnx")
    return folder


def test_get_model_before_the_load_raises():
    with pytest.raises(model.ModelNotLoadedError):
        model.get_model()


@pytest.mark.parametrize("missing", [DETECTOR, RECOGNIZER])
def test_a_missing_file_stops_the_load_without_a_download(tmp_path, missing, opened, no_download):
    present = DETECTOR if missing == RECOGNIZER else RECOGNIZER
    folder = model_folder(tmp_path, present)

    with pytest.raises(model.ModelMissingError) as error:
        model.load(folder)

    assert missing in str(error.value)
    assert "fetch_model" in str(error.value)
    assert opened[0] == []
    with pytest.raises(model.ModelNotLoadedError):
        model.get_model()


def test_an_empty_folder_names_both_files(tmp_path, opened, no_download):
    with pytest.raises(model.ModelMissingError) as error:
        model.load(tmp_path / "buffalo_l")
    assert DETECTOR in str(error.value) and RECOGNIZER in str(error.value)


def test_the_load_opens_only_the_two_files_on_two_threads(tmp_path, opened, no_download):
    folder = model_folder(tmp_path, DETECTOR, RECOGNIZER, "1k3d68.onnx", "genderage.onnx")
    calls, _fakes = opened

    model.load(folder)

    assert sorted(name.replace("\\", "/").rsplit("/", 1)[-1] for name, _ in calls) == [
        DETECTOR,
        RECOGNIZER,
    ]
    for _name, kwargs in calls:
        assert kwargs["providers"] == ["CPUExecutionProvider"]
        assert kwargs["sess_options"].intra_op_num_threads == 2
        assert not kwargs.get("download")


def test_the_load_warms_up_both_models_before_returning(tmp_path, opened, no_download):
    folder = model_folder(tmp_path, DETECTOR, RECOGNIZER)
    _calls, fakes = opened

    loaded = model.load(folder)

    assert model.get_model() is loaded
    assert loaded.detector is fakes[DETECTOR] and loaded.recognizer is fakes[RECOGNIZER]
    assert fakes[DETECTOR].prepared == (0, {"input_size": (640, 640)})
    assert fakes[DETECTOR].detected == [(640, 640, 3)]
    assert fakes[RECOGNIZER].embedded == [[(112, 112, 3)]]


def test_a_file_that_does_not_open_leaves_nothing_loaded(tmp_path, monkeypatch, no_download):
    folder = model_folder(tmp_path, DETECTOR, RECOGNIZER)

    def corrupt(name, **kwargs):
        raise RuntimeError("[ONNXRuntimeError] : 7 : INVALID_PROTOBUF")

    monkeypatch.setattr(model.model_zoo, "get_model", corrupt)
    with pytest.raises(RuntimeError):
        model.load(folder)
    with pytest.raises(model.ModelNotLoadedError):
        model.get_model()


@pytest.mark.skipif(
    not all((model.model_dir() / name).is_file() for name in (DETECTOR, RECOGNIZER)),
    reason="buffalo_l is not on this machine; run python -m app.ai.fetch_model",
)
def test_the_real_model_loads_and_embeds(no_download):
    loaded = model.load()
    bboxes, _kpss = loaded.detector.detect(
        np.zeros((640, 640, 3), np.uint8), max_num=0, metric="default"
    )
    assert bboxes.shape[0] == 0
    size = loaded.recognizer.input_size
    embedding = loaded.recognizer.get_feat([np.zeros((size[1], size[0], 3), np.uint8)])
    assert embedding.shape == (1, 512)
