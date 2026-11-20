"""Detection and embedding over a stand-in model (arch §6, D-99, D-172)."""

import numpy as np
import pytest
from fakes import face_model as model

from app.ai import faces

WIDTH, HEIGHT = 400, 300


def image():
    return np.full((HEIGHT, WIDTH, 3), 128, np.uint8)


def test_no_face_returns_nothing_and_embeds_nothing():
    m = model([])
    assert faces.detect(image(), m) == []
    assert m.recognizer.crops == []


def test_one_face_has_its_box_as_fractions_of_the_stored_image():
    (face,) = faces.detect(image(), model([[100, 60, 200, 210, 0.9]]))
    assert face.x == pytest.approx(0.25)
    assert face.y == pytest.approx(0.2)
    assert face.width == pytest.approx(0.25)
    assert face.height == pytest.approx(0.5)
    assert face.score == pytest.approx(0.9)


def test_each_embedding_is_512_floats_of_length_1_from_a_112px_crop():
    m = model([[100, 60, 200, 210, 0.9], [250, 50, 330, 150, 0.8]])
    found = faces.detect(image(), m)
    assert len(found) == 2
    for face in found:
        assert face.embedding.shape == (512,)
        assert np.linalg.norm(face.embedding) == pytest.approx(1.0)
    assert [crop.shape for crop in m.recognizer.crops] == [(112, 112, 3)] * 2


def test_a_face_below_the_detection_score_is_not_counted():
    found = faces.detect(image(), model([[100, 60, 200, 210, 0.9], [250, 50, 330, 150, 0.49]]))
    assert len(found) == 1


def test_a_face_at_exactly_the_detection_score_is_counted():
    assert faces.DETECTION_SCORE == 0.5
    assert len(faces.detect(image(), model([[100, 60, 200, 210, 0.5]]))) == 1


@pytest.mark.parametrize(
    "box",
    [
        [-30, -20, 80, 90, 0.9],  # past the top left
        [350, 250, 460, 340, 0.9],  # past the bottom right
        [-10, -10, WIDTH + 10, HEIGHT + 10, 0.9],  # past every edge
        [0, 0, WIDTH, HEIGHT, 0.9],  # exactly the image
    ],
)
def test_a_box_past_an_edge_is_clamped_into_the_image(box):
    (face,) = faces.detect(image(), model([box]))
    for value in (face.x, face.y, face.width, face.height):
        assert 0 <= value <= 1
    assert face.width > 0 and face.height > 0
    # face_box_check in the migration, exactly as Postgres compares the doubles.
    assert face.x + face.width <= 1
    assert face.y + face.height <= 1
