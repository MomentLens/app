# MomentLens architecture

> The current state of the system: data access, tables, R2 keys, jobs, thresholds, deployment. Why something is this way lives in `DecisionLog.md`. What a feature does lives in `Idea.md`.

**Owner: Ukasha** (D-75). Agents write this file and Ukasha decides what it says.

- Change it only to record a decision Ukasha made, citing the D-entry, or what merged code actually does, in the same PR as that code.
- If the code and this file disagree, stop and ask. Never edit the file to match the code.
- Anything undecided is marked **Open**. Ask Ukasha instead of filling it in.
- Ukasha reviews every PR that touches this file.

**Status, 2026-09-16.** One migration exists, for `health_check`, which is infrastructure rather than a feature table. Every other table below is planned. When a table's migration merges, add the migration file name under its heading.

---

## 1. Data access

Decided in D-73.

- **The app** uses Supabase for Auth and for Realtime on `media` and `event`. Every other read and write goes through the API.
- **The API** queries with the secret key and makes every authorization decision in its service layer. Every endpoint has a negative authorization test: another user, another event, the wrong role.
- **The worker** connects with `DATABASE_URL` and scopes its own queries to the event.
- **RLS** is on for every table. The only policies are `SELECT` on `media` and `event`. A direct query from the app on any other table returns empty rows, not an error.
- Those two policies exist for Realtime and nothing else. The app still reads `media` and `event` through the API, because the API applies what a policy cannot: soft deletes, pagination and the viewer-scoped face rules.
- Those two policies check membership through a `security definer` function. `membership` has no policy of its own, so a plain subquery inside a policy would see no rows and deny everyone.
- pgmq queues are not exposed through the Data API, so anything the API must do in one transaction, such as completing an upload and enqueueing its job, is a SQL function it calls with `rpc` (D-95).
- The RLS negative test, `apps/api/tests/integration/rls.test.ts`, runs in CI against the dev project on every pull request that touches `supabase/` or `apps/api/` (D-106). The stable project's secret key never reaches GitHub.

### Who may see what

The API enforces every rule here. The two marked rows are also RLS policies.

| Data | Rule |
|---|---|
| `media` | Active members of the event, once `processed_at` is set or if they uploaded it. A Photographer sees only their own uploads (§4.10, D-55). Update and delete by the uploader and the event's Admin. **Also an RLS policy.** Soft-deleted rows stay visible to it so Realtime delivers the deletion; the API's queries exclude them and the app drops a row when an update sets `deleted_at`. A row without `uploaded_at` is shown to nobody (D-82) |
| `event` | Active members. **Also an RLS policy**, so opening and closing the album reaches every phone live |
| `membership` | A user sees their own rows; the Admin sees every row for their events (Handbook §5) |
| `face`, `dnp_subject` | Only through the viewer-scoped rule (root invariant 4). A Do Not Publish subject learns they are in a photo; no other viewer learns who is. A Photographer gets no `face` rows, for their own photos too (§4.10, D-08) |
| `face_reference` | The owner, and only their own rows. Once the owner's subject has Do Not Publish active nobody sees the photos, the owner included, and the owner gets each row's status only (D-109). Embeddings never leave the database and the worker (Handbook §5) |
| `manual_blur_region` | Any Guest or the Admin draws one on a photo they can see; its drawer or the Admin removes it. Only the Admin lists them, with who drew each, in the Review Queue (D-83) |
| `venue.qr_secret` | The event's Admin, for printing (D-17) |
| `profile.avatar_key` | The user, and the same people as `profile.full_name`, so a Photographer sees no other member's (D-08). Nobody at all once the user's subject has Do Not Publish active, the user and the Admin included (D-35, D-109) |
| `profile.full_name` | Active members of an event the user belongs to, and that event's Admin while the user's join request is pending. Do Not Publish does not hide it (D-35). A Photographer sees no other member's name, since the name list is the guest list (D-08) |
| `health_check` | The API only, for `GET /health`. RLS is on with no policy, so the publishable key reads no rows, and both the keep-alive and `apps/api/tests/integration/rls.test.ts` check that |

