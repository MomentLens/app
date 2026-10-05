# MomentLens architecture

> The current state of the system: data access, tables, R2 keys, jobs, thresholds, deployment. Why something is this way lives in `DecisionLog.md`. What a feature does lives in `Idea.md`.

**Owner: Ukasha** (D-75). Agents write this file and Ukasha decides what it says.

- Change it only to record a decision Ukasha made, citing the D-entry, or what merged code actually does, in the same PR as that code.
- If the code and this file disagree, stop and ask. Never edit the file to match the code.
- Anything undecided is marked **Open**. Ask Ukasha instead of filling it in.
- Ukasha reviews every PR that touches this file.

**Status, 2026-10-02.** Nine migrations exist. One is for `health_check`, which is infrastructure rather than a feature table. S-01's is for `profile` and `subject`, S-02's for `event`, `venue`, `sub_event` and `membership`, `20260929184331_invite_and_join.sql` for `invite`, and S-12's first for `media`. The other four add no table. One backfills `profile` for accounts older than S-01's trigger, and three add functions, columns or indexes to tables that already exist, each named under the table it serves. Every other table below is planned. When a table's migration merges, add the migration file name under its heading.

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
| `media` | Active members of the event, once `processed_at` is set or if they uploaded it. A Photographer sees only their own uploads (§4.10, D-55). Update by the uploader and the event's Admin, and delete by them alone, permanently (D-130). **Also an RLS policy.** Soft-deleted rows stay visible to it so Realtime delivers the deletion; the API's queries exclude them and the app drops a row when an update sets `deleted_at`. A row without `uploaded_at` is shown to nobody (D-82) |
| `event` | Active members. **S-31 adds an RLS policy**, so opening and closing the album reaches every phone live |
| Invite preview | Anyone holding a live token or shortcode, with or without a session: the role, the event's name, span, venue names and cover. No member, no venue position and no `qr_secret`. A signed-in caller also gets their own membership in that event (D-115) |
| `invite` | The event's Admin, through S-05's share screen. A lookup returns the preview above, never the row (D-115) |
| `membership` | A user sees their own rows, with the event's name on a pending one (D-115); the Admin sees every row for their events (Handbook §5) |
| `face`, `dnp_subject` | Only through the viewer-scoped rule (root invariant 4). A Do Not Publish subject learns they are in a photo; no other viewer learns who is. A Photographer gets no `face` rows, for their own photos too (§4.10, D-08) |
| `face_reference` | The owner, and only their photos, with or without Do Not Publish (D-109). Embeddings never leave the database and the worker (Handbook §5) |
| `manual_blur_region` | Any Guest or the Admin draws one on a photo they can see; its drawer or the Admin removes it. Only the Admin lists them, with who drew each, in the Review Queue (D-83) |
| `venue.qr_secret` | The event's Admin, for printing (D-17) |
| `profile.avatar_key` | The user, and the same people as `profile.full_name`, so a Photographer sees no other member's (D-08). Shown in an event's context, it goes to nobody but the user when their membership in that event has Do Not Publish on, the Admin included. Another event's context shows it as usual (D-35, D-109, D-129) |
| `profile.full_name` | Active members of an event the user belongs to, and that event's Admin while the user's join request is pending. Do Not Publish does not hide it (D-35). A Photographer sees no other member's name, since the name list is the guest list (D-08) |
| `health_check` | The API only, for `GET /health`. RLS is on with no policy, so the publishable key reads no rows, and both the keep-alive and `apps/api/tests/integration/rls.test.ts` check that |

---

## 2. Tables

Planned, not migrated, except `health_check`, `profile`, `subject`, `event`, `venue`, `sub_event`, `membership`, `invite` and `media`. Table names are singular snake_case. Every table has an `id` (uuid) and `created_at` unless it says otherwise. The columns listed are the ones the design depends on; migrations add the rest.

### `profile`
One row per auth user. `user_id` is the primary key, so the table has no `id`. Migration `supabase/migrations/20260924101332_create_profile_and_subject.sql`.
- `full_name`, `avatar_key` (§4.2)
- Created by a trigger on `auth.users` from the signup's `full_name`, trimmed and 1 to 80 characters, so every account has one. `ON DELETE CASCADE` to `auth.users` (D-109)
- The trigger, `create_profile_on_signup`, runs `create_profile_for_new_user()` as `security definer`. A missing or non-string name, or one the check below rejects, rolls back the insert into `auth.users`, so a failed signup leaves no account. Nothing reads the name from the metadata again, because a user can rewrite their own metadata. After signup the row is the only source of the name. The one exception is the backfill below, which ran once
- Live accounts created before the trigger existed got their profile from `supabase/migrations/20260928202314_backfill_profiles.sql`. It names each from its `full_name` metadata as that stood when the migration ran, trimmed as the trigger trims it, so the name may differ from the one given at signup. It leaves out anonymous users and accounts Auth soft-deleted, and it refuses to run, writing nothing, if any other account without a profile has no usable name. `apps/api/tests/integration/rls.test.ts` checks that every live account has a profile
- `profile_full_name_check` trims with `public.trim_whitespace`, which strips what JavaScript's `trim()` strips, and allows 1 to 80 code points. A stored name is then one that `FullName` in `packages/shared-types` accepts unchanged
- `profile_avatar_key_check` accepts only `users/{user_id}/avatar_{upload_id}.jpg` for the row's own user (§3). No other file can be stored, and so presigned, as someone's avatar
- `notify_approval`, `notify_album` for the two push channels (§4.16, §4.19). The sender checks them before sending. "Upload over Mobile Data" and the default Viewfinder mode are not here; they live on the phone (D-105). Both default to true (D-109)
- RLS on with no policy (D-73). `anon` and `authenticated` keep `SELECT`, so a stray query from the app returns empty rows, and lose every write privilege. `service_role` reads and writes

### `push_token`
- `user_id`, `expo_push_token`

### `subject`
The identity that reference photos attach to, split from the account in S-01's migration, the first after `health_check` (D-63). Migration `supabase/migrations/20260924101332_create_profile_and_subject.sql`.
- `user_id`, nullable, unique where not null, `ON DELETE CASCADE` to `auth.users` (D-109). Null only for the deferred Proxy Blur. The constraint is a plain `UNIQUE (user_id)`, which treats nulls as distinct
- `dnp_activated_at` exists from S-01's migration and is unused. Do Not Publish is per event and lives on `membership` (D-129). S-29's migration drops this column
- Created when a user adds their first reference photo, in any event. Activation in an event needs at least one accepted `face_reference` row in that event, and while Do Not Publish is on there the API refuses to delete the last one there (D-56, D-87, D-129, D-141)
- RLS and grants the same as `profile`

