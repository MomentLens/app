"""S-26: measure the match and Unknown clustering thresholds on the team's photos (D-173).

Run from worker/, with both photo folders outside the repo (the team's photos never enter git):

    .venv/bin/python -m bench.calibrate --write-manifest <team folder>
    .venv/bin/python -m bench.calibrate <team folder> <bench folder>

The first writes bench/calibration.sha256, once, after the photo session. The second checks the
team photos against it and the 17 bench photos against bench/photos.sha256 before the model
loads, then prints what arch §6 records. It exits 1 when a check fails, so a rerun for D-169's
OpenCV recheck reads the same way.

The team folder says whose face is whose:

    a/selfie_1.jpg, a/event_1.jpg, ...   one folder per person, named by one lower-case letter
    group/b-a-c_1.jpg                     several people, their letters left to right

A solo photo takes its largest face and lists the rest. A group shot takes its largest faces, one
per letter, left to right, and labels nobody if it has too few.

Each photo first goes through the phone's Stage 1 (D-172): EXIF orientation applied, longest edge
capped at 4096px, JPEG at quality 0.9. Then app.images.decode and app.ai.faces.detect read it as
the worker would, down to a detection score of 0.3 so the check around 0.5 can see under it.

The rules (D-173):
- Match: the highest two-decimal value at which every event face of a person matches that person
  with each of their selfies in turn as the only reference. Scores come from matching.match, in
  float32, as production compares them.
- Unknown clustering: the lowest two-decimal value above every different-person pair. Different
  people are faces of two team members, a team face and a bench face, and two faces in one bench
  photo. Two faces from different bench photos are left out: they could be the same guest.
- Detection score: keep 0.5 unless a team face scores under it or a non-face scores at or over
  it. The second needs eyes, so every detection between 0.3 and 0.7 is saved as a crop.

Two checks do not rest on the picked values, since a wrong label moves the pick to fit it:
- A genuine pair at or under the highest impostor score fails the run. A guest labelled as a team
  member, because their face was larger, lands here.
- A different-person pair over the median same-person pair fails the run, and the five highest
  are printed with their photos. One person on both sides, such as a team member in a bench photo,
  lands here.
"""

from __future__ import annotations

import argparse
import io
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID, uuid4

import numpy as np
from PIL import Image, ImageOps

# app.images sets OpenCV's pixel cap, which OpenCV reads once when it loads, so it is imported
# before anything that loads cv2: insightface does, through app.ai. Ruff's order keeps a plain
# import ahead of the from-imports in this block, and numpy and PIL above never load cv2.
import app.images
from app.ai import matching, model
from app.ai.faces import DETECTION_SCORE, DetectedFace, detect
from bench.benchmark import DEFAULT_HASHES as BENCH_HASHES
from bench.benchmark import load_manifest, sha256_file, verify_photos

cv2 = app.images.cv2

WORKER = Path(__file__).resolve().parents[1]
TEAM_HASHES = WORKER / "bench" / "calibration.sha256"
MODEL_HASHES = WORKER / "models.sha256"
# The lowest score detect() keeps here, so team faces under DETECTION_SCORE are still seen.
DETECTION_FLOOR = 0.3
# Detections in this range are saved as crops for a person to look at (card Q8).
CROP_RANGE = (0.3, 0.7)
JPEG_QUALITY = 90

SOLO = re.compile(r"^(selfie|event)_\d+\.jpe?g$")
GROUP = re.compile(r"^([a-z](?:-[a-z])+)_\d+\.jpe?g$")
PERSON = re.compile(r"^[a-z]$")


class CalibrationError(Exception):
    """A photo, the layout or a manifest is wrong. The run stops before any number is printed."""


@dataclass(frozen=True)
class TeamPhoto:
    # Relative to the team folder, with forward slashes, as calibration.sha256 names it.
    path: str
    kind: str  # "selfie", "event" or "group"
    people: tuple[str, ...]  # one letter, or a group shot's letters left to right


@dataclass(frozen=True)
class LabelledFace:
    person: str
    photo: str
    kind: str
    face: DetectedFace


@dataclass(frozen=True)
class SelfieReference:
    person: str
    photo: str
    embedding: np.ndarray