---

## 2. Tables

Planned, not migrated, except `health_check`. Table names are singular snake_case. Every table has an `id` (uuid) and `created_at` unless it says otherwise. The columns listed are the ones the design depends on; migrations add the rest.

### `profile`
One row per auth user, keyed by `user_id`.
- `full_name`, `avatar_key` (§4.2)
- Created by a trigger on `auth.users` from the signup's `full_name`, trimmed and 1 to 80 characters, so every account has one. `ON DELETE CASCADE` to `auth.users` (D-109)
- `notify_approval`, `notify_album` for the two push channels (§4.16, §4.19). The sender checks them before sending. "Upload over Mobile Data" and the default Viewfinder mode are not here; they live on the phone (D-105). Both default to true (D-109)

### `push_token`
- `user_id`, `expo_push_token`

### `subject`
The identity that reference photos and Do Not Publish attach to, split from the account in S-01's migration, the first after `health_check` (D-63).
- `user_id`, nullable, unique where not null, `ON DELETE CASCADE` to `auth.users` (D-109). Null only for the deferred Proxy Blur
- `dnp_activated_at`, nullable. Set once and never cleared (D-31)
- Created when a user adds their first reference or profile photo. Activation needs at least one accepted `face_reference` row, and while Do Not Publish is active the API refuses to delete the last one (D-56, D-87)

### `face_reference`
- `subject_id`, `source` (`profile`, `reference`), `photo_key`
- `status` (`pending`, `accepted`, `rejected`), `reject_reason` (`no_face`, `multiple_faces`), `embedding vector(512)`, null until accepted (D-91)
- The API inserts the row as `pending` when the photo is uploaded. `reference_process` sets `accepted` with the embedding when it finds exactly one face, and `rejected` with the reason otherwise. Only `accepted` rows are matched against or counted (D-87, D-91)
- At most 5 `reference` rows per subject that are not rejected (§4.2). A new profile photo does not replace the `profile` reference once Do Not Publish is active (§4.2)
- A `profile` row's `photo_key` is the profile's `avatar_key` at the time it was set: the same object, never a copy
- Setting a profile photo is one SQL function called with `rpc` (D-95). It writes `avatar_key`, creates the subject if there is none, and while Do Not Publish is off inserts the `profile` reference and sends its `reference_process` message. S-20 builds it (D-109)
- When the owner removes a reference, the API deletes the row, which takes its embedding, and deletes its object unless it is the profile photo still in use. Then it enqueues `reprocess` for the subject
- There are no auto-added references (D-83)

### `event`
- `name`, `type`, `description`, `cover_key`
- No start or end of its own. The event runs from its first sub-event's start to its last sub-event's end, computed on read, at most 14 days (§4.17, D-88). So it has at least one sub-event
- `venue_id`, `verification_radius_m` (50 to 2000, default 200, §4.3)
- `approval_mode` (`auto`, `manual`, §4.4), `album_open` (false at creation, §2.1)
- `deleted_at`, `archived_at` (§4.21)

### `venue`
- `event_id`, `name`, `lat`, `lng`, `qr_secret`
- One Venue Check-In QR per venue. Sub-events that share a venue share its QR (§4.3). The payload carries the venue and its secret; a scan verifies the sub-event at this venue that was In Progress at the scan time (D-85)

### `sub_event`
- `event_id`, `name`, `description`, `starts_at`, `ends_at`, `venue_id`
- At most 15 per event (§4.3). A delay moves `starts_at` and `ends_at`
- Status is computed on read and never stored: In Progress from `starts_at` until `ends_at` (§4.3, D-88). Inside the event there can be times when none is In Progress. One pure function in `packages/shared-types` computes it for the app and the API (D-105)
- Deleted only while it has no photos, and never the event's last one. An edit moves no photo and no `venue_verification` row. Other phones see an edit or a Delay on their next fetch of the event; there is no Realtime on this table (D-100)

