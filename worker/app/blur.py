"""Blurring part of a photo, and the files the worker cuts from the result (D-65, D-171).

Every file the worker writes for a photo comes through here, so every regeneration blurs at the
same strength (root invariant 6). The strength is set by the area's shorter side: shrink the area
until that side is 8 pixels, scale it back up, then box-blur with a kernel one cell wide, where a
cell is the shorter side divided by 8. Shrinking with area averaging throws the detail away,
which a light Gaussian pass would not (D-65).

A blur region covers exactly the rectangle drawn, rounded outward to whole pixels. Its fractions
are of the stored image, read as stored with no orientation applied (D-99). S-21 adds the face
box's 30 to 40% expansion and the elliptical mask on top of `blur_area`.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Protocol

import numpy as np

from app.images import cv2

# Cells across the blurred area's shorter side (D-171).
CELLS = 8
JPEG_QUALITY = 90
WEBP_QUALITY = 80
# The thumbnail's long edge, as the client thumbnail's.
THUMB_EDGE = 300


class Fractions(Protocol):
    """A rectangle as fractions of the image: a manual_blur_region row or, from S-21, a face."""

    x: float
    y: float
    width: float
    height: float


class EncodeError(Exception):
    """OpenCV could not encode the output."""


def pixel_rect(rect: Fractions, width: int, height: int) -> tuple[int, int, int, int]:
    """The rectangle in pixels as (x0, y0, x1, y1), end exclusive, rounded outward and clamped.

    A rectangle thinner than a pixel still covers one, so nothing drawn is ever left out.
    """
    x0 = min(max(0, math.floor(rect.x * width)), width - 1)
    y0 = min(max(0, math.floor(rect.y * height)), height - 1)
    x1 = min(width, max(math.ceil((rect.x + rect.width) * width), x0 + 1))
    y1 = min(height, max(math.ceil((rect.y + rect.height) * height), y0 + 1))
    return x0, y0, x1, y1


def blur_area(image: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> None:
    """Blurs image[y0:y1, x0:x1] in place at D-171's strength."""
    area = image[y0:y1, x0:x1]
    h, w = area.shape[:2]
    short = min(w, h)
    if short < CELLS:
        # The area cannot shrink to 8 pixels, so it becomes one cell: its average colour. The
        # literal rule would leave it unchanged (Ukasha at S-19a's build, 2026-11-20).
        area[:] = np.round(area.reshape(-1, area.shape[2]).mean(axis=0)).astype(image.dtype)
        return
    cell = short / CELLS
    small = cv2.resize(
        area,
        (max(1, round(w / cell)), max(1, round(h / cell))),
        interpolation=cv2.INTER_AREA,
    )
    smeared = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    kernel = max(1, round(cell))
    area[:] = cv2.blur(smeared, (kernel, kernel))


def apply_regions(image: np.ndarray, regions: Iterable[Fractions]) -> np.ndarray:
    """A copy of the image with every region blurred, in the order given. The input is kept."""
    out = image.copy()
    height, width = out.shape[:2]
    for region in regions:
        blur_area(out, *pixel_rect(region, width, height))
    return out


def encode_full(image: np.ndarray) -> bytes:
    """The public file: JPEG at quality 90, at the stored size."""
    return _encode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])


def thumbnail(image: np.ndarray) -> bytes:
    """The public thumbnail: WebP at quality 80, 300 pixels on the long edge, never enlarged.

    Pass the blurred image. A thumbnail is cut from the blurred output and never blurred
    separately at its own size (arch §5).
    """
    height, width = image.shape[:2]
    scale = THUMB_EDGE / max(width, height)
    if scale < 1:
        image = cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return _encode(".webp", image, [cv2.IMWRITE_WEBP_QUALITY, WEBP_QUALITY])


def _encode(ext: str, image: np.ndarray, params: list[int]) -> bytes:
    ok, buffer = cv2.imencode(ext, image, params)
    if not ok:
        raise EncodeError(f"OpenCV could not encode {image.shape[1]}x{image.shape[0]} as {ext}")
    return buffer.tobytes()
