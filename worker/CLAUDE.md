# worker

Python 3.12. A **pgmq consumer**, not a web server written in FastAPI. Root `CLAUDE.md` has the invariants; they apply here too.

Detail in Handbook §6 and spec §4.11.

---

## Shape

The main loop polls `pgmq`, dispatches to a job handler, writes to Postgres and R2, and moves on. The HTTP surface is `/health` and nothing else, so nginx and a human can ping it.

The worker connects to Postgres directly with `DATABASE_URL`, so RLS does not apply to it. Scope every query to the event yourself.

**Load the InsightFace model once at startup and keep it resident.** Cold-loading per job costs several seconds and is the most likely reason a demo feels slow.

**One worker process.** On the 2-core Oracle instance the second core belongs to Express, Postgres connections and nginx. Do not run two.

Use the ONNX-exported models InsightFace ships, not the PyTorch runtime.

---

## Jobs

| Job | Trigger | Work |
|---|---|---|
| `thumbnail_dims` | Upload completion, from S-18a (Phase 3) until S-21 removes it (D-72) | No ML. Write `width`/`height`, point the public file and public thumbnail at the upload keys, generate a thumbnail at a worker key only if the client's is missing, bump version, then `processed_at` |
| `face_process` | Upload completion, from S-21 | Detect once, store each face's box and embedding, match against the Do Not Publish reference sets of this event's members. If any match, write the public file, one variant per subject and a blurred thumbnail for each, all at new versioned keys. Write dimensions. Then `processed_at` |
| `reprocess` | Do Not Publish activated, or a manual blur confirmed or reverted | **Match only.** Compare stored embeddings against the reference set, regenerate files and thumbnails for matched photos, bump version |

---

## The rules inside those jobs

1. **`processed_at` is written last**, after every variant and thumbnail is in R2. It publishes the row. Written early, it publishes an unblurred photo.
2. **Bump `variant_version` on every write, including the first**, and put it in every key you build: `{media_id}/public_v{n}.jpg`, `{media_id}/{subject_id}_v{n}.jpg`, and the thumbnail keys (`docs/ARCHITECTURE.md` §2).
3. **Write the keys onto the rows as you upload them.** The API reads those columns. The worker builds every derived key and never an upload key; the API builds those (D-70).
4. **N subjects → N+1 files and N+1 thumbnails, never 2^N.** No viewer needs two subjects unblurred at once. A photo with no Do Not Publish faces produces no extra files; its public keys point at the upload.
5. **Never overwrite an object in place.** A regenerated file or thumbnail gets a new versioned key, or every client cache keeps the old one (D-60, D-69).
6. **`thumbnail_dims` and `face_process` never run on the same upload.** Once Do Not Publish users exist, `thumbnail_dims` publishes a photo nobody blurred, or points the public keys back at the unblurred upload after `face_process` finished (D-72).

---

## Detection and matching

- **One detection pass per photo.** Every downstream feature (Find My Photos, Do Not Publish matching, the manual-blur abuse check) is a cosine comparison against embeddings you already stored. Detection is never re-run, including in `reprocess`.
- **Store the bounding box with every embedding.** `reprocess` re-blurs without re-detecting, so the box has to exist already (D-30, D-66).
- **Do not re-detect on blurred output.** An earlier design did this to exclude Do Not Publish users from the Recognized Faces list. It doubled inference cost to avoid what is a read-time filter, and the premise was wrong: detectors do find heavily blurred head-shaped regions.
- **Matching is biased toward blurring when uncertain.** A missed match is the expensive failure; a false positive is visible and fixable.
- **Reference sets are split.** Matching uses curated + auto-added. The manual-blur abuse check uses **curated only** (root invariant 6).
- Matching is scoped to Do Not Publish users who are **members of this event**, never global.
- **Thresholds come from `docs/ARCHITECTURE.md`.** If they are not measured yet, say so. Do not invent one and do not use the placeholders from the spec.

---

## Blur implementation

Two lines that a panel will ask about, so they are specified rather than left open:

- **Expand the detection box 30 to 40% and mask elliptically.** A tight InsightFace box leaves hair, ears, jawline and clothing visible, which at a wedding with a known guest list is still identifying.
- **Downsample then upsample, with a box blur on top.** A single light Gaussian pass is partially invertible; downsampling actually discards information.

Thumbnails are cut from the blurred output, never blurred separately at 300px.

---

## Local rules

- `requirements.txt` is exactly pinned, never ranges.
- `insightface` has Cython extensions and may need to compile from source on aarch64. `onnxruntime` and `opencv-python-headless` ship aarch64 wheels. The M1 and the Oracle instance are both ARM64, so local and production match.
- Ruff replaces flake8, black and isort. One tool.
- Tests in `tests/`, pytest.
- Logs come out of `journalctl -u momentlens-worker -f` in production. Write log lines somebody can grep at 2am.
