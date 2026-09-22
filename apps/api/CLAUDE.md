# apps/api

Express 5 + TypeScript. The only thing that decides "is this request allowed." Root `CLAUDE.md` has the invariants; they apply here too.

Detail in Handbook §5 and §7. Tables and who may see what: `docs/ARCHITECTURE.md` §1 and §2.

---

## Layering

`route → controller → service`. Routes define the HTTP surface, controllers parse and validate with zod, services hold business logic and talk to Supabase.

This is not ceremony. It means "is this event's guest limit reached" is testable without an HTTP server, and it is what keeps three people out of one giant `routes.ts`.

Auth middleware verifies the Supabase JWT with Supabase's server SDK and attaches the user to `req.user`. Do not hand-roll JWT verification. Nothing downstream re-checks identity.

Request and response shapes are zod schemas in `packages/shared-types`, imported by both sides. Generate the OpenAPI spec from them with `@asteasolutions/zod-to-openapi`.

---

## Supabase access (D-73)

The API uses the secret key for every query, so RLS never applies to it. Every authorization decision lives in the service layer: is the caller an active member of this event, what is their role, do they own this row. A missing check throws nothing and returns someone else's data.

Every endpoint ships with a negative authorization test: another user, another event, the wrong role. Those tests do the job RLS would otherwise do.

The app cannot read or write tables directly (root invariant 14). When a screen needs data, add an endpoint. Never add an RLS policy to make a client query work.

---

## The image-serving endpoint

The most sensitive authorization check in the system. A human reads it before it merges, and it ships with a negative test (D-68).

```
GET image or thumbnail for media X, requested by user U
  → is U a Do Not Publish subject on X?
      yes → presign U's variant key (or variant thumbnail key), read from the row
      no  → presign the public key (or public thumbnail key), read from the row
  → return, per media id: the URL, a cache key (the signed object key plus
    variant_version) and whether the file is U's own variant (D-86)
```

It takes a batch of media ids, so a grid page costs one request. The own-variant flag is what draws the self-visible marker; the app never learns who the subjects are.

Four ways to get this wrong, all of which look reasonable:

- Deriving "is this the subject" from anything the client sent. It comes from the database row and the authenticated `req.user`, nothing else.
- Returning a bucket URL instead of a presigned one.
- **Constructing a derived key here.** The worker writes the variant and blurred-thumbnail keys onto the rows. Read the column. The API builds only upload keys, in its one key function (root invariant 12).
- Serving the upload thumbnail key for a processed photo. Read the public thumbnail column; for a photo with Do Not Publish faces the worker has pointed it at a blurred file (root invariant 13).

Thumbnails and downloads use this same endpoint and the same check. There is no separate download path and no compositing step; D-57 removed it. Covers and profile photos are not media: the endpoint that returns the event or the profile presigns them after its own check (`docs/ARCHITECTURE.md` §3).

---

## Who may see what

`docs/ARCHITECTURE.md` §1 has the full table. The rules easiest to get wrong:

- **`media`**: active members, once `processed_at` is set or if they uploaded it. A Photographer sees only their own uploads (spec §4.10). Update and delete by the uploader and the event's Admin.
- **`face`, `dnp_subject`**: only through the viewer-scoped rule (root invariant 4). The subject learns they are in a photo; nobody else learns who is.
- **`face_reference`**: the owner, and only their photos. Embeddings never leave the database and the worker.
- **`venue.qr_secret`**: the event's Admin only (D-17).
- **`profile.full_name`**: members of a shared event, Do Not Publish or not (D-35). A Photographer sees no other member's name, because the name list is the guest list (D-08).

`uploader_role_at_upload` is display metadata. It drives the Uploader filter chip and nothing else. Never in an authorization check, never in a routing branch.

There is no `dnp_crop` table (D-57) and no `PlanTier` table; spec §4.17's limits are plain constants in the relevant service.

**The two RLS policies**, `SELECT` on `media` and `event`, exist only for Realtime. They check membership through a `security definer` function, because `membership` has no policy and a plain subquery inside a policy sees no rows. Test them through Realtime: a non-member receives nothing, and a member receives no unprocessed row they did not upload. Like any RLS policy, they get a human read before merging (D-68).

---

## Pre-flight and upload (Handbook §7)

**Media bytes never pass through Express** (root invariant 5). Not for compositing, resizing, or a format check, not the thumbnail, not even temporarily because the worker is not wired up yet. nginx's `client_max_body_size` is set to 1m as a guardrail against exactly that.

Pre-flight is small JSON and indexed lookups, in this order (`docs/ARCHITECTURE.md` §4, D-82). Every one must stay indexed:

1. The caller is an `active` member, the event is not deleted, and `album_open` is true. The album check ships switched off in S-12 and S-31 turns it on.
2. SHA-256 match against existing media for this event. The caller's own row with this hash and no `uploaded_at` is a crashed upload: re-sign its existing keys and stop. Any other match is silently rejected, no file transfer, no prompt.
3. For a new row only: fewer than 2,000 non-deleted media rows in the event, then verification, meaning a `venue_verification` row for this user and sub-event OR `membership.admin_verified_at IS NOT NULL` OR `role = 'photographer'`.

Then build the upload keys for the photo and its thumbnail in the one key function, insert the media row with them, and presign a PUT URL for each (D-70). On the client's completion call, set `uploaded_at` where it is null and enqueue exactly one `pgmq` job in the same transaction: `thumbnail_dims` until S-21, `face_process` from then on. Never both (D-72). A repeated completion call changes no row and enqueues nothing.

**The client's GPS reading is optimistic; this server is the authority.** Re-validate the reading against the sub-event's stored coordinates and write the `venue_verification` row here. Never trust a client-supplied `verified: true`. A Venue QR scan carries its venue, its secret and the scan time; check the secret and verify the sub-event at that venue that was In Progress at the scan time (D-85). The event response carries the caller's verification state, so a device learns of a Force Verify or of a verification made on another device (spec §4.5).

---

## Local rules

- Node's event loop is single-threaded: any synchronous CPU work in a handler blocks every other request that process is serving. That is why image and face work lives in the Python worker behind `pgmq`.
- The API never compares face embeddings. Matches are stored on `face` rows by the worker (D-74); the API reads them.
- **Both join paths enqueue `reprocess`** for a subject with references who becomes an active member, auto-approve and the Admin's approval alike, from S-25 on. Without it a Do Not Publish user who joins late stays unblurred in every earlier photo (D-84).
- **Refuse to delete the last curated reference while Do Not Publish is active** (root invariant 8, D-87).
- `pino` for logging, `helmet` for headers.
- **Sentry starts in `src/instrument.ts`, preloaded with `node --import`** by `pnpm dev` and the systemd unit. Never import it from `index.ts` or call `Sentry.init` anywhere else. ESM runs a module's imports before its code, so Sentry would start after express had loaded and events would lose their request. It reports errors only, with `sendDefaultPii` off. Keep `setupExpressErrorHandler` after the last route and before any other error middleware.
- Two Supabase projects exist, dev and stable. Development uses dev; the demo stack uses stable (D-76).
- Tests in `tests/unit/` and `tests/integration/`, plain Jest without the `jest-expo` preset. The serving-endpoint negative test is the highest-value test in the repo; write it before the endpoint.
- `pnpm --filter api test:rls` runs the RLS negative tests against the dev project, reading its URL and both keys from the root `.env`. CI skips them, because CI never holds the secret key.