### `face_reference`
One reference photo, for one person in one event (D-141).
- `subject_id`, `event_id`, `photo_key`. `event_id` is `ON DELETE CASCADE` to `event`. The profile photo is never a reference, so there is no `source`
- `status` (`pending`, `accepted`, `rejected`), `reject_reason` (`no_face`, `multiple_faces`), `embedding vector(512)`, null until accepted (D-91)
- The API inserts the row as `pending` when the photo is uploaded. `reference_process` sets `accepted` with the embedding when it finds exactly one face, and `rejected` with the reason otherwise. Only `accepted` rows are matched against or counted (D-87, D-91)
- At most 5 rows per subject and event that are not rejected (§4.2). Matching in an event reads only that event's rows
- Only an active member of the event adds one, from Event Preferences. Remove from Event leaves the rows, so a rejoin matches them again (D-84)
- Setting a profile photo writes `avatar_key` and nothing else. It creates no subject and queues no job. S-20 builds it (D-109, D-141)
- When the owner removes a reference, the API deletes the row, which takes its embedding, and deletes its object. Then it enqueues `reprocess` for the subject in that event
- There are no auto-added references (D-83)

### `event`
Migration `supabase/migrations/20260925105127_create_event_venue_sub_event_membership.sql`, which also creates `venue`, `sub_event` and `membership`.
- `name`, `type` (`wedding`, `engagement`, `other`), `description`, `cover_key` (D-110)
- `event_name_check` trims with `public.trim_whitespace` and allows 1 to 80 code points, as `profile_full_name_check` does. `event_description_check` allows null or 1 to 500, and `create_event` stores an empty description as null. The same two checks sit on `venue.name`, `sub_event.name` and `sub_event.description`
- `event_cover_key_check` accepts only `events/{event_id}/cover_{upload_id}.jpg` for the row's own event (§3). The API presigns the key for every active member and for anyone holding a live invite, on its preview (D-115), so no other file can be shown to them as the cover
- No start or end of its own. The event runs from its first sub-event's start to its last sub-event's end, computed on read, at most 14 days (§4.17, D-88). So it has at least one sub-event
- No venue and no verification radius of its own. Each sub-event has both (D-111)
- `approval_mode` (`auto`, `manual`, default `auto`, §4.4, D-110), chosen on the wizard's first step (D-111), `album_open` (false at creation, §2.1)
- `create_request_id`, the uuid the app sends with a create, unique across all events. A repeat from the same caller returns the first event and writes nothing. Another caller's repeat gets 409 `duplicate` and nothing about that event. A repeat whose event was soft-deleted since gets 404 (D-110, D-114)
- One SQL function, `create_event`, called with `rpc`, inserts the event, its venues, its sub-events, the creator's `admin` membership and the event's two invites in one transaction (D-95, D-110). `supabase/migrations/20260929184331_invite_and_join.sql` replaced it to add the invites, after the repeat check, so a repeated `create_request_id` issues none (D-115). It checks the sub-event count, the venue indexes, that every venue is used, and the 336-hour span again, so a refusal of that kind is an API bug and answers 500. The one refusal that is not a bug is the membership foreign key failing for an account deleted since its token was issued, which the API answers 401 `no_session` (D-114)
- `list_my_events(p_user_id)` serves `GET /events`. It returns every event where the user's membership is `active`, soft-deleted ones left out, with the user's role and the span from the sub-events (D-110). `membership_user_id_status_idx` on `(user_id, status)` keeps it indexed. An event with no sub-events would come back with a null span, and the API's parse refuses it. `GET /events` also returns the caller's `pending` rows as join requests, each with the event's name and the role (D-115)
- `get_my_event(p_event_id, p_user_id)` serves `GET /events/{eventId}`, from `supabase/migrations/20261001171314_get_my_event.sql` (D-118). It reads the membership and the event in one statement, so the role and the event come from one snapshot. It returns one row when the event exists, soft-deleted or not, and none when it does not. The row carries whether the event is deleted and the caller's own `role` and `status`, null with no membership. The event's columns, with the span computed as `list_my_events` computes it, are null unless the membership is `active` and the event is not deleted, so the API never holds the name or cover key of an event it would refuse. The API answers 404 `not_found` for a deleted or unknown event, its Admin included, and 403 `not_member` for anyone else who is not `active`, pending included, before it presigns the cover
- `event_settings(p_event_id)` serves `GET /events/{eventId}/settings`, from `supabase/migrations/20261004083652_update_event_settings.sql` (D-142). In one statement it returns the name, description, `approval_mode`, `cover_key`, the count of `pending` memberships, and each pending Photographer's `full_name`, oldest `requested_at` first, so the list never names a request the count left out. Null for a deleted or unknown event, and an archived event answers as any other. The API calls it after `requireAdmin` and presigns the cover after that
- `update_event_settings(p_event_id, p_name, p_description, p_approval_mode, p_max_guests)` serves `PATCH /events/{eventId}/settings` (D-142). It changes the fields passed and keeps every null one, and an empty description clears it. It takes `join_event`'s lock on the event row before it reads the mode, and a switch from `manual` to `auto` admits pending requests in the same transaction (arch:membership). It answers with an `outcome`, `updated` or `not_found`, how many it `admitted`, and `event_settings` after the write. `type` and the cover are not parameters. The type never changes, and the cover has its own two endpoints (D-110)
- All five functions take the user or the event as a parameter and check no caller, so `execute` is granted to `service_role` only. They run as `security invoker`
- `PUT /events/{eventId}/cover` replaces `cover_key` and deletes nothing, so a replaced cover's object stays in R2. A cover has no size limit (D-114)
- `deleted_at`, `archived_at` (§4.21)
- `venue`, `sub_event` and `membership` rows reference `event_id` with `ON DELETE CASCADE`, so the hard delete after soft deletion (§4.21) removes the event's row and they go with it
- RLS and grants the same as `profile`, on all four of this migration's tables. S-31 adds `event`'s `SELECT` policy for Realtime (§1)

### `venue`
Migration `supabase/migrations/20260925105127_create_event_venue_sub_event_membership.sql`.
- `event_id`, `name`, `lat`, `lng`, `qr_secret` (32 random bytes)
- `qr_secret` is `bytea`, filled by `gen_random_bytes(32)` and held at 32 bytes by a check. No S-02 endpoint returns it (D-110). `lat` and `lng` are checked to -90..90 and -180..180
- `(id, event_id)` is unique so `sub_event` can point at it, which keeps a sub-event's venue inside the sub-event's own event. `venue_event_id_idx` indexes `event_id`
- A sub-event's venue is one an earlier sub-event added in the wizard, or a new one. Every venue is used by at least one sub-event, so an event has at most 15 (D-110, D-111). When a sub-event edit or delete leaves a venue with no sub-event, the same function deletes that venue, and its printed QR stops working (D-121)
- A venue's name and pin are never edited in place. To fix one, the Admin moves its sub-events to another venue or a new one (D-121)
- No radius. Each sub-event at the venue carries its own, so two at one hall may differ (D-111)
- One Venue Check-In QR per venue. Sub-events that share a venue share its QR (§4.3). The payload carries the venue and its secret; a scan verifies the sub-event at this venue that was In Progress at the scan time (D-85)