@dataclass(frozen=True)
class Miss:
    face: LabelledFace
    reference: SelfieReference
    similarity: float


@dataclass
class Result:
    match_threshold: float
    lowest_genuine: float
    genuine_pairs: int
    genuine_misses: list[Miss]
    team_faces_under_detection_score: list[LabelledFace]
    references: list[SelfieReference]
    bench_pairs: int
    bench_false_matches: int
    bench_faces: int
    bench_faces_matched: int
    team_cross_pairs: int
    team_cross_false_matches: int
    highest_impostor: float
    rank_1_errors: list[LabelledFace]
    # Genuine pairs at or under the highest impostor score. A face labelled with the wrong person,
    # such as a guest larger than the team member, lands here, since the match pick fits it.
    genuine_overlaps: list[Miss]
    cluster_threshold: float
    highest_different_person_pair: float
    different_person_pairs: int
    # The highest different-person pairs, with what each face is, for a person to look at.
    top_different_pairs: list[tuple[float, str, str]]
    same_person_pairs: int
    same_person_pairs_split: int
    median_same_person_pair: float
    notes: list[str] = field(default_factory=list)


# The two-decimal picks. Each steps through whole hundredths and compares, because
# floor(0.43 * 100) is 42 in floating point.


def pick_match_threshold(genuine: Iterable[float]) -> float:
    """The highest k/100 at or under every genuine score, so match() (score >= threshold) misses
    none of them."""
    scores = [float(s) for s in genuine]
    if not scores:
        raise CalibrationError("no genuine scores: no team event face was matched to a selfie")
    lowest = min(scores)
    k = int(np.floor(lowest * 100)) + 1
    while k / 100 > lowest:
        k -= 1
    return k / 100


def pick_cluster_threshold(different: Iterable[float]) -> float:
    """The lowest k/100 strictly above every different-person score, so cluster() (score >=
    threshold) joins none of them."""
    scores = [float(s) for s in different]
    if not scores:
        raise CalibrationError("no different-person pairs to place the clustering value above")
    highest = max(scores)
    k = int(np.floor(highest * 100)) - 1
    while k / 100 <= highest:
        k += 1
    return k / 100


# Whose face is whose


def parse_layout(team_dir: Path) -> list[TeamPhoto]:
    """Every photo in the team folder with its kind and people. Anything else stops the run."""
    photos: list[TeamPhoto] = []
    problems: list[str] = []
    people = sorted(p.name for p in team_dir.iterdir() if p.is_dir() and PERSON.match(p.name))
    for path in sorted(team_dir.rglob("*")):
        if path.is_dir() or path.name == ".DS_Store":
            continue
        relative = path.relative_to(team_dir).as_posix()
        parts = relative.split("/")
        if len(parts) != 2:
            problems.append(f"{relative}: not in a person's folder or group/")
            continue
        folder, name = parts
        if folder == "group":
            found = GROUP.match(name)
            letters = tuple(found.group(1).split("-")) if found else ()
            unknown = [letter for letter in letters if letter not in people]
            if not found or unknown or len(set(letters)) != len(letters):
                problems.append(
                    f"{relative}: a group shot is named like b-a-c_1.jpg, two or more different "
                    "letters left to right, each with its own folder"
                )
                continue
            photos.append(TeamPhoto(relative, "group", letters))
        elif PERSON.match(folder):
            found = SOLO.match(name)
            if not found:
                problems.append(f"{relative}: name it selfie_<n>.jpg or event_<n>.jpg, as JPEG")
                continue
            photos.append(TeamPhoto(relative, found.group(1), (folder,)))
        else:
            problems.append(f"{relative}: {folder}/ is neither one lower-case letter nor group/")
    for person in people:
        kinds = {p.kind for p in photos if p.people == (person,)}
        for kind in ("selfie", "event"):
            if kind not in kinds:
                problems.append(f"{person}/ has no {kind}_<n>.jpg")
    if len(people) < 2:
        problems.append("the team folder needs at least two people's folders")
    if problems:
        raise CalibrationError(
            "the team folder does not follow the layout:\n" + "\n".join(problems)
        )
    return photos


