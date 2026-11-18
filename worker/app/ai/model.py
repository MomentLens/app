"""InsightFace buffalo_l, loaded once at startup and kept resident (D-40, D-92).

`main.py` calls `load()` before the loop starts, so `/health` stays 503 until the model is loaded
and warm. Jobs call `get_model()`. The worker never downloads the model: `scripts/deploy.sh` and
`scripts/provision.sh` fetch it with `python -m app.ai.fetch_model`, and a developer runs that
once on their own machine (D-169).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from insightface.model_zoo import model_zoo

log = logging.getLogger("momentlens.worker.model")

# The two buffalo_l files the worker uses. The pack's other three (landmarks, gender and age)
# are never opened (D-92).
DETECTION_FILE = "det_10g.onnx"
RECOGNITION_FILE = "w600k_r50.onnx"
MODEL_FILES = (DETECTION_FILE, RECOGNITION_FILE)

# arch §5: two intra_op threads leave the rest of the CPU to Express, Postgres and nginx
# (D-165, D-166).
INTRA_OP_THREADS = 2
# The detector's input size, the one P0-5 measured (worker/bench/benchmark.py).
DETECTION_SIZE = (640, 640)


class ModelMissingError(Exception):
    """A model file is not on disk. The worker exits rather than download it (D-169)."""


class ModelNotLoadedError(Exception):
    """A job asked for the model before startup loaded it."""


@dataclass(frozen=True)
class FaceModel:
    # insightface.model_zoo's SCRFD: detect(img, max_num=0, metric="default") returns
    # (bboxes, keypoints) in the pixels of the image given.
    detector: Any
    # insightface.model_zoo's ArcFaceONNX: get_feat(aligned crops) returns one 512-float
    # embedding per crop. Align each face with insightface.utils.face_align.norm_crop first.
    recognizer: Any


_loaded: FaceModel | None = None


def model_dir() -> Path:
    """`.insightface/models/buffalo_l` under the home of the user running the worker, which is
    /var/lib/momentlens on the server (arch §5)."""
    return Path.home() / ".insightface" / "models" / "buffalo_l"


def missing_files(folder: Path) -> list[str]:
    return [name for name in MODEL_FILES if not (folder / name).is_file()]


def _open(path: Path) -> Any:
    options = ort.SessionOptions()
    options.intra_op_num_threads = INTRA_OP_THREADS
    # A path to an .onnx file never reaches InsightFace's download code, which only runs for a
    # model name or with download=True.
    return model_zoo.get_model(str(path), providers=["CPUExecutionProvider"], sess_options=options)


def load(folder: Path | None = None) -> FaceModel:
    """Opens both files, runs each once on a blank image, and keeps the result for get_model().

    Raises ModelMissingError, naming the files, when either is not on disk. A file that is there
    but does not open raises ONNX Runtime's own error. Either way nothing is kept.
    """
    global _loaded
    folder = folder if folder is not None else model_dir()
    missing = missing_files(folder)
    if missing:
        raise ModelMissingError(
            f"{folder} has no {' or '.join(missing)}. Run `python -m app.ai.fetch_model` from "
            "worker/ to fetch buffalo_l (D-169)"
        )

    started = time.monotonic()
    detector = _open(folder / DETECTION_FILE)
    detector.prepare(0, input_size=DETECTION_SIZE)
    recognizer = _open(folder / RECOGNITION_FILE)
    recognizer.prepare(0)

    # One inference each, so the first real job pays no warm-up (D-169).
    detector.detect(np.zeros((*DETECTION_SIZE, 3), np.uint8), max_num=0, metric="default")
    width, height = recognizer.input_size
    recognizer.get_feat([np.zeros((height, width, 3), np.uint8)])

    _loaded = FaceModel(detector=detector, recognizer=recognizer)
    log.info(
        "buffalo_l loaded and warm from %s in %.1f s, %d threads",
        folder,
        time.monotonic() - started,
        INTRA_OP_THREADS,
    )
    return _loaded


def get_model() -> FaceModel:
    """The model startup loaded. Raises before then; nothing here loads it late."""
    if _loaded is None:
        raise ModelNotLoadedError("the InsightFace model is not loaded; main.py loads it at start")
    return _loaded