### `membership`
- `event_id`, `user_id`, unique together
- `role` (`admin`, `photographer`, `guest`), `status` (`pending`, `active`, `blocked`, `removed`)
- Exactly one `admin` row per event, its creator's. A role change moves someone between `guest` and `photographer` only (D-102)
- `admin_verified_at` (Force Verify, D-15), `last_viewed_at` (the "new since last visit" dot, §2.5)
- A join request is a `pending` row. Approve sets `active`, reject or cancel deletes the row, block sets `blocked` (§4.4). At most 150 `active` guest rows per event; the Admin and Photographers do not count (§4.17, D-102)
- Remove from Event sets `removed`: the person sees Access Removed, their uploads stay, and a live invite lets them join again. A `blocked` person cannot rejoin (D-102)

### `invite`
- `event_id`, `role` (`guest`, `photographer`), `token`, `shortcode` (6 characters), `revoked_at`
- Revoke and regenerate sets `revoked_at` and inserts a new row (§4.4)
- An invite is dead once `revoked_at` is set or its event is deleted or archived, and that is what the Join Error screen calls expired. There is no time limit
- The link is `momentlens://invite/{token}` (D-101)

### `venue_verification`
The spec's `VenueVerification`, renamed to the naming convention.
- `user_id`, `sub_event_id`, unique together; `method` (`gps`, `qr`), `verified_at`
- Written only by the API, after it re-validates the GPS reading or QR payload (D-16, D-17)

### `media`
- `event_id`, copied from the sub-event at pre-flight and never taken from the request; `sub_event_id`, `uploader_user_id`, `uploader_role_at_upload` (display only, D-13)
- `captured_at`, the photo's EXIF capture time sent with pre-flight, or the pre-flight time when it has none (D-98)
- `content_hash`, SHA-256, unique per event among rows with `uploaded_at` set, soft-deleted rows included (D-53, D-96)
- `size_bytes`, from R2's HEAD at completion (D-95). The Photographer's storage figure sums it (§4.10)
- `upload_key`, `upload_thumb_key`, written by the API at pre-flight (D-70)
- `uploaded_at`, set by `complete_upload` only while it is null, in the same transaction as the enqueue (D-82, D-95)
- `public_key`, `public_thumb_key`, `variant_version` (integer), `width`, `height`, written by the worker (D-22, D-60, D-69, D-70)
- `processed_at`, written last by the worker (D-55); `deleted_at` (§4.21)
- At most 2,000 per event (§4.17). Local Only photos never create a row (§4.12)

### `face`
One row per detected face, written only by the worker.
- `media_id`, `bbox` as fractions of the stored image, which Stage 1 already turned upright (D-99), `embedding vector(512)`
- `matched_subject_id` (nullable), `similarity` (D-74)
- `cluster_id`, the Unknown identity for an unmatched face (§4.11)
- `reprocess` re-blurs from the stored `bbox` and never detects again (D-30, D-66)

### `dnp_subject`
A Do Not Publish subject found in a photo, with that subject's personalized files. Written only by the worker.
- `media_id`, `subject_id`, unique together
- `variant_key`, `variant_thumb_key`, at the media row's `variant_version` (D-57, D-60, D-69)

### `manual_blur_region`
A rectangle someone drew to hide part of a photo, usually a face the detector missed (D-83).
- `media_id`, `drawn_by_user_id`, `x`, `y`, `width`, `height` as fractions of the stored image, so one row fits every file of the photo (D-99)
- Adding or deleting a row enqueues `blur_region`. Removing one deletes the row
- Every file the worker writes for the photo applies every row, on every regeneration (root invariant 6)

### `photo_flag`
- `media_id`, `flagged_by_user_id`, `state` (`open`, `kept`, `removed`) (§2.5)

### `consent`
- `user_id`, `policy_version`, `accepted_at`. The app blocks with the consent screen when the current version has no row (§4.18)

### `health_check`
Infrastructure, not a feature table. Migration `supabase/migrations/20260916154203_create_health_check.sql`.
- One row, seeded by the migration. `id` is a `smallint` held at 1 by a check constraint, the exception to the uuid rule above
- RLS on with no policy (D-73). `GET /health` reads the row with the secret key; the keep-alive reads it with the publishable key and must get no rows
- `SELECT` is granted to `anon`, `authenticated` and `service_role` explicitly, so neither reader depends on whether the project exposes new tables to the Data API by default