def assign(
    photo: TeamPhoto, faces: Sequence[DetectedFace]
) -> tuple[list[LabelledFace], list[DetectedFace]]:
    """The photo's labelled faces, and the faces it found but labelled nobody with. A photo with
    fewer faces than people labels nobody, since it cannot tell which one is missing."""
    by_size = sorted(faces, key=lambda f: f.width * f.height, reverse=True)
    wanted = len(photo.people)
    if len(by_size) < wanted:
        return [], list(faces)
    chosen = sorted(by_size[:wanted], key=lambda f: f.x + f.width / 2)
    labelled = [
        LabelledFace(person, photo.path, photo.kind, f)
        for person, f in zip(photo.people, chosen, strict=True)
    ]
    extra = [f for f in faces if all(f is not c for c in chosen)]
    return labelled, extra


# The measurement, on faces already found. No model, no files: the tests run it on made-up
# embeddings.


def _subject(person: str) -> UUID:
    return UUID(int=ord(person))


def _similarities(faces: Sequence[np.ndarray], reference: np.ndarray) -> list[float]:
    """Each face against one reference, through the worker's own match() at a threshold every
    cosine passes, so these are the float32 numbers production compares."""
    if not faces:
        return []
    found = matching.match(list(faces), [matching.Reference(uuid4(), reference)], -1.0)
    return [m.similarity for m in found if m is not None]


def references(
    faces: Sequence[LabelledFace],
    *,
    detection_score: float,
    faces_per_photo: dict[str, int] | None = None,
) -> list[SelfieReference]:
    """The selfies reference_process would accept: exactly one face at the detection score."""
    counts = faces_per_photo or {}
    return [
        SelfieReference(f.person, f.photo, f.face.embedding)
        for f in faces
        if f.kind == "selfie" and f.face.score >= detection_score and counts.get(f.photo, 1) == 1
    ]


def _event_faces(faces: Sequence[LabelledFace], detection_score: float) -> list[LabelledFace]:
    return [f for f in faces if f.kind != "selfie" and f.face.score >= detection_score]


def genuine_misses(
    faces: Sequence[LabelledFace],
    refs: Sequence[SelfieReference],
    threshold: float,
    *,
    detection_score: float,
) -> list[Miss]:
    """Every (event face, own selfie) pair that match() at `threshold` does not match: the
    self-check the report's zero rests on."""
    misses: list[Miss] = []
    for event in _event_faces(faces, detection_score):
        for ref in refs:
            if ref.person != event.person:
                continue
            subject = _subject(ref.person)
            (found,) = matching.match(
                [event.face.embedding], [matching.Reference(subject, ref.embedding)], threshold
            )
            if found is None or found.subject_id != subject:
                (score,) = _similarities([event.face.embedding], ref.embedding)
                misses.append(Miss(event, ref, score))
    return misses


def _unit(vectors: Sequence[np.ndarray]) -> np.ndarray:
    matrix = np.asarray(vectors, np.float32).reshape(len(vectors), -1)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def _pairs(a: Sequence[np.ndarray], b: Sequence[np.ndarray]) -> np.ndarray:
    """Every cosine between a face in `a` and one in `b`, in float32 as cluster() compares."""
    if not a or not b:
        return np.zeros(0, np.float32)
    return (_unit(a) @ _unit(b).T).ravel()


def _within(vectors: Sequence[np.ndarray]) -> np.ndarray:
    """Every cosine between two different faces of one list."""
    if len(vectors) < 2:
        return np.zeros(0, np.float32)
    matrix = _unit(vectors) @ _unit(vectors).T
    return matrix[np.triu_indices(len(vectors), k=1)]


