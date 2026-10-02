# worker

Python 3.12. A **pgmq consumer**, not a web server written in FastAPI. Root `AGENTS.md` has the invariants; they apply here too.

Detail in Handbook §6, spec §4.11, and `docs/ARCHITECTURE.md` §2 (tables) and §5 (jobs).

---

## Shape

The main loop reads one message at a time from the one `pgmq` queue, `jobs`, oldest first, dispatches it to the handler its `job` field names, writes to Postgres and R2, and moves on (D-103). The loop runs on the main thread and `/health` on a side thread, and the process exits when the loop dies, so systemd restarts it. `/health` answers 503 once the loop has stopped. It is the only HTTP surface, so nginx and a human can ping it (D-123).

- **One reader.** The worker holds a Postgres advisory lock while it reads `jobs`. A second worker, such as yours while the dev server's runs, logs that the queue is taken and waits (D-123, Handbook §13.4).
- **A try is a read.** pgmq's `read_ct` counts tries, so a crash counts as one. After a failed try, wait, then read the same message again before any newer one. At startup, make every message a crash left hidden visible again (D-123).
- **Three failures archive the message**, log it and report it to Sentry. If it names a photo, clear that photo's `processed_at` in the same transaction as the archive, so a failed job never leaves a photo up with files it should have replaced (D-108). A missing upload object, a message that does not parse and an unknown job name are archived on their first try (D-123).
- **One transaction per job.** A job's row writes commit with its message's delete (D-123).

The worker connects to Postgres directly with `DATABASE_URL`, so RLS does not apply to it. Scope every query to the event yourself.

**Load the InsightFace model once at startup and keep it resident.** Cold-loading per job costs several seconds and is the most likely reason a demo feels slow.

**One worker process per machine** (`docs/ARCHITECTURE.md` §5). Leave CPU for Express, Postgres connections and nginx. Do not run two.

Use InsightFace's `buffalo_l` pack, the ONNX models it ships, not the PyTorch runtime (D-92).

---

## Jobs

| Job | Trigger | Work |
|---|---|---|
| `thumbnail_dims` | Upload completion, from S-18a (Phase 3) until S-21 removes it (D-72) | No ML. Only on a row whose `variant_version` is 0, otherwise delete the message as done. Write `width`/`height` read as stored, point the public file and public thumbnail at the upload keys, bump version, then `processed_at`, in one update. Writes no object, since completion refuses a photo without its thumbnail (D-122, D-123) |
| `face_process` | Upload completion, from S-21 | Detect once, store each face's box and embedding, match every face against subjects with references who are active members of this event, cluster the unmatched ones. If a matched subject has Do Not Publish active, write the public file, one variant per subject and a blurred thumbnail for each, at new versioned keys. Write dimensions. Then `processed_at` |
| `reference_process` | A reference photo added; a profile photo set while Do Not Publish is off | Accept the photo with its embedding when it shows exactly one face, otherwise reject it as `no_face` or `multiple_faces` (D-91). Then enqueue `reprocess` for that subject. A removed reference never reaches this job, because the API deletes it (`docs/ARCHITECTURE.md` §5) |
| `reprocess` | Do Not Publish activated, a subject's references changed, or a subject with references joined the event (D-84) | **Match only.** Compare stored embeddings against the reference set, regenerate files and thumbnails for photos whose output changed with every stored blur region applied, bump version |
| `blur_region` | A `manual_blur_region` row added or deleted | No ML. Regenerate that photo's public file, every subject's file and all their thumbnails with every stored region, at new versioned keys, bump version (D-83) |

---

## The rules inside those jobs

