import { z } from 'zod';

import { InviteRole, Membership, MembershipRole, MembershipStatus, Timestamp } from './event';
import { PresignedImage } from './image';
import { FULL_NAME_MAX, FullName } from './profile';

/**
 * An opaque membership version combining its row id and access counter (D-143). The app sends
 * it back unchanged. A rejoin or a deleted and recreated membership invalidates an old token.
 * The API owns its encoding and checks its identity and counter against the target row.
 */
export const AccessVersion = z.string().min(1).max(256);
export type AccessVersion = z.infer<typeof AccessVersion>;

/**
 * One active attendee, the creator Admin included (D-143). `requestedAt` is the current
 * membership's join or rejoin time. No verification state, avatar key or face data is returned.
 *
 * S-06 returns `avatar: null` for everyone. S-29 supplies event-scoped avatar privacy through
 * the shared presigner; the contract reserves that nullable image shape now.
 */
export const Attendee = z.object({
  userId: z.uuid(),
  fullName: FullName,
  role: MembershipRole,
  requestedAt: Timestamp,
  accessVersion: AccessVersion,
  avatar: PresignedImage.nullable(),
});
export type Attendee = z.infer<typeof Attendee>;

/** The target's membership after an action, with its current version and no profile (D-143). */
export const AttendeeMembership = Membership.extend({
  userId: z.uuid(),
  accessVersion: AccessVersion,
});
export type AttendeeMembership = z.infer<typeof AttendeeMembership>;

/**
 * GET /events/{eventId}/attendees, for the event's active Admin only (D-143). These are query
 * fields, with no body. The path alone identifies the event.
 *
 * `search` is literal case-insensitive name text, not a pattern. It is trimmed as a name is
 * and holds at most as many code points as a name, so a trailing space from the keyboard still
 * matches. An empty search lists everyone. `role` includes the Admin.
 * The API returns pages of 50 ordered by full name, then user id. The app passes the opaque
 * `cursor` back unchanged with the same filters; the API validates its encoding.
 */
export const ListAttendeesRequest = z.strictObject({
  search: z
    .string()
    .trim()
    .refine((text) => Array.from(text).length <= FULL_NAME_MAX, {
      message: `Too big: expected at most ${FULL_NAME_MAX} characters`,
    })
    .optional(),
  role: MembershipRole.optional(),
  cursor: z.string().min(1).optional(),
});
export type ListAttendeesRequest = z.infer<typeof ListAttendeesRequest>;

/**
 * GET /events/{eventId}/attendees. Only active memberships appear. An empty page is valid and
 * `nextCursor: null` ends pagination (D-143). Pending requests belong to S-07.
 *
 * All four attendee endpoints refuse a missing or expired session with 401 `no_session`, an
 * unknown or deleted event with 404 `not_found`, a non-active actor with 403 `not_member`, and
 * an active Guest or Photographer actor with 403 `wrong_role` (hb §5.3, D-143). The list also
 * answers 400 `invalid_request` for a cursor from another event, search or role.
 * An archived event permits reads and writes, regardless of sub-event timing or album state.
 */
export const ListAttendeesResponse = z.object({
  attendees: z.array(Attendee).max(50),
  nextCursor: z.string().min(1).nullable(),
});
export type ListAttendeesResponse = z.infer<typeof ListAttendeesResponse>;

/**
 * PATCH /events/{eventId}/attendees/{userId}/role (D-143). The target must be active and
 * non-Admin. Only the path identifies the target and event; no other body fields are accepted.
 *
 * Every mutation requires the target's loaded `accessVersion` as `expectedVersion`. An absent
 * target in this event is 404 `not_found`, a protected Admin target is 400 `invalid_request`,
 * and a non-active target or stale version is 409 `membership_changed`. A refusal writes
 * nothing. Photographer-to-Guest at the 150 Guest cap answers 422 `event_full` unchanged.
 *
 * A matching-version same-role request succeeds without advancing the version. A completed
 * change invalidates its old token. The app never queues a mutation or retries one whose result
 * is uncertain; it refetches Attendees after `membership_changed` or an uncertain response. A 401
 * is not uncertain, because the API refused before the handler ran, so the client's one resend
 * after an Auth refresh applies (hb §5.3).
 */
export const ChangeAttendeeRoleRequest = z.strictObject({
  expectedVersion: AccessVersion,
  role: InviteRole,
});
export type ChangeAttendeeRoleRequest = z.infer<typeof ChangeAttendeeRoleRequest>;

/** PATCH /events/{eventId}/attendees/{userId}/role. A 200 with the active non-Admin target. */
export const ChangeAttendeeRoleResponse = z.object({
  membership: AttendeeMembership.extend({
    role: InviteRole,
    status: MembershipStatus.extract(['active']),
  }),
});
export type ChangeAttendeeRoleResponse = z.infer<typeof ChangeAttendeeRoleResponse>;

/**
 * POST /events/{eventId}/attendees/{userId}/remove. The same actor, target and version checks
 * as the role PATCH apply (D-143). Sets `removed`, retains uploads and permits a later rejoin
 * through a live invite (D-102). Changes no verification or privacy field.
 */
export const RemoveAttendeeRequest = z.strictObject({
  expectedVersion: AccessVersion,
});
export type RemoveAttendeeRequest = z.infer<typeof RemoveAttendeeRequest>;

/** POST /events/{eventId}/attendees/{userId}/remove. A 200 with the removed non-Admin target. */
export const RemoveAttendeeResponse = z.object({
  membership: AttendeeMembership.extend({
    role: InviteRole,
    status: MembershipStatus.extract(['removed']),
  }),
});
export type RemoveAttendeeResponse = z.infer<typeof RemoveAttendeeResponse>;

/**
 * POST /events/{eventId}/attendees/{userId}/block. The same actor, target and version checks
 * as the role PATCH apply (D-143). Sets `blocked`, retains uploads and prevents rejoining
 * (D-102). Changes no verification or privacy field.
 */
export const BlockAttendeeRequest = z.strictObject({
  expectedVersion: AccessVersion,
});
export type BlockAttendeeRequest = z.infer<typeof BlockAttendeeRequest>;

/** POST /events/{eventId}/attendees/{userId}/block. A 200 with the blocked non-Admin target. */
export const BlockAttendeeResponse = z.object({
  membership: AttendeeMembership.extend({
    role: InviteRole,
    status: MembershipStatus.extract(['blocked']),
  }),
});
export type BlockAttendeeResponse = z.infer<typeof BlockAttendeeResponse>;