def _top_pairs(
    blocks: Sequence[
        tuple[Sequence[str], Sequence[np.ndarray], Sequence[str], Sequence[np.ndarray]]
    ],
    within: Sequence[tuple[Sequence[str], Sequence[np.ndarray]]],
    count: int,
) -> list[tuple[float, str, str]]:
    """The `count` highest cosines among the pairs `_pairs` and `_within` score, each with the
    labels of its two faces."""
    pairs: list[tuple[float, str, str]] = []
    for labels_a, a, labels_b, b in blocks:
        if a and b:
            matrix = _unit(a) @ _unit(b).T
            rows, cols = np.unravel_index(np.argsort(matrix, axis=None)[-count:], matrix.shape)
            for i, j in zip(rows, cols, strict=True):
                pairs.append((float(matrix[i, j]), labels_a[i], labels_b[j]))
    for labels, vectors in within:
        if len(vectors) >= 2:
            matrix = _unit(vectors) @ _unit(vectors).T
            rows, cols = np.triu_indices(len(vectors), k=1)
            for k in np.argsort(matrix[rows, cols])[-count:]:
                i, j = rows[k], cols[k]
                pairs.append((float(matrix[i, j]), labels[i], labels[j]))
    return sorted(pairs, reverse=True)[:count]


def analyse(
    team_faces: Sequence[LabelledFace],
    bench: dict[str, list[DetectedFace]],
    *,
    detection_score: float = DETECTION_SCORE,
    faces_per_photo: dict[str, int] | None = None,
) -> Result:
    stored = [f for f in team_faces if f.face.score >= detection_score]
    under = [f for f in team_faces if f.face.score < detection_score]
    refs = references(team_faces, detection_score=detection_score, faces_per_photo=faces_per_photo)
    events = _event_faces(team_faces, detection_score)
    notes: list[str] = []

    # Match, at 1 reference: each selfie in turn against its own person's event faces.
    genuine: list[float] = []
    for ref in refs:
        own = [e.face.embedding for e in events if e.person == ref.person]
        genuine += _similarities(own, ref.embedding)
    for person in sorted({f.person for f in team_faces}):
        if not any(r.person == person for r in refs):
            notes.append(f"{person} has no selfie reference_process would accept")
        if not any(e.person == person for e in events):
            notes.append(f"{person} has no event face at the detection score")
    match_threshold = pick_match_threshold(genuine)
    misses = genuine_misses(team_faces, refs, match_threshold, detection_score=detection_score)

    # Impostors at that value: bench faces and the other team members, each against one selfie.
    bench_stored = [f for faces in bench.values() for f in faces if f.score >= detection_score]
    bench_embeddings = [f.embedding for f in bench_stored]
    bench_scores = [_similarities(bench_embeddings, r.embedding) for r in refs]
    cross_scores = [
        _similarities([f.face.embedding for f in stored if f.person != r.person], r.embedding)
        for r in refs
    ]
    flat_bench = [s for row in bench_scores for s in row]
    flat_cross = [s for row in cross_scores for s in row]
    matched_bench_faces = sum(
        any(row[i] >= match_threshold for row in bench_scores) for i in range(len(bench_stored))
    )

    # Rank 1: with every selfie loaded, the closest subject for each event face.
    everyone = [matching.Reference(_subject(r.person), r.embedding) for r in refs]
    rank_1_errors: list[LabelledFace] = []
    if everyone and events:
        found = matching.match([e.face.embedding for e in events], everyone, -1.0)
        rank_1_errors = [
            e
            for e, m in zip(events, found, strict=True)
            if m is None or m.subject_id != _subject(e.person)
        ]

    # A check that does not rest on the picked value: no genuine pair may score at or under an
    # impostor. The zero-miss check above passes whatever the labels, because the pick fits them.
    highest_impostor = max(flat_bench + flat_cross, default=float("nan"))
    overlaps: list[Miss] = []
    if not np.isnan(highest_impostor):
        above = float(np.nextafter(np.float64(highest_impostor), np.inf))
        overlaps = genuine_misses(team_faces, refs, above, detection_score=detection_score)

    # Clustering: face against face.
    people = sorted({f.person for f in stored})
    by_person = {p: [f.face.embedding for f in stored if f.person == p] for p in people}
    names = {p: [f"{f.photo} ({p})" for f in stored if f.person == p] for p in people}
    bench_kept = {
        name: [f for f in faces if f.score >= detection_score] for name, faces in bench.items()
    }
    bench_names = [
        f"bench {name} face {i}" for name, fs in bench_kept.items() for i in range(len(fs))
    ]
    different: list[np.ndarray] = []
    same: list[np.ndarray] = []
    blocks = []
    for i, p in enumerate(people):
        same.append(_within(by_person[p]))
        for q in people[i + 1 :]:
            different.append(_pairs(by_person[p], by_person[q]))
            blocks.append((names[p], by_person[p], names[q], by_person[q]))
    team_embeddings = [f.face.embedding for f in stored]
    team_names = [name for p in people for name in names[p]]
    team_in_order = [e for p in people for e in by_person[p]]
    different.append(_pairs(team_embeddings, bench_embeddings))
    blocks.append((team_names, team_in_order, bench_names, bench_embeddings))
    within = []
    for name, faces in bench_kept.items():
        different.append(_within([f.embedding for f in faces]))
        within.append(
            ([f"bench {name} face {i}" for i in range(len(faces))], [f.embedding for f in faces])
        )
    different_all = np.concatenate(different) if different else np.zeros(0, np.float32)
    same_all = np.concatenate(same) if same else np.zeros(0, np.float32)
    cluster_threshold = pick_cluster_threshold(different_all.tolist())

    return Result(
        match_threshold=match_threshold,
        lowest_genuine=min(genuine),
        genuine_pairs=len(genuine),
        genuine_misses=misses,
        team_faces_under_detection_score=under,
        references=refs,
        bench_pairs=len(flat_bench),
        bench_false_matches=sum(s >= match_threshold for s in flat_bench),
        bench_faces=len(bench_stored),
        bench_faces_matched=int(matched_bench_faces),
        team_cross_pairs=len(flat_cross),
        team_cross_false_matches=sum(s >= match_threshold for s in flat_cross),
        highest_impostor=highest_impostor,
        rank_1_errors=rank_1_errors,
        genuine_overlaps=overlaps,
        cluster_threshold=cluster_threshold,
        highest_different_person_pair=float(different_all.max()),
        different_person_pairs=int(different_all.size),
        top_different_pairs=_top_pairs(blocks, within, 5),
        same_person_pairs=int(same_all.size),
        same_person_pairs_split=int((same_all < cluster_threshold).sum()),
        median_same_person_pair=float(np.median(same_all)) if same_all.size else float("nan"),
        notes=notes,
    )