### `sub_event`
Migration `supabase/migrations/20260925105127_create_event_venue_sub_event_membership.sql`. `create_request_id` and the four functions below come from `supabase/migrations/20261001203656_sub_event_writes.sql`. `supabase/migrations/20261002121238_media_upload.sql` adds `sub_event_id_event_id_key` and replaces `delete_sub_event`.
- `event_id`, `name`, `description`, `starts_at`, `ends_at`, `venue_id`
- `sub_event_time_check` requires `ends_at` after `starts_at`. The foreign key is `(venue_id, event_id)` to `venue (id, event_id)`, so a venue's QR never verifies a sub-event of another event. The key has no `ON DELETE` action, so a venue still used by a sub-event cannot be deleted. `sub_event_event_id_idx` and `sub_event_venue_id_idx` index both columns. `sub_event_id_event_id_key`, unique on `(id, event_id)`, is the target of `media`'s sub-event foreign key (D-122)
- `verification_radius_m` (50 to 2000, default 200, §4.3, D-111), an integer. The GPS check for this sub-event compares against it (§4.5)
- At most 15 per event (§4.3)
- A delay is a positive amount. Before the sub-event starts it moves `starts_at` and `ends_at` together. Once the sub-event has started it moves `ends_at` only, so a running sub-event never goes back to Upcoming and a reading from its first part still matches it (D-85, D-121). The app sends a delay as the new times through the edit endpoint, so a retry changes nothing
- `create_request_id`, the uuid the app sends with an add, unique across all sub-events. A repeat inserts nothing and returns the schedule, as a repeated `event.create_request_id` returns the event (D-110, D-121)
- Status is computed on read and never stored: In Progress from `starts_at` until `ends_at` (§4.3, D-88). Inside the event there can be times when none is In Progress. `subEventStatus(subEvent, at)` in `packages/shared-types` computes it for the app and the API. `currentSubEvent(subEvents, at)` picks the one In Progress at an instant, which is the most recently started, and on a tie the one that ends first, then the lower id. The capture button passes every sub-event of the event, and the API passes one venue's sub-events for a QR scan and asks at the reading's time (D-85, D-89, D-105, D-121)
- Read through `GET /events/{eventId}/sub-events`, which every active role may call. It returns each sub-event with its own radius and its venue's id, name, lat and lng, never `qr_secret`. The app persists it and refetches it on foreground and reconnect, as it does the event (D-118, D-121)
- `sub_event_schedule(p_event_id)` builds that list, ordered by `starts_at`, then `ends_at`, then id, and returns null for an unknown or soft-deleted event. GET calls it after the API's membership check and answers a null with 404 `not_found`, so an event soft-deleted between the two calls is not served. The three write functions return their schedule from it, so a read and a write answer in one shape and one order
- Three SQL functions called with `rpc` write it: `add_sub_event`, `update_sub_event` and `delete_sub_event` (D-95). Each locks the event row `FOR NO KEY UPDATE`, as `join_event` does, before it counts sub-events or computes the span, so two of the Admin's phones cannot together pass the cap of 15 or the 336-hour span, or delete the last sub-event. Each returns the whole schedule (D-121)
- The API answers 422 `too_many_sub_events` for a 16th, 422 `event_too_long` for an add, edit or delay that takes the span past 336 hours, 409 `last_sub_event` for a delete of the last one, and 409 `sub_event_has_media` for a delete of one with photos (hb §5.3, D-121). An add answers 201 when it wrote and 200 when its `requestId` repeated. A `requestId` that belongs to another event's sub-event is 409 `duplicate`, and a `venueId` that is not a venue of this event is 400 `invalid_request`, on add and edit
- The four functions take no user, so only the API's secret key may execute them; `anon` and `authenticated` cannot (D-73). The API checks the caller first: an active member for GET, the event's Admin for a write. PATCH and DELETE take the event from the sub-event's row, so another event's Admin gets 403 `not_member` and nothing changes
- Deleted only while it has no photos, and never the event's last one. S-12's migration replaced `delete_sub_event` with one that refuses a sub-event with any `media` row, unfinished or soft-deleted included, after the last-one check, so the event's only sub-event always answers `last` (D-121). An edit moves no photo and no `venue_verification` row. Other phones see an edit or a Delay on their next fetch of the schedule; there is no Realtime on this table (D-100)

