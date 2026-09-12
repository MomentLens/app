# apps/api

Express 5 + TypeScript. The only thing that decides "is this request allowed." Root `CLAUDE.md` has the invariants; they apply here too.

Detail in Handbook §5 and §7.

---

## Layering

`route → controller → service`. Routes define the HTTP surface, controllers parse and validate with zod, services hold business logic and talk to Supabase.

This is not ceremony. It means "is this event's guest limit reached" is testable without an HTTP server, and it is what keeps three people out of one giant `routes.ts`.

Auth middleware verifies the Supabase JWT with Supabase's server SDK and attaches the user to `req.user`. Do not hand-roll JWT verification. Nothing downstream re-checks identity.

Request and response shapes are zod schemas in `packages/shared-types`, imported by both sides. Generate the OpenAPI spec from them with `zod-to-openapi`.

---

## The image-serving endpoint

The most sensitive authorization check in the system, and it is application logic rather than RLS. A human reads it before it merges, and it ships with a negative test (D-68).

```
GET image for media X, requested by user U
  → is U a Do Not Publish subject on X?
      yes → presign U's variant key from the media row
      no  → presign the public key from the media row
```

Three ways to get this wrong, all of which look reasonable:

- Deriving "is this the subject" from anything the client sent. It comes from the database row and the authenticated `req.user`, nothing else.
- Returning a bucket URL instead of a presigned one.
- **Constructing the object key here.** The worker writes `public_key` and the per-subject keys onto the media row. Read the column. Never build the string (root invariant 12).

Download uses this same endpoint. There is no separate download path and no compositing step; D-57 removed it.

---

## Row Level Security

RLS is enforced by the database regardless of which query arrives, which is what protects you from a code path that forgets a check. Write policies for:

- **`media`** — `SELECT` to any event member, except a Photographer, who sees only rows where they are the uploader (spec §4.10). `UPDATE`/`DELETE` to the uploader and the event's Admin.
- **`event`** — visible only to members of that event.
- **`membership`** — a user reads their own rows; the Admin reads all rows for their own events.
- **`face_reference`** — readable only by the owner and the worker's service role. Never exposed through a user-facing endpoint. Carries the `is_curated` flag (root invariant 6).
- **`dnp_subject`** — event members can learn that a photo has personalization; only the subject learns who the subject is.
- **`subject`** — has a **nullable** FK to the auth user, from the first migration, even though Proxy Blur is deferred (D-63).

`uploader_role_at_upload` is display metadata. It drives the Uploader filter chip and nothing else. Never in an RLS predicate, never in a routing branch.

There is no `dnp_crop` table (D-57) and no `PlanTier` table; spec §4.17's limits are plain constants in the relevant service.

Every RLS policy gets a negative integration test: authenticate as A, assert zero rows from B's data. A too-permissive policy throws nothing and looks identical to a correct one.

---

## Pre-flight and upload (Handbook §7)

**Media bytes never pass through Express** (root invariant 5). Not for compositing, resizing, or a format check, not even temporarily because the worker is not wired up yet. nginx's `client_max_body_size` is set to 1m as a guardrail against exactly that.

Pre-flight is small JSON and two indexed lookups, both of which must stay indexed:

1. SHA-256 match against existing media for this event → exact match is silently rejected, no file transfer, no prompt.
2. Verification: `VenueVerification row for this user+sub-event` OR `membership.admin_verified_at IS NOT NULL` OR `role = 'photographer'`.

Then presign an R2 upload URL. On the client's completion call, enqueue the `pgmq` job.

**The client's GPS reading is optimistic; this server is the authority.** Re-validate the reading against the sub-event's stored coordinates and write the `VenueVerification` row here. Never trust a client-supplied `verified: true`.

---

## Local rules

- Node's event loop is single-threaded: any synchronous CPU work in a handler blocks every other request that process is serving. That is why image and face work lives in the Python worker behind `pgmq`.
- `pino` for logging, `helmet` for headers.
- Two Supabase projects exist, dev and stable. Do not point local development at the demo project.
- Tests in `tests/unit/` and `tests/integration/`. The serving-endpoint negative test is the highest-value test in the repo; write it before the endpoint.