# Files: the repo boundary and the manifests


def check_outside_repo(team_dir: Path) -> None:
    """The team's photos stay off git (card Q5), so the folder may not sit in any work tree."""
    if not team_dir.is_dir():
        raise CalibrationError(f"{team_dir} is not a folder")
    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=team_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        ).stdout.strip()
    except FileNotFoundError:
        inside = ""
    resolved = team_dir.resolve()
    if inside == "true" or resolved == WORKER.parent or WORKER.parent in resolved.parents:
        raise CalibrationError(
            f"{team_dir} is inside a git work tree. Keep the team's photos outside the repo"
        )


def _team_files(team_dir: Path) -> list[str]:
    return sorted(
        p.relative_to(team_dir).as_posix()
        for p in team_dir.rglob("*")
        if p.is_file() and p.name != ".DS_Store"
    )


def write_manifest(team_dir: Path, manifest: Path = TEAM_HASHES) -> None:
    lines = [f"{sha256_file(team_dir / name)}  {name}" for name in _team_files(team_dir)]
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def verify_team(team_dir: Path, manifest: Path = TEAM_HASHES) -> None:
    """Every photo on disk is in the manifest with its hash, and every one listed is on disk."""
    if not manifest.is_file():
        raise CalibrationError(f"{manifest} is missing. Write it once with --write-manifest")
    expected = dict((name, digest) for digest, name in load_manifest(manifest))
    on_disk = _team_files(team_dir)
    problems = [f"MISSING {name}" for name in sorted(set(expected) - set(on_disk))]
    problems += [f"NOT IN THE MANIFEST {name}" for name in on_disk if name not in expected]
    problems += [
        f"CHANGED {name}"
        for name in on_disk
        if name in expected and sha256_file(team_dir / name) != expected[name]
    ]
    if problems:
        raise CalibrationError(f"the team photos do not match {manifest}:\n" + "\n".join(problems))


# The run


