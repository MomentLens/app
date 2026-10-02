"""The one decode: size as stored, no orientation, and the 4096 cap (D-99, D-123)."""

import numpy as np
import pytest
from fakes import jpeg

from app import images
from app.images import MAX_EDGE, DecodeError, cv2


def test_reads_width_and_height_as_stored():
    assert images.dimensions(jpeg(400, 300)) == (400, 300)


def test_an_orientation_tag_is_not_applied():
    tagged = jpeg(400, 300, orientation=6)
    # The fixture is real: OpenCV's default read turns the image a quarter turn.
    rotated = cv2.imdecode(np.frombuffer(tagged, np.uint8), cv2.IMREAD_COLOR)
    assert rotated.shape[:2] == (400, 300)

    assert images.dimensions(tagged) == (400, 300)


@pytest.mark.parametrize("data", [b"", b"not an image", jpeg(400, 300)[:600]])
def test_bytes_that_do_not_decode_fail(data):
    with pytest.raises(DecodeError):
        images.dimensions(data)


def test_an_image_over_the_longest_edge_fails():
    with pytest.raises(DecodeError, match="longest edge"):
        images.dimensions(jpeg(MAX_EDGE + 1, 10))


def test_the_longest_edge_itself_passes():
    assert images.dimensions(jpeg(MAX_EDGE, 10)) == (MAX_EDGE, 10)


def test_the_pixel_cap_is_set_before_opencv_loads():
    over = jpeg(MAX_EDGE + 1, MAX_EDGE + 1)
    # OpenCV itself refuses to allocate it, which only happens if the cap took effect.
    with pytest.raises(cv2.error):
        cv2.imdecode(np.frombuffer(over, np.uint8), images.DECODE_FLAGS)
    with pytest.raises(DecodeError, match="refused"):
        images.dimensions(over)