### `membership`
Migration `supabase/migrations/20260925105127_create_event_venue_sub_event_membership.sql`. `requested_at` comes from `supabase/migrations/20260929184331_invite_and_join.sql`, and `access_version`, the Admin guard and the attendee functions from `supabase/migrations/20261004115317_attendee_management.sql`.
- `event_id`, `user_id`, unique together. `user_id` is `ON DELETE CASCADE` to `auth.users`
- `role` (`admin`, `photographer`, `guest`), `status` (`pending`, `active`, `blocked`, `removed`)
- Exactly one `admin` row per event, its creator's. A role change moves someone between `guest` and `photographer` only (D-102)
- The database holds part of that. A partial unique index, `membership_one_admin_idx`, allows at most one `admin` row per event, and `membership_admin_active_check` keeps it `active`. Only `create_event` writes it. The `membership_admin_update` trigger, `guard_membership_admin()`, refuses with `check_violation` (23514) any update that changes the Admin row's `id`, `event_id`, `user_id`, `role` or `status`, and any update that makes another row `admin` (D-114, D-143)
- `access_version`, `bigint not null default 1`, positive. The `membership_access_version_update` trigger, `advance_membership_access_version()`, adds 1 when an update changes `role`, `status` or `requested_at`, and otherwise keeps the old value, so a direct write to the column does nothing. `join_event`'s rejoin advances it too, and so does `update_event_settings` when it admits a pending row. The API encodes the row's `id` and this counter as the opaque `accessVersion` token, base64url JSON built in `apps/api/src/services/attendees.ts`, so a removed person's rejoin or a deleted and recreated membership cannot match an old action (D-143)
- **Open.** Deleting an account deletes its memberships, so every event it was the Admin of is left with no Admin. No slice builds a handover yet. Until one does, the team deletes each such event, or hands it to another member by hand, before deleting the account (D-114). The Admin guard refuses the update a handover would use, so a handover by hand runs one transaction with the secret key: delete the event's rows for the old Admin and the new one, then insert `(event_id, user_id, role, status)` as `(<event>, <new Admin>, 'admin', 'active')`. The guard covers updates only, `membership_one_admin_idx` still allows one Admin, and no table references a membership row, so nothing else goes. The new Admin keeps their uploads and loses their old row's `admin_verified_at` and version (D-143)
- `admin_verified_at` (Force Verify, D-15), `last_viewed_at` (the "new since last visit" dot, §2.5)
- `dnp_activated_at`, nullable: Do Not Publish for this person in this event, set once and never cleared (D-31, D-129). **Planned.** S-29's migration adds it, and the column on `subject` goes. Null on insert, so a new membership starts with it off. Remove from Event, a rejoin and a reject keep the row, so they keep it. Cancel Request deletes a pending row, so S-29 changes it to retain the row with status set to `removed` instead (D-144). Setting it requires an accepted `face_reference` for the user's subject in this event and enqueues `reprocess` for that subject and this event, in one SQL function (D-95, D-141)
- A join request is a `pending` row. Approve sets `active`, reject sets `removed` and keeps the row, cancel deletes it, and block sets `blocked` (spec §4.4, D-144). A rejected person may ask again through a live invite, as a removed one may. S-07's approve and reject act on a batch, all or nothing. One target that is gone, no longer `pending` or stale refuses the batch, and so does a batch whose Guests would pass the cap. At most 150 `active` guest rows per event; the Admin and Photographers do not count (spec §4.17, D-102). A join to a `manual` event is let in as `pending` past 150, and the cap applies when S-07 approves it (spec §4.17). Switching the event from `manual` to `auto` with `update_event_settings` admits every pending Photographer, then pending Guests oldest `requested_at` first until 150 are `active`. The rest stay `pending` for Pending Approvals. An archived event admits them too, though `join_event` refuses every join to one (D-142)
- One SQL function, `join_event`, called with `rpc`, is the only way in through an invite. In one transaction it locks the event row, checks the invite is live, refuses a `blocked` caller, refuses the 151st `active` guest, then inserts the row or updates a `removed` one, `active` or `pending` by the event's approval mode (D-95, D-115). A member's repeat returns their row unchanged. A rejoin takes the role of the link it used and clears `admin_verified_at`. S-25 adds the `reprocess` enqueue inside it (D-84)
- `join_event(p_user_id, p_token, p_shortcode, p_max_guests)` takes the cap as an argument. The API passes `MAX_ACTIVE_GUESTS`, 150, from `apps/api/src/services/events.ts`, as it does to `update_event_settings`, and `rls.test.ts` passes a small one to test the last place. It answers with an `outcome`: `created`, `rejoined`, `member`, `dead`, `blocked` or `full`
- `join_event` takes `FOR NO KEY UPDATE` on the event row before it counts, so two joins never both take the last place. The lock waits on any update of the event, a delete or an archive included, and lets inserts that reference the event carry on. **S-07's approval, and anything else that makes a Guest `active`, must take the same lock before it counts**, or an approve and a join can both take the last place. `update_event_settings` takes it (D-142)
- `list_attendees(p_event_id, p_actor_id, p_search, p_role, p_after_name, p_after_user_id)` serves `GET /events/{eventId}/attendees` (D-143). In one statement it checks the event is not deleted and the actor is its active Admin, then returns up to 51 `active` rows ordered by `profile.full_name`, then `user_id`, after the cursor's name and user. The 51st row tells the API there is another page. `strpos` on `lower()` of both sides makes the search literal, so `%`, `_` and `\` match themselves. It reads no avatar key and no verification column
- `change_attendee_role(..., p_role, p_max_guests)`, `remove_attendee` and `block_attendee` serve the three attendee actions, each through `mutate_attendee` (D-143). It takes `join_event`'s `FOR NO KEY UPDATE` lock on the event row, rechecks the event and the actor, locks the target row `FOR UPDATE`, and only then checks it. Its `outcome` is `not_found` for a deleted or unknown event or no membership in it, `not_member` or `wrong_role` for the actor, `invalid_request` for an Admin target, `membership_changed` for a non-`active` target or a row `id` or counter that does not match, `event_full` for a conversion to Guest at `p_max_guests` active Guests, and otherwise `updated` with the row after the write. A same-role change writes nothing and keeps the version. An archived event is allowed. The actions write only `role` or `status`, so `admin_verified_at`, `last_viewed_at` and uploads stay
- The five attendee functions take the actor as a parameter and check no caller, so `execute` is granted to `service_role` only, as it is for both trigger functions. They run as `security invoker`
- Migration `supabase/migrations/20261004154405_pending_approvals.sql` implements D-144 with five functions and no table or policy changes. `list_pending_requests(p_event_id, p_actor_id, p_after_requested_at, p_after_user_id)` checks the event and its active Admin, reads up to 51 pending rows ordered by `requested_at`, then `user_id`, and counts active Guests in one snapshot. It returns request times as UTC text to the microsecond, so the API's cursor preserves their order, and reads no avatar key or verification column. The API returns pages of 50 and clamps `guestPlacesLeft` at zero
- `approve_requests(..., p_targets, p_max_guests)`, `reject_requests(..., p_targets)` and `block_request(..., p_user_id, p_expected_id, p_expected_version)` call `act_on_join_requests` (D-144). Each write takes the event's `FOR NO KEY UPDATE` lock, rechecks the event and actor, locks targets in `user_id` order and checks every pending row's identity and access counter before writing. A stale or missing target refuses the whole batch with `membership_changed`; an approve past the Guest cap answers `event_full` and changes no row. Success changes only `status`, with the version trigger advancing the counter. S-25 adds its approved-subject `reprocess` enqueue inside `act_on_join_requests`. All five functions run as `security invoker` and grant `execute` to `service_role` only
- `requested_at` (`not null`, default `now()`), set on every join and rejoin, is the join time the Pending Approvals queue shows (spec §2.1.3, D-115). `created_at` would show a returning person their first join. Rows older than the migration took their `created_at`
- Cancel Request deletes the caller's row only while it is `pending`, so a cancel that loses a race with an approve leaves the member `active` (D-115)
- Remove from Event sets `removed`: the person sees Access Removed, their uploads stay, and a live invite lets them join again. A `blocked` person cannot rejoin (D-102)
- **Attendee avatar staging.** `GET /events/{eventId}/attendees` returns `avatar: null` for everyone and reads no avatar key until S-29 adds the event-scoped flag and upgrades the shared avatar presigner and attendee mapping. It does not substitute `subject.dnp_activated_at` for the event's flag (D-143). `GET /events/{eventId}/join-requests` follows the same rule, and S-29 upgrades both (D-144)