def stage_1(path: Path) -> np.ndarray:
    """What the phone sends (D-172), read back the way the worker reads it."""
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    longest = max(image.size)
    if longest > app.images.MAX_EDGE:
        scale = app.images.MAX_EDGE / longest
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, "JPEG", quality=JPEG_QUALITY)
    return app.images.decode(out.getvalue())


def _save_crop(image: np.ndarray, face: DetectedFace, out_dir: Path, name: str) -> None:
    height, width = image.shape[:2]
    x1, y1 = int(face.x * width), int(face.y * height)
    x2 = max(x1 + 1, int((face.x + face.width) * width))
    y2 = max(y1 + 1, int((face.y + face.height) * height))
    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / name), image[y1:y2, x1:x2])


def _crop_name(photo: str, index: int, face: DetectedFace) -> str:
    return f"{face.score:.3f}_{photo.replace('/', '_').rsplit('.', 1)[0]}_{index}.jpg"


def versions() -> list[str]:
    import insightface
    import onnxruntime

    model_zip = MODEL_HASHES.read_text(encoding="utf-8").split()[0]
    return [
        f"opencv-python-headless {cv2.__version__}",
        f"onnxruntime {onnxruntime.__version__}",
        f"insightface {insightface.__version__}",
        f"numpy {np.__version__}",
        f"buffalo_l.zip sha256 {model_zip}",
    ]


def report(result: Result, extras: list[str], detection_misses: list[str], crops: int) -> bool:
    """Prints the report. True when every check passed."""
    ok = True
    print("\n== Detection score check (keep 0.5 unless this fails, card Q8) ==")
    for line in detection_misses:
        print(f"FAIL  no face found down to {DETECTION_FLOOR}: {line}")
        ok = False
    for f in result.team_faces_under_detection_score:
        print(f"FAIL  team face under {DETECTION_SCORE}: {f.photo} ({f.person}) {f.face.score:.3f}")
        ok = False
    if not detection_misses and not result.team_faces_under_detection_score:
        print(f"ok    every team face scored at least {DETECTION_SCORE}")
    print(f"look  {crops} crops scoring {CROP_RANGE[0]} to {CROP_RANGE[1]} saved; a non-face at")
    print(f"      or over {DETECTION_SCORE} among them fails the check")
    for line in extras:
        print(f"note  {line}")

    print("\n== References (selfies reference_process would accept) ==")
    for ref in result.references:
        print(f"      {ref.photo}")
    for note in result.notes:
        print(f"FAIL  {note}")
        ok = False

    print("\n== Match, at 1 reference ==")
    print(f"value {result.match_threshold:.2f}")
    print(
        f"      lowest genuine score {result.lowest_genuine:.4f} over {result.genuine_pairs} pairs"
    )
    if result.genuine_misses:
        ok = False
        for m in result.genuine_misses:
            print(f"FAIL  missed {m.face.photo} against {m.reference.photo}: {m.similarity:.4f}")
    else:
        print("ok    zero genuine misses through matching.match at this value")
    print(
        f"      bench: {result.bench_false_matches} of {result.bench_pairs} pairs match, "
        f"{result.bench_faces_matched} of {result.bench_faces} faces match someone"
    )
    print(
        f"      team cross pairs: {result.team_cross_false_matches} of {result.team_cross_pairs} "
        "match the wrong person"
    )
    print(f"      highest impostor score {result.highest_impostor:.4f}")
    for f in result.rank_1_errors:
        print(f"rank1 {f.photo} ({f.person}) is closest to another person's selfie")
    for m in result.genuine_overlaps:
        ok = False
        print(
            f"FAIL  {m.face.photo} ({m.face.person}) against {m.reference.photo} scores "
            f"{m.similarity:.4f}, no higher than an impostor. Check its crop: a wrong label, such "
            "as a guest larger than the team member, or D-173's reopen case"
        )

    print("\n== Unknown clustering ==")
    print(f"value {result.cluster_threshold:.2f}")
    print(
        f"      highest different-person pair {result.highest_different_person_pair:.4f} over "
        f"{result.different_person_pairs} pairs"
    )
    for score, a, b in result.top_different_pairs:
        print(f"      {score:.4f}  {a}  vs  {b}")
    if result.highest_different_person_pair > result.median_same_person_pair:
        ok = False
        print(
            f"FAIL  the highest different-person pair scores over the median same-person pair "
            f"({result.median_same_person_pair:.4f}). Look at the pairs above: one face may be "
            "the same person twice, such as a team member in a bench photo or a mirror"
        )
    print(
        f"      {result.same_person_pairs_split} of {result.same_person_pairs} same-person pairs "
        "fall under it, so one person can split into several clusters"
    )

    print("\n== Versions (D-169) ==")
    for line in versions():
        print(f"      {line}")
    print(f"      team photos: {TEAM_HASHES.relative_to(WORKER).as_posix()}")
    print("\nThree people is a small sample, so these values fit the demo set (hb §11.4).")
    print("RESULT", "PASS" if ok else "FAIL")
    return ok