---

## 3. R2 object keys

Two buckets, `momentlens-dev` and `momentlens-stable`, one per Supabase project, so no row ever points at another environment's files. Both are private. Presigned GET URLs live one hour (§4.13) and presigned PUT URLs 15 minutes (D-105). Each key family has one builder (D-70). No object a row points at is overwritten (D-60). A resumed upload re-PUTs its own upload keys, which nobody can read before `uploaded_at` is set (D-82), and a retried job may rewrite a versioned key no row points at yet (D-103).

| File | Built by | Stored in | Key |
|---|---|---|---|
| Photo as uploaded | API | `media.upload_key` | `{media_id}/upload.jpg` |
| Client thumbnail | API | `media.upload_thumb_key` | `{media_id}/upload_thumb.webp` |
| Public blurred file | worker | `media.public_key` | `{media_id}/public_v{n}.jpg` (D-60) |
| Public blurred thumbnail | worker | `media.public_thumb_key` | `{media_id}/public_thumb_v{n}.webp` |
| Subject's file | worker | `dnp_subject.variant_key` | `{media_id}/{subject_id}_v{n}.jpg` (D-60) |
| Subject's thumbnail | worker | `dnp_subject.variant_thumb_key` | `{media_id}/{subject_id}_thumb_v{n}.webp` |
| Event cover | API | `event.cover_key` | `events/{event_id}/cover_{upload_id}.jpg` |
| Profile photo | API | `profile.avatar_key` | `users/{user_id}/avatar_{upload_id}.jpg` |
| Reference photo | API | `face_reference.photo_key` | `users/{user_id}/reference_{upload_id}.jpg` |

- For a photo with no Do Not Publish face and no blur region, `public_key` and `public_thumb_key` hold the upload keys (§4.11). If the client's thumbnail is missing, the worker writes one at the public thumbnail key.
- Cover, profile and reference keys carry a fresh `upload_id`, so a replacement lands at a new key and no cache keeps the old image.
- Every file the app sends reaches R2 by a presigned PUT, covers, profile photos and reference photos included (root invariant 5). The worker writes its own files directly.
- After a regeneration commits, the worker deletes the objects the rows no longer point at, and never `upload_key` or `upload_thumb_key` (D-103).
- Media files are served by the one image-serving endpoint (D-57). S-13 builds it with the public file only, and S-21 adds the subject's file and the own-variant flag (D-93). With each presigned URL it returns a cache key, built from the object key it signed plus `variant_version`, and whether the file is the requester's own variant, which drives the self-visible marker. It takes a batch of media ids (D-86).
- Covers and profile photos are presigned by the endpoint that returns the event or the profile, after that endpoint's own check (§1). A reference photo is presigned only for its owner, and for nobody once Do Not Publish is active (§1).

---

## 4. Upload pipeline

Spec §4.8, Handbook §7.

1. **Client.** Orientation applied to the pixels, then an EXIF strip keeping only the timestamp (D-99), anything not JPEG to JPEG, resize only past 4096px, a WebP thumbnail 300px on its long edge, SHA-256 over the upload bytes with `expo-crypto`. Identical for every role (D-58, D-105).
2. **Pre-flight, JSON only.** Hash, sub-event ID, the capture time (D-98), and any verification records the device holds: a GPS reading or a Venue QR scan, each with its time (D-85, D-89). The photo itself carries no location. The API checks, in order (D-82):
   - the caller is an `active` member, the event is not deleted, and `album_open` is true (D-12). S-12 builds the album check switched off and S-31 turns it on
   - the hash. A row with this hash and `uploaded_at` set, deleted or not, is an exact duplicate, rejected silently. The caller's own row with no `uploaded_at` is a crashed upload: pre-flight re-signs its existing keys and stops there. Another user's unfinished row is ignored (D-53, D-96)
   - for a new row only: verification passes, meaning a `venue_verification` row OR `admin_verified_at IS NOT NULL` OR `role = 'photographer'` (D-15), and the event holds fewer than 2,000 media rows that are not soft-deleted, finished or not, counted inside `start_upload` with the event row locked (§4.17, D-95)
   All of these are indexed lookups.
