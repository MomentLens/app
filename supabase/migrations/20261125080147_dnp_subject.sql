-- S-21: dnp_subject, each Do Not Publish subject's own files of one photo, and the per-event Do Not
-- Publish column on membership (D-57, D-60, D-69, D-174, arch:dnp_subject, arch:membership).
--
-- Schema only. The worker's face_process and blur_region write dnp_subject in S-21's worker build,
-- and the image-serving endpoint reads it in S-21's api build. The swap of complete_upload to
-- face_process is a migration of its own, 20261125080148_complete_upload_face_process.sql.
--
-- RLS is on with no policy (root invariant 14). The API reads dnp_subject as service_role and makes
-- every decision about it in its service layer. No Realtime publishes it: a subject's new file
-- reaches their phone through the media row's variant_version (spec §4.13).

create table public.dnp_subject (
  -- media_delete removes a deleted photo's rows (arch §5). The cascade covers an event's hard
  -- delete, which takes its media rows with it.
  media_id uuid not null references public.media (id) on delete cascade,
  -- Deleting an account deletes its subject and with it these rows. The public file still blurs
  -- that face, and the deleted account's files stay in R2 until media_delete removes the photo's
  -- prefix (arch:dnp_subject).
  subject_id uuid not null references public.subject (id) on delete cascade,
  -- Built by the worker at the media row's variant_version (arch §3, root invariants 2 and 12).
  variant_key text not null,
  variant_thumb_key text not null,
  -- The serving endpoint's lookup: this photo, this requester's subject.
  constraint dnp_subject_pkey primary key (media_id, subject_id),
  -- The serving endpoint presigns these for the subject alone. A key outside the row's own photo
  -- and subject would hand that file to them, and an upload key would hand them the unblurred
  -- photo, so a lone subject's file is written at its own key even when its bytes match the upload
  -- (root invariant 13). The version starts at 1, because the worker's first write bumps it from 0
  -- (D-122). A check cannot read media.variant_version; the worker writes both in one transaction.
  constraint dnp_subject_variant_key_check check (
    variant_key ~ ('^' || media_id::text || '/' || subject_id::text || '_v[1-9][0-9]*\.jpg$')
  ),
  constraint dnp_subject_variant_thumb_key_check check (
    variant_thumb_key ~ (
      '^' || media_id::text || '/' || subject_id::text || '_thumb_v[1-9][0-9]*\.webp$'
    )
  ),
  -- A file and its thumbnail come from one regeneration, so they carry one version (D-69).
  constraint dnp_subject_variant_version_check check (
    substring(variant_key from '_v([0-9]+)\.jpg$')
      = substring(variant_thumb_key from '_thumb_v([0-9]+)\.webp$')
  )
);

comment on table public.dnp_subject is
  'A Do Not Publish subject found in a photo, with that subject''s own file and thumbnail (D-57). Written only by the worker. RLS on, no policy: the API reads it with the secret key.';

-- The subject's cascade when an account is deleted.
create index dnp_subject_subject_idx on public.dnp_subject (subject_id);

alter table public.dnp_subject enable row level security;

-- The same grants as face. anon and authenticated keep SELECT so a stray query from the app returns
-- empty rows rather than an error, and lose every write privilege, so a policy added here by
-- mistake still could not let the app write (root invariant 14).
revoke all on table public.dnp_subject from anon, authenticated;
grant select on table public.dnp_subject to anon, authenticated;
grant select, insert, update, delete on table public.dnp_subject to service_role;

-- Do Not Publish for this person in this event, set once and never cleared (D-31, D-129). Null on
-- insert, so a new membership starts with it off. Remove from Event, a rejoin and a reject keep
-- the row, so they keep it. face_process reads it; S-29's activation function sets it, and until
-- then only tests do (D-174). Neither membership trigger reads it: the access counter advances on
-- role, status and requested_at only, and the Admin guard watches other columns.
alter table public.membership add column dnp_activated_at timestamptz;
