"""The worker's one image decode (D-123).

A decode is capped at 4096×4096 pixels, from root invariant 9's longest edge, so an oversized
file fails instead of taking the server's memory. OpenCV reads OPENCV_IO_MAX_IMAGE_PIXELS once,
when the library loads, so this module sets it before importing cv2. Import cv2 only through
here.

Pixels are read as stored, with no EXIF orientation applied (D-99). OpenCV rotates by the tag
unless told not to.
"""

import os

MAX_EDGE = 4096

os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = str(MAX_EDGE * MAX_EDGE)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

DECODE_FLAGS = cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION


class DecodeError(Exception):
    """The bytes are not an image OpenCV can decode within the cap."""


def decode(data: bytes) -> np.ndarray:
    """Decodes the whole image, so a broken JPEG fails here rather than publishing."""
    try:
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), DECODE_FLAGS)
    except cv2.error as error:
        # OpenCV's assertion for an image over OPENCV_IO_MAX_IMAGE_PIXELS lands here.
        raise DecodeError(f"OpenCV refused the file: {_last_line(error)}") from None
    if image is None:
        raise DecodeError(f"OpenCV could not decode {len(data)} bytes as an image")
    height, width = image.shape[:2]
    if max(width, height) > MAX_EDGE:
        raise DecodeError(f"{width}x{height} is over {MAX_EDGE}px on its longest edge")
    return image


def dimensions(data: bytes) -> tuple[int, int]:
    """Width and height as stored."""
    height, width = decode(data).shape[:2]
    return width, height


def _last_line(error: BaseException) -> str:
    lines = [line for line in str(error).strip().splitlines() if line.strip()]
    return lines[-1].strip() if lines else type(error).__name__