3. **Keys and URLs.** The API builds both upload keys, `start_upload` inserts the media row with them, and the API presigns two PUT URLs that live 15 minutes (D-70, D-95).
4. **Upload.** The client PUTs the photo and the thumbnail to R2, one photo at a time per session, then calls completion.
5. **Complete and enqueue.** The API sends R2 a HEAD for both objects and answers `upload_missing` if either is absent. Then `complete_upload` checks the caller uploaded the row, sets `uploaded_at` where it is null, stores `size_bytes`, and sends exactly one message to the `jobs` queue, all in one transaction: `thumbnail_dims` until S-21, `face_process` after (D-72, D-95). A repeated call changes nothing and answers `completed`. If another finished row already has the hash, it deletes this row, the API deletes its two objects, and it answers `duplicate` (D-96).
6. **Publish.** The worker sets `processed_at` last. The row passes the `media` policy and Realtime delivers it to every member (D-55).

Until verification passes or while the album is closed, photos wait in the device's SQLite queue. The queue is per device and per account (§4.1).

**What each answer does to a queued photo.** S-11 builds this loop, and it is the upload queue's state machine, a human-read surface (D-68, D-97). Status codes and error bodies follow Handbook §5.3. My Media's badges are clock for queued, spinner for uploading or processing, check for published (§2.5.3).

| Answer | The queued photo | It moves on when |
|---|---|---|
| Pre-flight 200, new row or resume, with two PUT URLs | uploading | both PUTs finish, then completion |
| A PUT fails, or the app dies mid-upload | queued | the next attempt, whose pre-flight answers resume (D-82) |
| No answer: offline, a timeout, a 5xx | queued | reconnect or foreground, with backoff |
| Pre-flight 409 `duplicate` | leaves the queue, no prompt | never |
| Pre-flight 409 `album_closed` | queued, waiting on the album | an event fetch shows the album open |
| Pre-flight 409 `unverified` | queued, waiting on verification | the local GPS or QR check passes, or an event fetch shows the person verified (§4.5) |
| Pre-flight 422 `event_full` | stays in My Media with "This event is full" | never; the person can delete it |
| Pre-flight 403 or 404: not an active member, or the event is deleted | stays in My Media, stopped | an event fetch shows the membership active again |
| Completion 200 `completed` | uploaded; spinner until `processed_at` is set, then the check | never |
| Completion 409 `upload_missing` | uploading: both files again | both PUTs finish, then completion |
| Completion 409 `duplicate` | leaves the queue, no prompt | never |

---

## 5. Worker jobs
<!-- abstract: Five pgmq jobs: thumbnail_dims, face_process, reference_process, reprocess and blur_region, with their triggers, plus blur geometry, the model and the one-process-per-machine rule. -->

Every job is a message on one pgmq queue, `jobs`: `{ "job": "<name>" }` plus the ids in the second column. The worker handles one message at a time, oldest first (D-103).

| Job | Message ids | Trigger | Does |
|---|---|---|---|
| `thumbnail_dims` | `media_id` | Upload completion, from S-18a until S-21 (D-72) | No ML. Writes `width` and `height`, points the public keys at the upload keys, bumps `variant_version`, sets `processed_at` last |
| `face_process` | `media_id` | Upload completion, from S-21 | Detects faces once and stores each box and embedding. Matches every face against subjects with references who are active members of the event, and clusters the unmatched ones (D-74). If a matched subject has Do Not Publish active, writes N+1 blurred files, N+1 blurred thumbnails and the `dnp_subject` rows. Writes dimensions, bumps `variant_version`, sets `processed_at` last |
| `reference_process` | `face_reference_id` | A reference photo added; a profile photo set while Do Not Publish is off | Accepts the photo with its embedding when it shows exactly one face, or rejects it as `no_face` or `multiple_faces` (D-91). Then enqueues `reprocess` for that subject. A removed reference never reaches this job: the API deletes it (§2) |
| `reprocess` | `subject_id`, and `event_id` when a join triggered it; without one it covers every event the subject is an active member of | Do Not Publish activated; a subject's references changed, a removal included; a subject with references became an active member of the event (D-84) | Re-matches stored embeddings and never detects (D-66). For every photo whose set of Do Not Publish subjects changed, regenerates the public file, every subject's file and all their thumbnails with every stored region, and bumps `variant_version` (spec §4.11.4.5) |
| `blur_region` | `media_id` | A `manual_blur_region` row added or deleted (S-19) | No ML. Regenerates that photo's public file, every subject's file and all their thumbnails with every stored region, at new versioned keys, and bumps `variant_version` (D-83) |

