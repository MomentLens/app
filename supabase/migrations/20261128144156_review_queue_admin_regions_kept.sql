-- S-24: regions the event's Admin drew before 20261127211924_review_queue.sql took the column's
-- default, 'open', so they sat in the Admin's own Review Queue. From that migration on,
-- add_blur_region inserts an Admin draw as 'kept'; this sets the earlier ones to match
-- (D-181, arch:manual_blur_region). The regions stay on their photos, so no blur_region job is
-- sent: the files do not change (root invariant 6).
--
-- A database guard keeps the creator's Admin role and refuses promoting anyone else to Admin
-- (D-114, D-143), so the drawer's membership today says who drew as Admin.
-- A repeat run changes nothing.

update public.manual_blur_region r
set state = 'kept'
from public.media m
join public.membership mb on mb.event_id = m.event_id
where m.id = r.media_id
  and mb.user_id = r.drawn_by_user_id
  and mb.role = 'admin'
  and r.state = 'open';
