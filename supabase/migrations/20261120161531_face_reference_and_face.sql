-- S-20: face_reference and face, the tables behind per-event reference photos and the worker's
-- detection (D-91, D-141, D-172, arch:face_reference, arch:face).
--
-- Tables only. The API's functions, add_face_reference, delete_face_reference and set_avatar, come
-- in S-20's api build with their negative tests.
--
-- RLS is on with no policy (root invariant 14). The API reads both tables as service_role and makes
-- every decision about them in its service layer. The worker connects as postgres and writes
-- reference_process's decision and, from S-21, the face rows. No Realtime publishes either table, so
-- the app polls a pending reference (D-91).

-- pgvector, for the 512-float ArcFace embeddings. Every comparison happens in the worker, which
-- reads the vectors and compares them in numpy (D-74), so neither table has a vector index.
create extension if not exists vector with schema extensions;

create table public.face_reference (
  -- No default. The API passes the uploadId it made at POST .../references/upload, so a resent PUT
  -- finds its own row.
  id uuid primary key,
  -- Deleting the account deletes the subject and with it the references (D-141). Remove from Event
  -- deletes neither, so a rejoin matches them again (D-84).
  subject_id uuid not null references public.subject (id) on delete cascade,
  -- An event's hard delete takes its references with it (arch:face_reference).
  event_id uuid not null references public.event (id) on delete cascade,
  -- The API builds the key (root invariant 12). The check pins the event and the reference's own
  -- id, so no other event's object or another row's object can be stored here. The user id part is
  -- the subject's, which a check cannot read; the API writes it from the caller.
  photo_key text not null,
  status text not null default 'pending',
  reject_reason text,
  -- Null until reference_process accepts the photo (D-91).
  embedding extensions.vector(512),
  created_at timestamptz not null default now(),
  constraint face_reference_photo_key_key unique (photo_key),
  constraint face_reference_photo_key_check check (
    photo_key ~ (
      '^users/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/events/'
      || event_id::text || '/reference_' || id::text || '\.jpg$'
    )
  ),
  constraint face_reference_status_check check (status in ('pending', 'accepted', 'rejected')),
  -- `failed` is a final failure of reference_process, set in the archive's transaction (D-172).
  constraint face_reference_reject_reason_check check (
    reject_reason in ('no_face', 'multiple_faces', 'failed')
  ),
  -- The Reference schema in packages/shared-types refuses any other pairing, so a stored row always
  -- parses.
  constraint face_reference_reject_reason_status_check check (
    (status = 'rejected') = (reject_reason is not null)
  ),
  -- Only an accepted row has an embedding, and every accepted row has one, so matching never meets
  -- an accepted reference it cannot compare (D-87, D-91).
  constraint face_reference_embedding_status_check check (
    (status = 'accepted') = (embedding is not null)
  )
);

-- The owner's list in one event, in the contract's order, and the count of 5 that are not rejected
-- (spec §4.2).
create index face_reference_subject_event_idx
  on public.face_reference (subject_id, event_id, created_at, id);

-- Matching in one event reads only that event's accepted references (D-141).
create index face_reference_event_accepted_idx
  on public.face_reference (event_id) where status = 'accepted';

create table public.face (
  id uuid primary key default gen_random_uuid(),
  -- media_delete removes a deleted photo's faces (arch §5). The cascade covers an event's hard
  -- delete, which takes its media rows with it.
  media_id uuid not null references public.media (id) on delete cascade,
  -- The detector's box, not yet expanded for the blur, as fractions of the stored image, which
  -- Stage 1 already turned upright (D-99). The same shape as manual_blur_region, so reprocess blurs
  -- from it without detecting again (D-30, D-66). The worker clamps a box that runs past an edge.
  x double precision not null,
  y double precision not null,
  width double precision not null,
  height double precision not null,
  embedding extensions.vector(512) not null,
  -- The subject this face matched, from the references active members added to this photo's event
  -- (D-74, D-141). Null while arch §6 has no match threshold (D-104). Deleting a subject's account
  -- leaves the face, unmatched.
  matched_subject_id uuid references public.subject (id) on delete set null,
  -- Cosine similarity to the matched subject's closest reference.
  similarity double precision,
  -- The Unknown identity for an unmatched face (spec §4.11). Null while arch §6 has no clustering
  -- threshold (D-104, D-172). No table: the id only groups faces.
  cluster_id uuid,
  created_at timestamptz not null default now(),
  constraint face_box_check check (
    x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= 1 and y + height <= 1
  ),
  -- A match always carries its similarity. A subject's account deleted after the match leaves the
  -- similarity on a face that no longer names anyone.
  constraint face_similarity_check check (
    (matched_subject_id is null or similarity is not null)
    and (similarity is null or similarity between -1 and 1)
  ),
  -- Only an unmatched face joins an Unknown cluster (arch:face).
  constraint face_cluster_check check (matched_subject_id is null or cluster_id is null)
);

create index face_media_idx on public.face (media_id);
create index face_matched_subject_idx on public.face (matched_subject_id)
  where matched_subject_id is not null;

alter table public.face_reference enable row level security;
alter table public.face enable row level security;

-- Explicit, as for profile and subject. anon and authenticated keep SELECT so a stray query from
-- the app returns empty rows rather than an error, and lose every write privilege, so a policy
-- added here by mistake still could not let the app write (root invariant 14).
revoke all on table public.face_reference, public.face from anon, authenticated;
grant select on table public.face_reference, public.face to anon, authenticated;
grant select, insert, update, delete on table public.face_reference, public.face to service_role;
