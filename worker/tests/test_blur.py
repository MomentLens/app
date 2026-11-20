"""The blur itself: the rectangle, the strength and the files cut from it (D-65, D-99, D-171)."""

import numpy as np
import pytest

from app import blur
from app.db import BlurRegion
from app.images import cv2


def noise(width, height, seed=3):
    return np.random.default_rng(seed).integers(0, 256, (height, width, 3), dtype=np.uint8)


def region(x, y, width, height):
    return BlurRegion(x=x, y=y, width=width, height=height)


def test_a_rectangle_rounds_outward_to_whole_pixels():
    # 0.101 * 100 = 10.1 starts at 10; 0.101 + 0.2 = 0.301, * 100 = 30.1 ends at 31.
    assert blur.pixel_rect(region(0.101, 0.101, 0.2, 0.2), 100, 100) == (10, 10, 31, 31)


def test_a_rectangle_is_clamped_to_the_image():
    assert blur.pixel_rect(region(0.9, 0.9, 0.1, 0.1), 101, 101) == (90, 90, 101, 101)
    assert blur.pixel_rect(region(0.0, 0.0, 1.0, 1.0), 64, 48) == (0, 0, 64, 48)


def test_a_sliver_thinner_than_a_pixel_still_covers_one():
    x0, y0, x1, y1 = blur.pixel_rect(region(0.999999, 0.5, 0.000001, 0.000001), 100, 100)
    assert (x1 - x0, y1 - y0) == (1, 1)
    assert x1 <= 100


def test_pixels_outside_every_rectangle_are_unchanged_and_inside_changed():
    image = noise(200, 100)
    regions = [region(0.1, 0.2, 0.2, 0.3), region(0.6, 0.5, 0.3, 0.4)]

    out = blur.apply_regions(image, regions)

    inside = np.zeros(image.shape[:2], bool)
    for r in regions:
        x0, y0, x1, y1 = blur.pixel_rect(r, 200, 100)
        inside[y0:y1, x0:x1] = True
    assert np.array_equal(out[~inside], image[~inside])
    changed = np.abs(out.astype(int) - image.astype(int)).mean(axis=2)
    assert changed[inside].mean() > 40


def test_the_input_image_is_not_changed():
    image = noise(64, 64)
    before = image.copy()

    blur.apply_regions(image, [region(0.0, 0.0, 0.5, 0.5)])

    assert np.array_equal(image, before)


@pytest.mark.parametrize("short", [16, 40, 400])
def test_the_area_keeps_about_eight_cells_across_its_shorter_side(short):
    # Whatever the size, the detail left is what 8 cells across can hold (D-171), so the blurred
    # area matches itself shrunk to 8 cells and scaled back up far more closely than the noise.
    image = noise(short * 2, short)
    out = blur.apply_regions(image, [region(0.0, 0.0, 1.0, 1.0)])

    eight = cv2.resize(
        cv2.resize(out, (16, 8), interpolation=cv2.INTER_AREA),
        (short * 2, short),
        interpolation=cv2.INTER_LINEAR,
    )
    left = np.abs(out.astype(int) - eight.astype(int)).mean()
    assert left < 12, left
    assert out.std() < image.std() / 3


def test_an_area_under_eight_pixels_is_filled_with_its_average_colour():
    # Fractions a float holds exactly, so the area is 4 by 16 pixels at 64..68, 64..80.
    image = noise(128, 128)
    out = blur.apply_regions(image, [region(0.5, 0.5, 0.03125, 0.125)])

    area = out[64:80, 64:68].reshape(-1, 3)
    assert (area == area[0]).all()
    expected = image[64:80, 64:68].reshape(-1, 3).mean(axis=0).round()
    assert np.array_equal(area[0], expected.astype(np.uint8))


def test_the_full_file_is_a_jpeg_of_the_same_size():
    data = blur.encode_full(noise(120, 80))
    assert data[:2] == b"\xff\xd8"
    assert cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (80, 120)


@pytest.mark.parametrize(
    ("size", "expected"),
    [((1200, 800), (300, 200)), ((800, 1200), (200, 300)), ((240, 100), (240, 100))],
)
def test_the_thumbnail_is_a_webp_300_on_its_long_edge_and_never_enlarged(size, expected):
    width, height = size
    data = blur.thumbnail(noise(width, height))
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape[1::-1] == expected
