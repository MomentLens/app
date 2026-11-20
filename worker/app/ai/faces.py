"""Detect faces once and embed each one (arch §5, arch §6, D-66, D-99).

`detect()` is the one detection pass a photo gets. reference_process counts its result, and from
S-21 face_process stores it as `face` rows. Detection is never run again on the same photo,
`reprocess` included, so the box comes back with every embedding.

The image is read as stored. Stage 1 on the phone already turned it upright and stripped its EXIF,
so nothing here applies an orientation (D-99, D-172).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from insightface.utils import face_align

from app.ai.model import FaceModel, get_model

# arch §6: SCRFD's default score, with no minimum face size. A detector setting, not a similarity
# threshold; S-26 checks it on its photos (D-172). The detector already drops faces under its own
# det_thresh, which is the same 0.5 in buffalo_l; this filter keeps arch §6's value in one place.
DETECTION_SCORE = 0.5


@dataclass(frozen=True)
class DetectedFace:
    # The detector's box as fractions of the stored image's width and height, clamped into it, so
    # x + width and y + height never pass 1 (face_box_check).
    x: float
    y: float
    width: float
    height: float
    score: float
    # 512 float32 values of length 1, so a dot product of two is their cosine similarity.
    embedding: np.ndarray


def detect(
    image: np.ndarray, model: FaceModel | None = None, *, min_score: float = DETECTION_SCORE
) -> list[DetectedFace]:
    """Every face in `image` (BGR, as app.images.decode returns it) scoring at least `min_score`,
    in the detector's order, each with its embedding."""
    model = model if model is not None else get_model()
    boxes, landmarks = model.detector.detect(image, max_num=0, metric="default")
    height, width = image.shape[:2]

    kept: list[tuple[tuple[float, float, float, float], float, np.ndarray]] = []
    for i, (x1, y1, x2, y2, score) in enumerate(boxes):
        if score < min_score:
            continue
        box = _fractions(float(x1), float(y1), float(x2), float(y2), width, height)
        if box is None:
            continue
        kept.append((box, float(score), landmarks[i]))
    if not kept:
        return []

    # ArcFace takes faces aligned on their five landmarks, at its own input size (112px).
    size = model.recognizer.input_size[0]
    crops = [face_align.norm_crop(image, landmark=kps, image_size=size) for _, _, kps in kept]
    embeddings = np.asarray(model.recognizer.get_feat(crops), np.float32).reshape(len(crops), -1)
    embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)

    return [
        DetectedFace(x, y, w, h, score, embedding)
        for ((x, y, w, h), score, _), embedding in zip(kept, embeddings, strict=True)
    ]


def _fractions(
    x1: float, y1: float, x2: float, y2: float, width: int, height: int
) -> tuple[float, float, float, float] | None:
    """The box clamped into the image, as fractions. None when nothing of it is inside."""
    left, right = _clamp(x1 / width), _clamp(x2 / width)
    top, bottom = _clamp(y1 / height), _clamp(y2 / height)
    if right <= left or bottom <= top:
        return None
    # Subtracting and adding back can land a hair past 1 in floating point.
    return left, top, min(right - left, 1.0 - left), min(bottom - top, 1.0 - top)


def _clamp(value: float) -> float:
    return min(max(value, 0.0), 1.0)