1. **`processed_at` is written last**, after every variant and thumbnail is in R2. It publishes the row. Written early, it publishes an unblurred photo. The one other write is clearing it after a final failure, which unpublishes the photo (D-108).
2. **Bump `variant_version` on every write, including the first**, and put it in every key you build. Shapes are in `docs/ARCHITECTURE.md` §3.
3. **Write the keys onto the rows as you upload them.** The API reads those columns. The worker builds every derived key and never an upload key; the API builds those (D-70).
4. **N subjects → N+1 files and N+1 thumbnails, never 2^N.** No viewer needs two subjects unblurred at once. A photo with no Do Not Publish face and no blur region produces no extra files; its public keys point at the upload.
5. **Never overwrite an object a row points at.** A regenerated file or thumbnail gets a new versioned key, or every client cache keeps the old one (D-60, D-69). A retry may rewrite a versioned key no row points at yet. Once the rows point at the new files, delete the objects they replaced, and never `upload_key` or `upload_thumb_key` (D-103).
6. **`thumbnail_dims` and `face_process` never run on the same upload.** Once Do Not Publish users exist, `thumbnail_dims` publishes a photo nobody blurred, or points the public keys back at the unblurred upload after `face_process` finished (D-72). It acts only on a row whose `variant_version` is 0, so a message re-sent from the archive never undoes another job's files (D-123).

---

## Detection and matching

- **One detection pass per photo.** Detection is never re-run, including in `reprocess`.
- **Store the bounding box with every embedding**, as fractions of the stored image's width and height. `reprocess` re-blurs without re-detecting, so the box has to exist already (D-30, D-66). The upload is already upright with no orientation tag, and blur regions use the same fractions (D-99), so read the pixels as they are and never apply an orientation.
- **Every similarity comparison in the system happens here, and the result is stored** (D-74). Embeddings are `vector(512)` columns. Each `face` row gets its matched subject, similarity and Unknown cluster. The API only reads those results, so thresholds live in exactly one codebase.
- **Do not re-detect on blurred output.** An earlier design did this to exclude Do Not Publish users from the Recognized Faces list. It doubled inference cost to avoid what is a read-time filter, and the premise was wrong: detectors do find heavily blurred head-shaped regions.
- **Matching is biased toward blurring when uncertain.** A missed match is the expensive failure; a false positive only blurs someone who did not ask, and that person stays blurred in the photo (spec §4.11.4.5).
- **Every file you write applies the photo's stored blur regions** (root invariant 6), blurred at D-65's strength over exactly the rectangle drawn. There are no auto-added references and no tap-to-blur (D-83).
- Matching is scoped to subjects who are **active members of this event**, never global.
- **Thresholds come from `docs/ARCHITECTURE.md` §6.** If they are not measured yet, say so. Do not invent one. The spec carries no numbers. Until §6 has a value, fail closed: blur every detected face in every file, subjects' own files included, and record no match. A test sets its threshold in its own fixture, never in configuration (D-104).

---

## Blur implementation

Two lines that a panel will ask about, so they are specified rather than left open:

- **Expand the detection box 30 to 40% and mask elliptically.** A tight InsightFace box leaves hair, ears, jawline and clothing visible, which at a wedding with a known guest list is still identifying.
- **Downsample then upsample, with a box blur on top.** A single light Gaussian pass is partially invertible; downsampling actually discards information.

Thumbnails are cut from the blurred output, never blurred separately at 300px.

---

## Local rules

- `requirements.txt` and `requirements-dev.txt` are exactly pinned, never ranges. The dev file adds Ruff and pytest and installs `requirements.txt` too. Locally, from `worker/`: `uv venv --python 3.12 && uv pip install -r requirements-dev.txt`, which `pnpm check:machine` verifies. The server builds its own from `requirements.txt` with `python3.12 -m venv` in `scripts/provision.sh`.
- `DATABASE_URL` is the Supabase session pooler's string on port 5432, because the advisory lock needs a session (D-123).
- InsightFace 2.0 installs as a pure-Python package, and `onnxruntime` and OpenCV ship wheels for x86-64 and ARM64. The server and the Windows machines are x86-64, and Ukasha's M1 is ARM64 (D-78). A wheel that installs in WSL2 should install on the server; one that misbehaves only on the server gets debugged on the server.
- Ruff replaces flake8, black and isort. One tool.
- Tests in `tests/`, pytest. CI fakes Postgres and R2. The real-SQL module runs against the dev project inside a transaction it rolls back, and skips without `DATABASE_URL` (D-123).
- Logs come out of `ssh momentlens 'journalctl -u momentlens-worker -f'` (Handbook §13.4). Write log lines somebody can grep at 2am.
