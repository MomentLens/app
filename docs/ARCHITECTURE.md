# MomentLens architecture

> The current state of the system: tables, R2 keys, jobs, thresholds, deployment. Why something is this way lives in `DecisionLog.md`. What a feature does lives in `Idea.md`.

**Owner: unassigned.** Assign one in Phase 0 (P0-6). The owner updates this file in the same PR that changes what it describes.

**Status: skeleton, 2026-09-13.** Generated from the spec, the handbook and the decision log. No migration exists yet, so nothing here was read from code. Every filled line cites its source. Column lists hold only the columns the docs already name and are incomplete on purpose. **Open** marks anything undecided. The owner should read the whole file once and correct it before anyone builds on it.

---

## 1. Data model

Types, constraints and indexes get written here as each slice's migration merges.

**Two rules that apply to every table.**
- API queries run as the caller, through RLS. The secret key is limited to the worker and one API module (D-71). A policy that is too loose leaks through the API as well as through Realtime.
- Every RLS policy has a negative test, run through the API and directly against Supabase (Handbook §11).

### `event`
- Columns named so far: start and end (§4.3), venue and coordinates (§4.3, §4.5), verification radius (§4.3), approval mode (§4.4), album state open or closed (§4.9), soft-delete timestamp (§4.21)
- RLS: visible only to members of the event (Handbook §5)

### `membership`
- Columns named so far: `role` (admin, photographer, guest), `admin_verified_at` for Force Verify (D-15)
- RLS: a user reads their own rows; the Admin reads every row for their events (Handbook §5)

### `media`
- Columns named so far: `processed_at` (album visibility, D-55), `variant_version` integer (D-60), `width` and `height` (D-22), `uploader_role_at_upload` (display only, D-13), SHA-256 content hash, indexed per event (D-53), upload keys written by the API (D-70), public file key and public thumbnail key written by the worker (D-69, D-70), soft-delete timestamp (§4.21)
- RLS: `SELECT` for any event member, except a Photographer, who sees only rows they uploaded. `UPDATE` and `DELETE` for the uploader and the event's Admin (Handbook §5)
- The album query adds `processed_at IS NOT NULL` (D-55). `uploader_role_at_upload` never appears in a policy or a routing branch (D-13)

### `subject`
- The person a blur applies to, with a nullable FK to the auth user from the first migration (D-63)
- RLS: **Open**

### `dnp_subject`
- Which subject is a Do Not Publish subject on which media row, holding that subject's variant key and variant thumbnail key (D-57, D-69)
- RLS: **Open, and it matters.** Handbook §5 wants event members to learn that a photo has personalization without learning who the subject is. RLS filters rows, not columns, a Realtime change event carries the whole row, and the per-subject key contains `subject_id` (D-60). A row other members can read therefore names the subject. Two ways out, to settle in S-21. Either only the subject and the worker read these rows, and the serving endpoint tells the client whether it received a personalized file. Or members read a view without the identity and key columns, and Realtime is not enabled on the base table

### `face_reference`
- A user's reference embeddings, with `is_curated` (D-54)
- RLS: the owner and the worker only. Never exposed through a user-facing endpoint (Handbook §5)

### `VenueVerification`
- One row per user per sub-event, written only by the server after it re-validates the GPS reading or QR payload (D-15, D-16, D-17)
- RLS: **Open**

### Needed by the spec, no table named yet
- **Detected faces.** Media row, bounding box, embedding, matched subject if any. `reprocess` never re-detects (D-66), so it needs the stored box as well as the embedding to re-blur (D-30). Unknown-person clustering reads it too (§4.11). Where similarity search runs, pgvector in Postgres or in the worker: **Open**
- Sub-events (§4.3)
- Invite links and shortcodes, one per role per event (§4.4)
- Venue QR secrets, one per venue (§4.5)
- Join requests (§4.4)
- Manual blur requests with Confirm and Revert state (§4.11)
- Photo flags (§2.5)
- Consent version per user (§4.18)
- Profile photo and reference photos (§4.2)

---

## 2. R2 object keys

One builder per key family (D-70). Whatever serves a file reads its key from the column and never rebuilds it. The bucket is private, and presigned GET URLs live one hour (§4.13).

| Family | Built by | Stored on | Shape |
|---|---|---|---|
| Upload, original photo | API, one function, at pre-flight | `media` | **Open**, set in S-12 |
| Upload, client thumbnail | API, same function | `media` | **Open**, set in S-12 |
| Public blurred file | worker | `media` | `{media_id}/public_v{n}.jpg` (D-60) |
| Per-subject file | worker | `dnp_subject` | `{media_id}/{subject_id}_v{n}.jpg` (D-60) |
| Public blurred thumbnail | worker | `media` | **Open**, set in S-21. Must carry `v{n}` (D-69) |
| Per-subject thumbnail | worker | `dnp_subject` | **Open**, set in S-21. Must carry `v{n}` (D-69) |