### `invite`
Migration `supabase/migrations/20260929184331_invite_and_join.sql`.
- `event_id`, `role` (`guest`, `photographer`), `token`, `shortcode` (6 characters), `revoked_at`
- `event_id` is `ON DELETE CASCADE` to `event`, so the hard delete after soft deletion (§4.21) takes revoked invites too. `invite_event_id_idx` indexes it
- Revoke and regenerate sets `revoked_at` and inserts a new row (§4.4)
- An invite is dead once `revoked_at` is set or its event is deleted or archived, and that is what the Join Error screen calls expired. There is no time limit
- The link is `momentlens://invite/{token}` (D-101)
- `token` is 32 random bytes from `gen_random_bytes`, base64url, 43 characters, unique (D-115)
- `shortcode` is 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, which leaves out 0, O, 1, I and L. It is stored uppercase and is unique across every row, revoked ones included, so a reissued code never sends an old share to another event. Entry ignores case and spaces (D-115)
- A partial unique index, `invite_one_live_idx`, on `(event_id, role)` where `revoked_at` is null keeps one live invite per role
- `create_event` inserts both when it creates the event, through `issue_invite(p_event_id, p_role)`. A new token or code can match one already issued, so `issue_invite` draws again, up to 10 times, and fails the create after that. A clash with `invite_one_live_idx` is not retried: S-05's regenerate must revoke the old row first (D-110, D-115)
- S-03's migration backfilled both for every event made before it, deleted and archived ones included, so a restored event comes back joinable
- `resolve_invite(p_token, p_shortcode, p_user_id)` serves `POST /invites/resolve`. It returns the preview in §1 and `p_user_id`'s own role and status in the event, or no row for a dead invite. It matches a shortcode as stored, so the API strips spaces and uppercases with `normalizeShortcode` from `packages/shared-types` first (D-115)
- RLS is on with no policy. `anon` and `authenticated` keep `SELECT` and read no rows, as on every other table. `resolve_invite`, `join_event` and `issue_invite` take the user or the event as a parameter and check no caller, so `execute` on them and on `new_invite_token` and `new_invite_shortcode` is granted to `service_role` only. `apps/api/tests/integration/rls.test.ts` checks the table refusals and those of `resolve_invite` and `join_event`
- The app sends a token or shortcode in the request body, never the path, because hb §5.3 puts only uuids in a path and nginx logs every path (D-115)
- Lookups have no rate limit (D-115)

### `venue_verification`
The spec's `VenueVerification`, renamed to the naming convention.
- `user_id`, `sub_event_id`, unique together; `method` (`gps`, `qr`), `verified_at`
- Written only by the API, after it re-validates the GPS reading or QR payload (D-16, D-17)
- `sub_event_id` references `sub_event` with `ON DELETE CASCADE`. Only a sub-event with no photos can be deleted, so its verifications unlocked nothing (D-121)