- **Blur.** Box expanded 30 to 40%, elliptical mask, downsample then upsample with a box blur on top (D-65). A blur region is blurred with the same strength over exactly the rectangle drawn. Thumbnails are cut from the blurred output.
- **Regions survive every regeneration.** `face_process`, `reprocess` and `blur_region` all apply the photo's stored regions. None of them regenerates from the bare upload alone (root invariant 6).
- **Model.** InsightFace through ONNX Runtime, loaded once at startup (D-40). `buffalo_l`, detection and recognition modules only (D-92).
- **Processes.** One worker process per machine, one message at a time (Handbook §6, D-103).
- **Failures.** A message that fails three times is archived and logged, and reported to Sentry once the worker has it. If it names a photo, the worker also clears that photo's `processed_at`, so the photo leaves the album and never stays up with files a failed job should have replaced. To run the job again, send the archived message from pgmq's archive for `jobs` back to `jobs` (D-103, D-108).
- **Cleanup.** After a regeneration commits, the worker deletes the objects the rows no longer point at, never the upload keys (D-103).
- **Scheduled work.** None in demo scope. Retention deletion (§4.21) appears in no demo beat (D-44). If it gets built, `pg_cron` enqueues a daily pgmq message and the worker deletes the objects and rows.

---

## 6. Similarity thresholds

**Not measured.** Never use a number from any spec draft (Handbook §11.4). Until a value is recorded here, the worker fails closed: it blurs every detected face in every file it writes, subjects' own files included, and records no match on `face` rows. Tests set a threshold in their own fixtures, never in configuration (D-104).

| Threshold | Used by | Value | Measured on | Date |
|---|---|---|---|---|
| Match | `face_process`, `reprocess` | not measured | | |
| Unknown clustering | `face_process` | not measured | | |

**Open**, to settle with the measurements in S-26: whether Do Not Publish blurring uses a lower match threshold than recognition, since §4.11 biases blurring toward a match when uncertain.

Plan (S-26): about 30 photos of the three team members in varied light, same-person and different-person cosine distributions. Record next to the numbers that three people is a small sample and the thresholds are fitted to the demo set (Handbook §11.4).

---

## 7. Deployment
<!-- abstract: Development and demo side by side: Netcup server from 2026-10-15, Oracle trial until then, the two systemd units, both Supabase projects, both R2 buckets and the api.momentlens.me DNS and TLS setup. -->

| | Development | Demo |
|---|---|---|
| Compute | Netcup RS 1000 G12 root server, x86-64, in Nuremberg, from 2026-10-15 (D-78) | The same server (D-78) |
| Goes up | 2026-10-15, set up by `scripts/provision.sh` (Handbook §13) | One month before the demo (D-76) |
| Processes | `momentlens-api.service` and `momentlens-worker.service` under systemd, nginx, certbot (Handbook §13) | The same units against the stable project. How they sit beside development on one server is **Open** until Phase 7 |
| Supabase | dev project, `eu-central-1` (Frankfurt) | stable project, `eu-central-1` (Frankfurt) |
| R2 bucket | `momentlens-dev`, location hint `weur` | `momentlens-stable`, location hint `weur` |
| Serves | All three developers; the `development` and `preview` builds | The `production` build on the demo phones (D-61) |
| Hostname | `api.momentlens.me` | `api.momentlens.me` |

