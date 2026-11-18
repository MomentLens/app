"""P0-5 InsightFace spike and D-78 benchmark on the Azure Dubai VM (D-78, D-92, D-165, D-166).

Verifies photo SHA-256 digests against worker/bench/photos.sha256 before loading models or
timing any photo, enforces the 4096px longest-edge resize guard outside the timed section,
warms up buffalo_l, and measures per-photo detection + recognition latency.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from insightface.app import FaceAnalysis
from insightface.utils import face_align

DEFAULT_HASHES = Path(__file__).resolve().with_name("photos.sha256")
MAX_EDGE = 4096
MAX_BATCH = 32
MEDIAN_BAR_S = 0.86
FORTY_FACE_BAR_S = 4.0
# Closest photo to 40 faces in the benchmark set (02_indian_wedding_family_50.jpg, 45 faces).
FORTY_FACE_PHOTO_HASH = "38b72919ef5639a617007306871960a7195b3e80429a42748d17dbabd87f4d41"
# Raw benchmark JPEGs on disk may carry an EXIF orientation tag (e.g. 17_group_5_portrait.jpg),
# unlike mobile uploads which arrive upright with EXIF stripped (D-99). Use plain IMREAD_COLOR
# to match September's test_photos.py and upright upload pixels.
DECODE_FLAGS = cv2.IMREAD_COLOR


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark InsightFace buffalo_l on wedding photos."
    )
    parser.add_argument("photos_dir", type=Path, help="Directory holding the benchmark JPEGs.")
    parser.add_argument(
        "--threads",
        type=int,
        default=0,
        help="ONNX Runtime intra_op_num_threads (0 lets ONNX Runtime choose).",
    )
    parser.add_argument(
        "--hashes",
        type=Path,
        default=DEFAULT_HASHES,
        help="Path to photos.sha256 manifest.",
    )
    parser.add_argument(
        "--compare-batched",
        action="store_true",
        help="Also time batched recognition and report cosine similarity (doubles runtime).",
    )
    args = parser.parse_args(argv)
    if args.threads < 0:
        parser.error("--threads must be >= 0")
    return args


def load_manifest(hashes_path: Path) -> list[tuple[str, str]]:
    """Reads (sha256, filename) entries from a sha256sum manifest."""
    if not hashes_path.is_file():
        sys.exit(f"Hash manifest not found: {hashes_path}")
    entries: list[tuple[str, str]] = []
    for lineno, raw in enumerate(hashes_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            sys.exit(f"Invalid line {lineno} in {hashes_path}: {raw!r}")
        digest, name = parts[0].lower(), parts[1].lstrip("*").strip()
        entries.append((digest, name))
    if not entries:
        sys.exit(f"No entries found in {hashes_path}")
    return entries


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def verify_photos(photos_dir: Path, manifest: list[tuple[str, str]]) -> list[tuple[Path, str]]:
    """Checks every expected photo exists and matches its SHA-256 hash before timing."""
    if not photos_dir.is_dir():
        sys.exit(f"Photos directory not found: {photos_dir}")
    verified: list[tuple[Path, str]] = []
    mismatches: list[str] = []
    for expected_hash, filename in manifest:
        path = photos_dir / filename
        if not path.is_file():
            mismatches.append(f"MISSING {filename}")
            continue
        actual = sha256_file(path)
        if actual != expected_hash:
            mismatches.append(f"MISMATCH {filename}: expected {expected_hash}, got {actual}")
            continue
        verified.append((path, expected_hash))
    if mismatches:
        sys.exit("Photo hash verification failed:\n" + "\n".join(mismatches))
    return verified


def load_and_guard(path: Path) -> np.ndarray:
    """Decodes image (applying EXIF orientation) and enforces the 4096px longest-edge cap."""
    img = cv2.imread(str(path), DECODE_FLAGS)
    if img is None:
        sys.exit(f"OpenCV could not read {path}. Check that it is a real JPEG.")
    height, width = img.shape[:2]
    longest = max(width, height)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / longest
        new_w = max(1, round(width * scale))
        new_h = max(1, round(height * scale))
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img


def run_per_face(app: FaceAnalysis, img: np.ndarray) -> list[np.ndarray]:
    return [face.embedding for face in app.get(img)]


def run_batched(det, rec, img: np.ndarray) -> list[np.ndarray]:
    bboxes, kpss = det.detect(img, max_num=0, metric="default")
    if bboxes.shape[0] == 0:
        return []
    if kpss is None:
        sys.exit("The detector returned no keypoints, so faces cannot be aligned.")
    crops = [face_align.norm_crop(img, landmark=k, image_size=rec.input_size[0]) for k in kpss]
    out: list[np.ndarray] = []
    for i in range(0, len(crops), MAX_BATCH):
        out.extend(rec.get_feat(crops[i : i + MAX_BATCH]))
    return out


def min_cosine(a: list[np.ndarray], b: list[np.ndarray], name: str) -> float:
    if len(a) != len(b):
        sys.exit(f"{name}: face counts differ, per-face {len(a)} and batched {len(b)}")
    if not a:
        return 1.0
    mat_a = np.array(a, dtype=np.float64)
    mat_b = np.array(b, dtype=np.float64)
    mat_a /= np.linalg.norm(mat_a, axis=1, keepdims=True)
    mat_b /= np.linalg.norm(mat_b, axis=1, keepdims=True)
    return float((mat_a * mat_b).sum(axis=1).min())


def fit_linear_cost(faces: list[int], secs: list[float]) -> tuple[float, float]:
    """Fits elapsed_s = per_photo_s + per_face_s * face_count via least squares."""
    x = np.array(faces, dtype=np.float64)
    y = np.array(secs, dtype=np.float64)
    if len(x) < 2 or np.ptp(x) == 0:
        return float(np.mean(y)), 0.0
    slope, intercept = np.polyfit(x, y, 1)
    return float(intercept), float(slope)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = load_manifest(args.hashes)
    photos = verify_photos(args.photos_dir, manifest)
    print(f"Verified {len(photos)} photos against {args.hashes}", flush=True)

    print("Loading buffalo_l (detection, recognition)...", flush=True)
    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    app = FaceAnalysis(
        name="buffalo_l",
        allowed_modules=["detection", "recognition"],
        providers=["CPUExecutionProvider"],
        sess_options=so,
    )
    app.prepare(ctx_id=0, det_size=(640, 640))
    det = app.det_model
    rec = app.models["recognition"]

    print("Warming up...", flush=True)
    det.detect(np.zeros((640, 640, 3), np.uint8), max_num=0, metric="default")
    blank = np.zeros((rec.input_size[1], rec.input_size[0], 3), np.uint8)
    rec.get_feat([blank])
    if args.compare_batched:
        rec.get_feat([blank] * MAX_BATCH)

    mode_label = "per-face and batched" if args.compare_batched else "per-face"
    print(
        f"Timing {len(photos)} photos ({mode_label}), threads={args.threads or 'default'}",
        flush=True,
    )

    t_face: list[float] = []
    t_batch: list[float] = []
    face_counts: list[int] = []
    worst_cos = 1.0
    forty_photo_result: tuple[str, int, float] | None = None

    for i, (path, digest) in enumerate(photos):
        img = load_and_guard(path)
        h, w = img.shape[:2]
        if args.compare_batched:
            runs = [
                ("face", lambda im=img: run_per_face(app, im)),
                ("batch", lambda im=img: run_batched(det, rec, im)),
            ]
            if i % 2:
                runs.reverse()
            res: dict[str, list[np.ndarray]] = {}
            secs: dict[str, float] = {}
            for mode, fn in runs:
                start = time.perf_counter()
                res[mode] = fn()
                secs[mode] = time.perf_counter() - start
            cos = min_cosine(res["face"], res["batch"], path.name)
            worst_cos = min(worst_cos, cos)
            n_faces = len(res["face"])
            elapsed = secs["face"]
            t_batch.append(secs["batch"])
            extra = (
                f", batched {secs['batch']:.3f}s, x{elapsed / secs['batch']:.2f},"
                f" lowest cosine {cos:.6f}"
            )
        else:
            start = time.perf_counter()
            embeddings = run_per_face(app, img)
            elapsed = time.perf_counter() - start
            n_faces = len(embeddings)
            extra = ""

        t_face.append(elapsed)
        face_counts.append(n_faces)
        if digest == FORTY_FACE_PHOTO_HASH:
            forty_photo_result = (path.name, n_faces, elapsed)
        print(
            f"[{i + 1}/{len(photos)}] {path.name} ({w}x{h}, sha256={digest[:12]}): "
            f"{n_faces} faces, {elapsed:.3f}s{extra}",
            flush=True,
        )

    cores = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    median_s = statistics.median(t_face)
    per_photo_s, per_face_s = fit_linear_cost(face_counts, t_face)
    fit_40_s = per_photo_s + 40 * per_face_s

    print(
        f"\ncores={cores} threads={args.threads or 'default'}"
        f" photos={len(photos)} (decode excluded)",
        flush=True,
    )
    print(
        f"per-face: total={sum(t_face):.2f}s median={median_s:.3f}s slowest={max(t_face):.3f}s",
        flush=True,
    )
    print(
        f"linear fit: {per_photo_s:.3f}s/photo + {per_face_s * 1000:.1f}ms/face"
        f" -> 40-face estimate={fit_40_s:.3f}s",
        flush=True,
    )
    if forty_photo_result is not None:
        name, n_faces, secs_40 = forty_photo_result
        print(
            f"named reference photo ({FORTY_FACE_PHOTO_HASH[:12]} {name}, {n_faces} faces):"
            f" {secs_40:.3f}s",
            flush=True,
        )
    print(
        f"D-78/D-166 bar (with credits): median {median_s:.3f}s <= {MEDIAN_BAR_S:.2f}s "
        f"({'PASS' if median_s <= MEDIAN_BAR_S else 'MISS'}), "
        f"40-face fit {fit_40_s:.3f}s <= {FORTY_FACE_BAR_S:.1f}s "
        f"({'PASS' if fit_40_s <= FORTY_FACE_BAR_S else 'MISS'})",
        flush=True,
    )
    if args.compare_batched:
        print(
            f"batched:  total={sum(t_batch):.2f}s median={statistics.median(t_batch):.3f}s"
            f" slowest={max(t_batch):.3f}s",
            flush=True,
        )
        print(
            f"speedup on total: x{sum(t_face) / sum(t_batch):.2f}"
            f"   lowest cosine between modes: {worst_cos:.6f}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
