"""Shared test setup.

app.images sets OpenCV's pixel cap before cv2 loads, so it is imported here, before any test
module can import cv2 another way.
"""

import app.images  # noqa: F401


def pytest_addoption(parser):
    parser.addoption(
        "--dev-sql",
        action="store_true",
        help=(
            "run tests/test_dev_sql.py against the dev project, reading DATABASE_URL from the"
            " repo root's .env when it is unset, and fail rather than skip without it (D-123)"
        ),
    )