def run(team_dir: Path, bench_dir: Path, out_dir: Path) -> bool:
    check_outside_repo(team_dir)
    photos = parse_layout(team_dir)
    verify_team(team_dir)
    bench_photos = verify_photos(bench_dir, load_manifest(BENCH_HASHES))
    print(f"Verified {len(photos)} team photos and {len(bench_photos)} bench photos", flush=True)

    loaded = model.load()
    team_faces: list[LabelledFace] = []
    faces_per_photo: dict[str, int] = {}
    extras: list[str] = []
    detection_misses: list[str] = []
    crops = 0
    for photo in photos:
        image = stage_1(team_dir / photo.path)
        found = detect(image, loaded, min_score=DETECTION_FLOOR)
        faces_per_photo[photo.path] = sum(f.score >= DETECTION_SCORE for f in found)
        labelled, extra = assign(photo, found)
        if not labelled:
            detection_misses.append(
                f"{photo.path} wants {len(photo.people)} and found {len(found)}"
            )
        team_faces += labelled
        # By identity: a DetectedFace holds an array, so == between two is not a bool.
        unlabelled = {id(f) for f in extra}
        for i, f in enumerate(found):
            if id(f) in unlabelled:
                extras.append(f"{photo.path} has another face at {f.score:.3f}, not labelled")
            if CROP_RANGE[0] <= f.score < CROP_RANGE[1] or id(f) in unlabelled:
                _save_crop(image, f, out_dir, _crop_name(photo.path, i, f))
                crops += 1
        print(f"{photo.path}: {len(found)} faces", flush=True)

    bench: dict[str, list[DetectedFace]] = {}
    for path, _ in bench_photos:
        image = stage_1(path)
        found = detect(image, loaded, min_score=DETECTION_FLOOR)
        bench[path.name] = found
        for i, f in enumerate(found):
            if CROP_RANGE[0] <= f.score < CROP_RANGE[1]:
                _save_crop(image, f, out_dir, _crop_name(path.name, i, f))
                crops += 1
        print(f"{path.name}: {len(found)} faces", flush=True)

    result = analyse(team_faces, bench, faces_per_photo=faces_per_photo)
    print(f"\nCrops in {out_dir}")
    return report(result, extras, detection_misses, crops)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="S-26: measure arch §6's thresholds (D-173).")
    parser.add_argument("team_dir", type=Path, help="the team's photos, outside the repo")
    parser.add_argument("bench_dir", type=Path, nargs="?", help="the 17 bench photos")
    parser.add_argument(
        "--write-manifest",
        action="store_true",
        help=f"write {TEAM_HASHES.name} from the team folder and stop",
    )
    parser.add_argument(
        "--out", type=Path, help="where the crops go; defaults to calibration-crops next to it"
    )
    args = parser.parse_args(argv)
    team_dir = args.team_dir.resolve()
    try:
        check_outside_repo(team_dir)
        if args.write_manifest:
            parse_layout(team_dir)
            write_manifest(team_dir)
            print(f"Wrote {TEAM_HASHES} for {len(_team_files(team_dir))} photos")
            return 0
        if args.bench_dir is None:
            parser.error("give the bench folder, or --write-manifest")
        out_dir = args.out or team_dir.parent / "calibration-crops"
        return 0 if run(team_dir, args.bench_dir, out_dir) else 1
    except CalibrationError as error:
        print(f"calibrate: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