For a photo with no Do Not Publish face, the public keys point at the upload keys and no extra files exist (§4.11). Nothing is ever overwritten in place (D-60, D-69).

---

## 3. Upload pipeline

Spec §4.8, Handbook §7.

1. **Client.** EXIF strip keeping timestamp and orientation, HEIC to JPEG, resize only past 4096px, 300px WebP thumbnail, SHA-256 over the upload bytes with `expo-crypto`. Identical for every role (D-58).
2. **Pre-flight, JSON only.** Hash, album ID, sub-event ID, capture-time GPS. Express rejects an exact duplicate silently, then checks verification: `VenueVerification` row OR `admin_verified_at IS NOT NULL` OR `role = 'photographer'` (D-15). Both lookups indexed.
3. **Keys and URLs.** Express builds both upload keys, inserts the media row with them, and presigns two PUT URLs (D-70).
4. **Upload.** The client PUTs the photo and the thumbnail to R2, one photo at a time per session, then calls completion.
5. **Enqueue.** Completion enqueues exactly one pgmq job: `thumbnail_dims` until S-21, `face_process` after (D-72).
6. **Publish.** The worker sets `processed_at` last. The row becomes album-visible and Realtime delivers it (D-55).

Until verification passes, photos wait in the device's SQLite queue. The queue is per device (§4.1).

---

## 4. Worker jobs

| Job | Trigger | Exists | Writes |
|---|---|---|---|
| `thumbnail_dims` | Upload completion | S-18a until S-21 (D-72) | `width`, `height`, public keys pointed at the upload keys, a worker thumbnail only if the client's is missing, `variant_version`, then `processed_at` |
| `face_process` | Upload completion | From S-21 | Face boxes and embeddings, dimensions. Matches against Do Not Publish subjects who are members of this event. On any match, N+1 blurred files and N+1 blurred thumbnails at `v{n}`. Then `processed_at` |
| `reprocess` | Do Not Publish activated; manual blur confirmed or reverted | S-25 | Matches stored embeddings only, never detects (D-66). Regenerates files and thumbnails for matched photos, bumps `variant_version` |

- Blur: box expanded 30 to 40%, elliptical mask, downsample then upsample plus a box blur (D-65)
- Model: InsightFace through ONNX Runtime, loaded once at startup (D-40). `buffalo_l` or `buffalo_s`: **Open** until measured
- One worker process per machine (Handbook §6)
- Scheduled work, such as the §4.21 retention deletion: **Open**, no runtime assigned

---

## 5. Similarity thresholds

**Not measured.** Never use a number from any spec draft (Handbook §11).

| Threshold | Used by | Value | Measured on | Date |
|---|---|---|---|---|
| Production match | `face_process`, `reprocess`, Find My Photos | not measured | | |
| Loose manual-blur threshold, curated references only | Tap-to-blur abuse check (D-23, D-54) | not measured | | |

Plan (S-26): about 30 photos of the three team members in varied light, same-person and different-person cosine distributions, measured on the M1. Record next to the numbers that three people is a small sample and the thresholds are fitted to the demo set (Handbook §11).

---

## 6. Deployment

| | Production | Demo |
|---|---|---|
| Compute | Oracle Always Free ARM, `VM.Standard.A1.Flex`, Singapore (D-38). Not provisioned | The M1 behind a Cloudflare named tunnel (D-50, D-51). Not set up |
| Processes | `momentlens-api.service` and `momentlens-worker.service` under systemd, nginx, certbot (Handbook §13) | The development commands |
| API hostname | **Open** | **Open** |
| Supabase project | **Open.** Handbook §13 keeps dev work on the dev project, and D-50 has teammates developing against this box | stable |
| R2 bucket | **Open**, one bucket or one per Supabase project | **Open** |

- **Supabase.** Two projects, dev and stable (Handbook §13). Keep-alive runs as a GitHub Actions scheduled workflow (D-67). Neither exists yet
- **Mobile builds.** EAS profiles `development`, `preview` and `production` in `apps/mobile/eas.json`. All three build an Android APK with internal distribution, because the demo phones get the app by sideload (D-61)
- **Fallback.** Azure student credit, not provisioned. It needs `scripts/provision.sh`, a written DNS record and one rehearsal before it counts (Handbook §13)
- **DNS.** Registrar **Open**, A record **Open**. TTL 300s at least a week before the defense (Handbook §13)