### `media`
Migration `supabase/migrations/20261002121238_media_upload.sql`, which also installs `pgmq` with the `jobs` queue (§5). `supabase/migrations/20261002130633_media_upload_limits.sql` replaces `start_upload`, `complete_upload` and `media_unfinished_key` (D-122).
- `id` has no default. The API makes it at pre-flight and builds both upload keys from it (D-70)
- `event_id`, copied from the sub-event at pre-flight and never taken from the request, and the sub-event must belong to the event in the path (D-122); `sub_event_id`, `uploader_user_id`, `uploader_role_at_upload` (`admin`, `photographer`, `guest`, display only, D-13)
- The sub-event foreign key is `(sub_event_id, event_id)` to `sub_event (id, event_id)`, so the table itself refuses a photo filed under another event's sub-event (D-122). It has no `ON DELETE` action, so a sub-event with any `media` row, unfinished or soft-deleted included, cannot be deleted, and `delete_sub_event` answers 409 `sub_event_has_media` before the key would refuse (D-100, D-121). `event_id` is `ON DELETE CASCADE` to `event`, so the hard delete after soft deletion (§4.21) takes the event's rows
- `uploader_user_id` references `auth.users` with no `ON DELETE` action, so an account with photos cannot be deleted until support removes them (spec §4.19, D-122)
- `captured_at`, the photo's EXIF capture time sent with pre-flight, or the pre-flight time when it has none (D-98)
- `content_hash`, SHA-256 as 64 lower-case hex characters, unique per event among rows with `uploaded_at` set and no `deleted_at`, through the partial index `media_event_id_content_hash_key` (D-53, D-96, D-130). **Planned.** The merged index, from S-12's migration, still includes deleted rows, and so do the duplicate checks in `start_upload` and `complete_upload`. S-22's migration leaves deleted rows out of all three, so a deleted photo can be uploaded again. The partial index `media_unfinished_key` allows one unfinished row per uploader and hash in an event among rows that are not soft-deleted, behind `start_upload`'s resume and its count of the caller's unfinished rows (D-122)
- `size_bytes`, the photo's size from R2's HEAD at completion, the thumbnail not included (D-95, D-122). The Photographer's storage figure sums it (§4.10). It is set exactly when `uploaded_at` is
- `upload_key`, `upload_thumb_key`, written by the API at pre-flight (D-70). `media_upload_key_check` and `media_upload_thumb_key_check` accept only `{id}/upload.jpg` and `{id}/upload_thumb.webp` for the row's own id (§3), so no row points at another photo's file
- `uploaded_at`, set by `complete_upload` only while it is null, in the same transaction as the enqueue (D-82, D-95)
- `public_key`, `public_thumb_key`, `variant_version` (integer, 0 at insert, so the worker's first write makes it 1), `width`, `height`, written by the worker (D-22, D-60, D-69, D-70, D-122)
- `processed_at`, written last by the worker (D-55), and refused while `uploaded_at` is null; `deleted_at` (§4.21)
- **Deletion is permanent** (D-130). Only the uploader or the event's Admin may delete a photo. `DELETE /media/{mediaId}` calls `delete_media`, which S-22 writes. It locks the event row `FOR NO KEY UPDATE`, sets `deleted_at` where it is null, and sends one `media_delete` message, in one transaction, so it runs as `security definer` as `complete_upload` does. Nothing clears `deleted_at`. The row stays, so Realtime delivers the deletion, but it is no duplicate: the same bytes upload again as a new row (D-130)
- At most 2,000 per event that are not soft-deleted, unfinished ones included (§4.17, D-95). The API passes `MAX_EVENT_MEDIA`, 2,000, from `apps/api/src/services/media.ts` to `start_upload`, as it passes `join_event` its guest cap. Local Only photos never create a row (§4.12)
- At most 50 unfinished rows per uploader in an event that are not soft-deleted, `MAX_UNFINISHED_UPLOADS` in the same file, so one member cannot fill the event with pre-flights that never upload. `start_upload` answers `too_many` past it, and the API 422 `too_many_unfinished` (D-122)
- A soft-deleted unfinished row never resumes, and `complete_upload` answers it `gone`, so a retry never publishes a photo its uploader deleted (D-122)
- **Planned, S-10.** `POST /events/{eventId}/media/status` takes 1 to 50 distinct media ids in its body. For each id that is the caller's own row in the event with `uploaded_at` set, it answers `processing` while `processed_at` is null, `published` once it is set, and `deleted` once `deleted_at` is. It leaves out every other id, another member's, another event's and the caller's own unfinished row, so it confirms nothing about a row the caller did not upload. Any active member may call it, a Photographer included, and the event and membership refusals are those of every event endpoint (hb §5.3, D-145)
- `media_event_id_idx` serves the cap's count and the event's cascade, and `media_sub_event_id_idx` serves `delete_sub_event`'s check
- Two SQL functions called with `rpc` write it, `start_upload` at pre-flight and `complete_upload` at completion, and §4 has what each decides (D-95). Each locks the event row `FOR NO KEY UPDATE`, as D-121's functions do (D-122). Both take the user as a parameter, so `execute` is granted to `service_role` only. `start_upload` runs as `security invoker`. `complete_upload` runs as `security definer`, because `pgmq.send` writes to the `pgmq` schema, where the API's role has no privilege, and the function is the API's one way to put a job on the queue
- RLS is on with no policy until S-13 adds `SELECT` for Realtime (§1). `anon` and `authenticated` keep `SELECT` and read no rows, and hold no write privilege, so a policy added by mistake still could not let the app write. `apps/api/tests/integration/rls.test.ts` checks both functions, their refusals, the table's checks and these grants against the dev project

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
| Reference photo | API | `face_reference.photo_key` | `users/{user_id}/events/{event_id}/reference_{upload_id}.jpg` (D-141) |

- For a photo with no Do Not Publish face and no blur region, `public_key` and `public_thumb_key` hold the upload keys (§4.11). Completion refuses a photo whose thumbnail is not in R2 (§4), so every finished photo has its client thumbnail and no job writes one.
- Cover, profile and reference keys carry a fresh `upload_id`, so a replacement lands at a new key and no cache keeps the old image.
- Every file the app sends reaches R2 by a presigned PUT, covers, profile photos and reference photos included (root invariant 5). The worker writes its own files directly.
- After a regeneration commits, the worker deletes the objects the rows no longer point at, and never `upload_key` or `upload_thumb_key` (D-103). The one exception is `media_delete`, which deletes every object under a deleted photo's `{media_id}/` prefix, the upload keys included (D-130).
- Media files are served by the one image-serving endpoint (D-57). S-13 builds it with the public file only, and S-21 adds the subject's file and the own-variant flag (D-93). With each presigned URL it returns a cache key, built from the object key it signed plus `variant_version`, and whether the file is the requester's own variant, which drives the self-visible marker. It takes a batch of media ids (D-86).
- Covers and profile photos are presigned by the endpoint that returns the event or the profile, after that endpoint's own check (§1). A reference photo is presigned only for its owner.
- A cover is uploaded after its event exists. `POST /events/{eventId}/cover-upload` presigns the PUT for the event's Admin, and `PUT /events/{eventId}/cover` HEADs the object and then sets `cover_key` (D-110).

---

## 4. Upload pipeline

Spec §4.8, Handbook §7.

1. **Client.** Orientation applied to the pixels, then an EXIF strip keeping only the timestamp (D-99), anything not JPEG to JPEG, resize only past 4096px, a WebP thumbnail 300px on its long edge, SHA-256 over the upload bytes with `expo-crypto`. Identical for every role (D-58, D-105).
2. **Pre-flight, JSON only.** Hash, sub-event ID, the capture time (D-98), and any verification records the device holds: a GPS reading or a Venue QR scan, each with its time (D-85, D-89). The photo itself carries no location. The checks, in order, are below (D-82). The API makes the first itself. `start_upload` makes the rest under the event lock (step 3), and the API makes no lookup of its own for them, so no check runs twice (D-122).
   - the caller is an `active` member, the event is not deleted, and `album_open` is true (D-12). An archived event takes uploads like any other. S-12 writes the album check behind one constant, switched off, and S-31 switches it on (D-122)
   - the sub-event belongs to the event in the path. One that does not, or that was deleted after the photo was queued, answers 409 `sub_event_missing` (D-122)
   - the hash. The caller's own row with no `uploaded_at` is a crashed upload, and pre-flight re-signs its existing keys and stops there, even when another user's finished row has the same hash, and completion then answers `duplicate`. Otherwise a row with this hash, `uploaded_at` set and no `deleted_at` is an exact duplicate, rejected silently. A deleted row and another user's unfinished row are ignored (D-53, D-96, D-122, D-130)
   - for a new row only: verification passes, meaning a `venue_verification` row OR `admin_verified_at IS NOT NULL` OR `role = 'photographer'` (D-15), and then the event holds fewer than 2,000 media rows that are not soft-deleted, finished or not, counted inside `start_upload` with the event row locked (§4.17, D-95). S-12 writes no verification query, and S-15 adds the check with `venue_verification` (D-122)
   - for a new row only: the caller holds fewer than 50 unfinished rows in the event that are not soft-deleted, or pre-flight answers 422 `too_many_unfinished` (D-122)
   All of these are indexed lookups.
3. **Keys and URLs.** The API makes the media id, builds both upload keys from it, and calls `start_upload` with them. It locks the event row `FOR NO KEY UPDATE` and makes every check after the first, in step 2's order. It returns the caller's own unfinished row rather than inserting a second one, so two devices on one account sending the same photo at once end with one row. Otherwise it counts and inserts the media row with the keys. The API presigns two PUT URLs that live 15 minutes, for the keys `start_upload` returned, which on a resume are the row's own (D-70, D-95, D-122).
4. **Upload.** The client PUTs the photo and the thumbnail to R2, one photo at a time per session, then calls completion.
5. **Complete and enqueue.** The API looks up the row first. A row that no longer exists answers `duplicate`, since only a duplicate completion deletes one, and so does a soft-deleted row, which its uploader deleted (D-122). Then it answers 403 `not_uploader` to anyone but the uploader, then 404 `not_found` when the event was deleted since pre-flight, then 403 `not_member` to an uploader who is no longer an active member. The 404 comes before the 403 as on every event endpoint (D-122). A row already finished answers `completed` there, with no HEAD and no message. The API sends R2 a HEAD for both objects and answers `upload_missing` if either is absent or empty. Then `complete_upload` locks the event row `FOR NO KEY UPDATE`, checks the caller uploaded the row, sets `uploaded_at` where it is null, stores `size_bytes`, and sends exactly one message to the `jobs` queue, all in one transaction. The message is `thumbnail_dims` until S-21 and `face_process` after (D-72, D-95). A repeated call changes nothing and answers `completed`. If another finished row that is not deleted already has the hash, it deletes this row, the API deletes its two objects, and it answers `duplicate` (D-96, D-130). Under the lock, two completions of one hash end as one `completed` and one `duplicate`, never a unique violation. A failed object delete is logged and the answer is still `duplicate` (D-122).
6. **Publish.** The worker sets `processed_at` last. The row passes the `media` policy and Realtime delivers it to every member (D-55).

Until verification passes or while the album is closed, photos wait in the device's SQLite queue. The queue is per device and per account (§4.1).

**Device queue storage, S-10.** The phone stores `queue_item` in `momentlens-upload-queue.db` through `expo-sqlite`, with WAL journaling and schema version 1. Each row carries `id`, `userId`, `eventId`, `subEventId`, `photoPath`, `thumbnailPath`, `capturedAt`, `createdAt`, `state`, `step`, `mediaId`, `contentHash`, `retryCount`, `nextRetryAt` and `stoppedReason`. The `queue_owner_event` index covers `userId`, `eventId` and `createdAt`. Every event read and count filters by account and event; mutations filter by account and item id (D-145, spec §4.1). The implementation is in `apps/mobile/src/features/upload-queue/`.

`state` is one of `queued`, `waiting_album`, `waiting_verification`, `uploading`, `uploaded`, `published`, `stopped` or `local_only`. `step` is one of `prepare`, `preflight`, `put_photo`, `put_thumbnail` or `complete`, so S-11 can retry completion after both PUTs without sending the files again. A stopped row requires one of `event_full`, `too_many_unfinished`, `sub_event_missing`, `invalid_request`, `not_uploader`, `not_member` or `not_found`; an uploaded or published row requires a media id. S-10 stores these states and publication updates; S-11 owns the network transitions in the table below (D-97, D-122, D-145).

The phone copies each picked source and its 300px thumbnail under `upload-queue/{userId}/{id}/` in its document directory before inserting the row. SQLite stores relative paths so a changed iOS sandbox path does not strand the files. Startup sweeps files that no row references. Local Delete removes the row before deleting its files; completion clears `photoPath` before deleting the source and retains the thumbnail and media id. The next launch sweeps a file left by a kill or failed cleanup. My Media displays local thumbnails without a shared image cache, checks processing rows on focus and foreground, and checks all uploaded rows on pull to refresh, in batches of 50. Status responses from an old account do not change the queue (D-145).

**What each answer does to a queued photo.** S-11 builds this loop, and it is the upload queue's state machine, a human-read surface (D-68, D-97). Status codes and error bodies follow Handbook §5.3. My Media's badges are clock for queued, spinner for uploading or processing, check for published, and a stopped photo shows its reason in place of a badge (§2.5.3, D-145). S-10 builds the SQLite table with a state for every row below, and S-11's loop moves a photo between them. After `completed` the photo stays in the table, holding its thumbnail and its media id, and `POST /events/{eventId}/media/status` (arch:media) tells the phone when it is published or deleted (D-145).

| Answer | The queued photo | It moves on when |
|---|---|---|
| Pre-flight 201 for a new row or 200 for a resume, with two PUT URLs | uploading | both PUTs finish, then completion |
| A PUT fails, or the app dies mid-upload | queued | the next attempt, whose pre-flight answers resume (D-82) |
| No answer to pre-flight or a PUT: offline, a timeout, a 5xx | queued | reconnect or foreground, with backoff |
| No answer to completion: offline, a timeout, a 5xx | uploading, both files sent, which the queue keeps across a relaunch | reconnect or foreground, with backoff, then completion again, which is safe to repeat (D-95). Never pre-flight, which would send both files again |
| Pre-flight or completion 401 `no_session` | unchanged, waiting on the session | the session refreshes or the person signs in again, then the same step again |
| Pre-flight or completion 400 `invalid_request` | stays in My Media, stopped, as an app bug | never; the person can delete it |
| Pre-flight 409 `duplicate` | leaves the queue, no prompt | never |
| Pre-flight 409 `album_closed` | queued, waiting on the album | an event fetch shows the album open |
| Pre-flight 409 `unverified` | queued, waiting on verification | the local GPS or QR check passes, or an event fetch shows the person verified (§4.5) |
| Pre-flight 422 `event_full` | stays in My Media with "This event is full" | never; the person can delete it |
| Pre-flight 422 `too_many_unfinished` | stays in My Media, stopped | never; the person can delete it (D-122) |
| Pre-flight 409 `sub_event_missing` | stays in My Media, stopped | never; the person can delete it (D-122) |
| Pre-flight or completion 403 `not_member`, or 404: not an active member, or the event is deleted | stays in My Media, stopped | an event fetch shows the membership active again |
| Completion 403 `not_uploader` | stays in My Media, stopped. The queue sent another account's photo, an app bug (§4.1) | never; the person can delete it |
| Completion 200 `completed` | uploaded; spinner until `processed_at` is set, then the check | never |
| Completion 409 `upload_missing` | uploading: both files again | both PUTs finish, then completion |
| Completion 409 `duplicate` | leaves the queue, no prompt | never |

---

## 5. Worker jobs
<!-- abstract: Six pgmq jobs: thumbnail_dims, face_process, reference_process, reprocess, blur_region and media_delete, with their triggers, plus blur geometry, the model, the one-reader rule and the failure path. -->

Every job is a message on one pgmq queue, `jobs`: `{ "job": "<name>" }` plus the ids in the second column. The worker handles one message at a time, oldest first, and reads a failed message again before any newer one (D-103, D-123). S-12's migration installs `pgmq` and creates `jobs`. pgmq is not on the Data API, so the API sends a message only from inside a SQL function (§1).

| Job | Message ids | Trigger | Does |
|---|---|---|---|
| `thumbnail_dims` | `media_id` | Upload completion, from S-18a until S-21 (D-72) | No ML. Acts only on a row whose `variant_version` is 0, and deletes any other row's message as done (D-123). Reads `width` and `height` by decoding the upload as stored, with no orientation applied (D-99). Points the public keys at the upload keys, bumps `variant_version` and sets `processed_at`, in one update that commits with the message's delete. Writes no object |
| `face_process` | `media_id` | Upload completion, from S-21 | Detects faces once and stores each box and embedding. Matches every face against the references that active members added to this event, and no other event's (D-141), and clusters the unmatched ones (D-74). If a matched subject's membership in this event has Do Not Publish on (D-129), writes N+1 blurred files, N+1 blurred thumbnails and the `dnp_subject` rows. Writes dimensions, bumps `variant_version`, sets `processed_at` last |
| `reference_process` | `face_reference_id` | A reference photo added to an event (D-141) | Accepts the photo with its embedding when it shows exactly one face, or rejects it as `no_face` or `multiple_faces` (D-91). Then enqueues `reprocess` for that subject in the reference's event. A removed reference never reaches this job: the API deletes it (§2) |
| `reprocess` | `subject_id`, `event_id`. Every trigger is one event's, because references and Do Not Publish both are (D-129, D-141) | Do Not Publish turned on in the event; the subject's references in the event changed, a removal included; a subject with references in the event became an active member again (D-84) | Re-matches stored embeddings and never detects (D-66). For every photo whose set of Do Not Publish subjects changed, regenerates the public file, every subject's file and all their thumbnails with every stored region, and bumps `variant_version` (spec §4.11.4.5) |
| `blur_region` | `media_id` | A `manual_blur_region` row added or deleted (S-19) | No ML. Regenerates that photo's public file, every subject's file and all their thumbnails with every stored region, at new versioned keys, and bumps `variant_version` (D-83) |
| `media_delete` | `media_id` | `delete_media`, from S-22 (D-130) | No ML. Deletes every object under the photo's `{media_id}/` prefix and the photo's `face`, `dnp_subject` and `manual_blur_region` rows, and leaves the `media` row with `deleted_at` and its hash. Runs after any job for the photo already in the queue, so files an earlier job wrote go too. S-22a builds it |

- **Blur.** Box expanded 30 to 40%, elliptical mask, downsample then upsample with a box blur on top (D-65). A blur region is blurred with the same strength over exactly the rectangle drawn. Thumbnails are cut from the blurred output.
- **Regions survive every regeneration.** `face_process`, `reprocess` and `blur_region` all apply the photo's stored regions. None of them regenerates from the bare upload alone (root invariant 6).
- **Model.** InsightFace through ONNX Runtime, loaded once at startup (D-40). `buffalo_l`, detection and recognition modules only (D-92).
- **Processes.** One worker process per machine, one message at a time (Handbook §6, D-103). One worker reads `jobs` at a time. It holds a Postgres advisory lock while it reads, so a second worker, a laptop pointed at the dev project included, logs that the queue is taken and waits. `DATABASE_URL` is the Supabase session pooler's connection string on port 5432, because the lock needs a session and the direct host is IPv6 only (D-123).
- **Transactions.** A job's row writes and its message's delete commit in one transaction. The worker holds its own transactions over `DATABASE_URL`, so it needs no SQL function for this (D-123).
- **Failures.** A try is a read, counted by pgmq's `read_ct`, so a crash counts as one. After a failed try the worker waits and reads the same message again before any newer one. A message that fails three times is archived, logged and reported to Sentry (`momentlens-worker`, §7). If it names a photo, the worker clears that photo's `processed_at` in the same transaction as the archive, so the photo leaves the album and never stays up with files a failed job should have replaced. Three kinds of message are archived on their first try, because a retry cannot help: one whose upload object is missing from R2, one that does not parse, and one naming a job the worker does not have. An R2 outage costs the try in flight, and the worker reads nothing more until R2 answers again. R2 refusing the worker's key or bucket counts as an outage, so a wrong `R2_*` value holds the queue instead of archiving it. Each time the worker takes the lock, at startup and after a reconnect, it makes every message a stopped worker left hidden visible again, so a crash or a lost database connection during a job costs that message a try. To run the job again, send the archived message from pgmq's archive for `jobs` back to `jobs` (D-103, D-108, D-123).
- **A row that is gone.** A message for a job the worker has, whose media row no longer exists, is deleted as done, with no retry, no archive and no Sentry report. One that does not parse or names an unknown job is archived even then. An event's hard delete leaves such messages, and so do the dev project's test runs (D-122). S-18a builds this. The API's RLS suite completes uploads with no file in R2, so a message it leaves is archived on its first try when the worker reads it before the suite deletes the row (D-123).
- **A deleted row.** A message naming a deleted photo, for any job but `media_delete`, is deleted as done, with no retry and no archive, as for a row that is gone. `reprocess` leaves deleted photos out of its match. Nobody can restore a deleted photo, so there is nothing to keep its files current for (D-130). A job already running when the photo is deleted may still write objects and `face` rows; `media_delete`, queued behind it, removes them.
- **Cleanup.** After a regeneration commits, the worker deletes the objects the rows no longer point at, never the upload keys (D-103).
- **Scheduled work.** None in demo scope. Retention deletion (§4.21) appears in no demo beat (D-44). It covers events and album expiry only, because a deleted photo's files go at once (D-130). If it gets built, `pg_cron` enqueues a daily pgmq message and the worker deletes the objects and rows.

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
- **Supabase Auth.** Both projects run the same settings, set by hand in each dashboard, and `supabase/config.toml` mirrors them for a local stack (D-109). Email confirmation is off, passwords need 8 characters, and `momentlens://reset-password` is in the redirect allow-list. Each project signs JWTs with an asymmetric key, so the API's `getClaims` checks tokens locally. Recovery mail goes through the built-in sender, which delivers only to the project team's addresses, 2 messages an hour. The access token lives 3600 seconds and refreshes itself. On the free plan refresh tokens never expire, and session time-box and inactivity timeout are Pro features, so a session ends at sign-out, a password change or a rejected refresh token (checked 2026-09-24). On 2026-09-24 Ukasha confirmed that both dashboards match these settings, and S-01's done stage read confirmation off and an ES256 signing key from the dev project's public Auth endpoints.
- **Mobile builds.** EAS profiles in `apps/mobile/eas.json`. `development` and `preview` use the dev environment variables, `production` uses stable. All three build an Android APK with internal distribution (D-61). The EAS project is `@momentlens/momentlens` (ID `5b7a8232-bb75-49ce-9e3a-64f52894e276`), owned by the `momentlens` organization. The app is MomentLens, with the URL scheme `momentlens` and `me.momentlens.app` as both the iOS bundle ID and the Android package.
- **Error reporting.** Sentry for Education, activated in September 2026 through the GitHub Student Developer Pack and free for one year. The organization is `momentlens` in the EU region (`de.sentry.io`), with the projects `momentlens-api` and `momentlens-app`. Both report uncaught errors only, with no tracing, no replay, no screenshots and no personal data. Each event carries an environment: `local` on a developer's machine, the EAS environment name in an EAS build, `development` from the dev server and `production` from the demo stack. The API sets it with `SENTRY_ENVIRONMENT` in `/srv/momentlens/.env`, and EAS builds with `EXPO_PUBLIC_SENTRY_ENVIRONMENT`. S-18a adds the project `momentlens-worker`, which reports archived messages only and stays off while `WORKER_SENTRY_DSN` is unset. The worker reads that variable rather than `SENTRY_DSN`, which is the API's, because both units read the same `/srv/momentlens/.env` (D-123).
- **Standby.** Not provisioned. Azure for Students, then AWS, then GCP, one credit at a time across the three members, with the VM created for the Phase 7 rehearsal and for demo week only (D-79). Two of Handbook §13's three criteria are met: `scripts/provision.sh` exists, and the DNS record is the bullet above. The rehearsal is still owed.