- **Until 2026-10-15.** Development runs on an Oracle Cloud Free Trial instance, a `VM.Standard.A1.Flex` with 4 OCPUs and 24 GB (ARM64) in US West (Phoenix). The trial covers that shape. Before the trial ends on 2026-10-15, delete the instance or resize it to 2 OCPUs and 12 GB, because otherwise Oracle disables every A1 instance in the tenancy and deletes them 30 days later. Remove this bullet once the Netcup server is up.
- **Domain.** `momentlens.me`, bought from Namecheap through the GitHub Student Pack, with DNS at Namecheap. The named tunnel was the only reason its DNS had to be on Cloudflare, and D-78 removed the tunnel. `api.momentlens.me` is an A record with a 300s TTL, pointing at the Oracle interim instance until 2026-10-15 and at the Netcup server after that. TLS is a certbot certificate issued on the server and renewed by certbot's timer (Handbook §13).
- **Regions, and why they are permanent.** Both Supabase projects are in `eu-central-1` (Frankfurt) and both buckets carry the `weur` location hint, matching the Nuremberg server. Neither can be corrected later. A Supabase project's region is fixed at creation, and R2 honors a location hint only the first time a bucket of that name is created, so deleting `momentlens-dev` and recreating it keeps the original location.
- **Demo-week fallback.** The rotated standby (D-79). Its `/srv/momentlens/.env` has to carry the stable project and bucket rather than a copy of the development server's, because the demo build logs in against stable.
- **Supabase keep-alive.** `.github/workflows/keepalive.yml`, daily at 04:17 UTC with a manual trigger, reads `health_check` in both projects through PostgREST with the publishable key on `apikey` alone (D-67). It fails the run on anything but 200, and when the response is not empty, because a row reaching the publishable key means RLS is broken. The stable project sits unused until the demo stack goes up and would pause without it. One trap: GitHub disables scheduled workflows in a public repository after 60 days with no repository activity, which stops this silently. `gh workflow enable keepalive.yml` brings it back.
- **Supabase Auth.** Both projects run the same settings, set by hand in each dashboard, and `supabase/config.toml` mirrors them for a local stack (D-109). Email confirmation is off, passwords need 8 characters, and `momentlens://reset-password` is in the redirect allow-list. Each project signs JWTs with an asymmetric key, so the API's `getClaims` checks tokens locally. Recovery mail goes through the built-in sender, which delivers only to the project team's addresses, 2 messages an hour. The access token lives 3600 seconds and refreshes itself. On the free plan refresh tokens never expire, and session time-box and inactivity timeout are Pro features, so a session ends at sign-out, a password change or a rejected refresh token (checked 2026-09-24). S-01's done stage confirms both dashboards match.
- **Mobile builds.** EAS profiles in `apps/mobile/eas.json`. `development` and `preview` use the dev environment variables, `production` uses stable. All three build an Android APK with internal distribution (D-61). The EAS project is `@momentlens/momentlens` (ID `5b7a8232-bb75-49ce-9e3a-64f52894e276`), owned by the `momentlens` organization. The app is MomentLens, with the URL scheme `momentlens` and `me.momentlens.app` as both the iOS bundle ID and the Android package.
- **Error reporting.** Sentry for Education, activated in September 2026 through the GitHub Student Developer Pack and free for one year. The organization is `momentlens` in the EU region (`de.sentry.io`), with the projects `momentlens-api` and `momentlens-app`. Both report uncaught errors only, with no tracing, no replay, no screenshots and no personal data. Each event carries an environment: `local` on a developer's machine, the EAS environment name in an EAS build, `development` from the dev server and `production` from the demo stack. The API sets it with `SENTRY_ENVIRONMENT` in `/srv/momentlens/.env`, and EAS builds with `EXPO_PUBLIC_SENTRY_ENVIRONMENT`. The worker has no Sentry yet.
- **Standby.** Not provisioned. Azure for Students, then AWS, then GCP, one credit at a time across the three members, with the VM created for the Phase 7 rehearsal and for demo week only (D-79). Two of Handbook §13's three criteria are met: `scripts/provision.sh` exists, and the DNS record is the bullet above. The rehearsal is still owed.
