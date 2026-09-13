# apps/api

Express 5 + TypeScript. The only thing that decides "is this request allowed." Root `CLAUDE.md` has the invariants; they apply here too.

Detail in Handbook §5 and §7.

---

## Layering

`route → controller → service`. Routes define the HTTP surface, controllers parse and validate with zod, services hold business logic and talk to Supabase.

This is not ceremony. It means "is this event's guest limit reached" is testable without an HTTP server, and it is what keeps three people out of one giant `routes.ts`.

Auth middleware verifies the Supabase JWT with Supabase's server SDK and attaches the user to `req.user`. Do not hand-roll JWT verification. Nothing downstream re-checks identity.

Request and response shapes are zod schemas in `packages/shared-types`, imported by both sides. Generate the OpenAPI spec from them with `@asteasolutions/zod-to-openapi`.

---

## Query Supabase as the caller (D-71)

The auth middleware also builds a Supabase client from the caller's JWT for that request. Services use that client, so RLS runs on every API query.

The secret key bypasses RLS. It lives in exactly one module under `src/db/`, used only for the few operations that run before the caller has a membership row, such as resolving an invite token. Importing it anywhere else skips RLS and throws nothing. Every call site counts as auth or invite-token handling and gets a human read before merging.

---

## The image-serving endpoint

The most sensitive authorization check in the system, and it is application logic rather than RLS. A human reads it before it merges, and it ships with a negative test (D-68).

```
GET image or thumbnail for media X, requested by user U
  → is U a Do Not Publish subject on X?
      yes → presign U's variant key (or variant thumbnail key), read from the row
      no  → presign the public key (or public thumbnail key), read from the row
```

Four ways to get this wrong, all of which look reasonable:

- Deriving "is this the subject" from anything the client sent. It comes from the database row and the authenticated `req.user`, nothing else.
- Returning a bucket URL instead of a presigned one.
- **Constructing a derived key here.** The worker writes the variant and blurred-thumbnail keys onto the rows. Read the column. The API builds only upload keys, in its one key function (root invariant 12).
- Serving the upload thumbnail key for a processed photo. Read the public thumbnail column; for a photo with Do Not Publish faces the worker has pointed it at a blurred file (root invariant 13).

Thumbnails and downloads use this same endpoint and the same check. There is no separate download path and no compositing step; D-57 removed it.

---

## Row Level Security

RLS is enforced by the database regardless of which query arrives, which is what protects you from a code path that forgets a check. Because of D-71 that includes this API's own queries. Write policies for:

- **`media`**: `SELECT` to any event member, except a Photographer, who sees only rows where they are the uploader (spec §4.10). `UPDATE`/`DELETE` to the uploader and the event's Admin.
- **`event`**: visible only to members of that event.
- **`membership`**: a user reads their own rows; the Admin reads all rows for their own events.
- **`face_reference`**: readable only by the owner and the worker. Never exposed through a user-facing endpoint. Carries the `is_curated` flag (root invariant 6).
- **`dnp_subject`**: only the subject learns who the subject is. RLS filters rows, not columns, Realtime sends whole rows, and the per-subject key contains `subject_id`. Read `docs/ARCHITECTURE.md` §1 before writing this policy.
- **`subject`**: has a **nullable** FK to the auth user, from the first migration, even though Proxy Blur is deferred (D-63).

`uploader_role_at_upload` is display metadata. It drives the Uploader filter chip and nothing else. Never in an RLS predicate, never in a routing branch.

There is no `dnp_crop` table (D-57) and no `PlanTier` table; spec §4.17's limits are plain constants in the relevant service.

Every RLS policy gets a negative integration test: authenticate as A, assert zero rows from B's data. Run it through the API and directly against Supabase. A too-permissive policy throws nothing and looks identical to a correct one.

---

## Pre-flight and upload (Handbook §7)

**Media bytes never pass through Express** (root invariant 5). Not for compositing, resizing, or a format check, not the thumbnail, not even temporarily because the worker is not wired up yet. nginx's `client_max_body_size` is set to 1m as a guardrail against exactly that.

Pre-flight is small JSON and two indexed lookups, both of which must stay indexed:

1. SHA-256 match against existing media for this event → exact match is silently rejected, no file transfer, no prompt.
2. Verification: `VenueVerification row for this user+sub-event` OR `membership.admin_verified_at IS NOT NULL` OR `role = 'photographer'`.

Then build the upload keys for the photo and its thumbnail in the one key function, insert the media row with them, and presign a PUT URL for each (D-70). On the client's completion call, enqueue exactly one `pgmq` job: `thumbnail_dims` until S-21, `face_process` from then on. Never both (D-72).

**The client's GPS reading is optimistic; this server is the authority.** Re-validate the reading against the sub-event's stored coordinates and write the `VenueVerification` row here. Never trust a client-supplied `verified: true`.

---

## Local rules

- Node's event loop is single-threaded: any synchronous CPU work in a handler blocks every other request that process is serving. That is why image and face work lives in the Python worker behind `pgmq`.
- `pino` for logging, `helmet` for headers.
- Two Supabase projects exist, dev and stable. Do not point local development at the demo project.
- Tests in `tests/unit/` and `tests/integration/`, plain Jest without the `jest-expo` preset. The serving-endpoint negative test is the highest-value test in the repo; write it before the endpoint.
