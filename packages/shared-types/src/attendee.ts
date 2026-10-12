import { z } from 'zod';

import {
  InviteRole,
  Membership,
  MembershipRole,
  MembershipStatus,
  Timestamp,
  VerificationState,
} from './event';
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
 * membership's join or rejoin time. Pending Approvals reuses this base shape (D-144, D-157).
 * It carries no verification state, avatar key or face data.
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

/** An active attendee with required server coverage in this event (D-157). */
export const AttendeeWithVerification = Attendee.extend({
  verification: VerificationState,
});
export type AttendeeWithVerification = z.infer<typeof AttendeeWithVerification>;

/** The target's membership after an action, with its current version and no profile (D-143). */
export const AttendeeMembership = Membership.extend({
  userId: z.uuid(),
  accessVersion: AccessVersion,
});
export type AttendeeMembership = z.infer<typeof AttendeeMembership>;

/**
 * GET /events/{eventId}/attendees, for the event's active Admin only (D-143, D-157). These are
 * query fields, with no body. The path alone identifies the event.
 *
 * `search` is literal case-insensitive name text, trimmed as a name is and bounded in code
 * points. An empty search lists everyone. `role` includes the Admin. `checkIn` needs
 * `subEventId` and combines with search and role. Checked in means server coverage for that
 * sub-event through a venue check-in, manual coverage or an exempt role.
 *
 * The API returns pages of 50 ordered by full name, then user id. The opaque `cursor` binds
 * event, search, role, sub-event and check-in filter. The API validates its encoding and
 * refuses a changed query with 400 `invalid_request`.
 */
export const ListAttendeesRequest = z
  .strictObject({
    search: z
      .string()
      .trim()
      .refine((text) => Array.from(text).length <= FULL_NAME_MAX, {
        message: `Too big: expected at most ${FULL_NAME_MAX} characters`,
      })
      .optional(),
    role: MembershipRole.optional(),
    subEventId: z.uuid().optional(),
    checkIn: z.enum(['checked_in', 'not_checked_in']).optional(),
    cursor: z.string().min(1).optional(),
  })
  .refine((request) => request.checkIn === undefined || request.subEventId !== undefined, {
    message: 'A check-in filter requires a sub-event',
    path: ['subEventId'],
  });
export type ListAttendeesRequest = z.infer<typeof ListAttendeesRequest>;

/**
 * GET /events/{eventId}/attendees. Only active memberships appear. An empty page is valid and
 * `nextCursor: null` ends pagination (D-143). Pending requests belong to S-07.
 *
 * All attendee endpoints refuse a missing or expired session with 401 `no_session`, an
 * unknown or deleted event with 404 `not_found`, a non-active actor with 403 `not_member`, and
 * an active Guest or Photographer actor with 403 `wrong_role` (hb §5.3, D-143). The list also
 * answers 400 `invalid_request` for a check-in filter without a sub-event or a cursor from
 * another event, search, role, sub-event or check-in filter (D-157). An unknown, deleted or
 * other-event sub-event answers 404 `not_found`. Rows carry server coverage for that attendee.
 * An archived event permits reads and writes, regardless of sub-event timing or album state.
 */
export const ListAttendeesResponse = z.object({
  attendees: z.array(AttendeeWithVerification).max(50),
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

/**
 * POST /events/{eventId}/attendees/{userId}/force-verify (D-157). The event's active Admin sends
 * the target's loaded access version. Only the path identifies the event and target; the API
 * reads the actor from authentication. The body accepts no grant, role or timestamp.
 *
 * An absent target in this event answers 404 `not_found`, an Admin target 400 `invalid_request`,
 * and an inactive target or stale version 409 `membership_changed`. Each refusal writes nothing.
 * Archived events permit the action, regardless of album state or sub-event timing.
 *
 * The app never queues this write or retries an uncertain result. After success, a conflict
 * or an uncertain result, it refetches Attendees before another action. The one resend after
 * a 401 and an Auth refresh still applies (hb §5.3).
 */
export const ForceVerifyAttendeeRequest = z.strictObject({
  expectedVersion: AccessVersion,
});
export type ForceVerifyAttendeeRequest = z.infer<typeof ForceVerifyAttendeeRequest>;

/**
 * POST /events/{eventId}/attendees/{userId}/force-verify. A 200 carries the active Guest or
 * Photographer membership and the first server-written manual check-in time (D-157).
 * Repeats preserve that time and the access version. Manual coverage permits uploads to every
 * past and future sub-event in this event; the next event fetch tells the Guest's upload gate.
 */
export const ForceVerifyAttendeeResponse = z.object({
  membership: AttendeeMembership.extend({
    role: InviteRole,
    status: MembershipStatus.extract(['active']),
  }),
  adminVerifiedAt: Timestamp,
});
export type ForceVerifyAttendeeResponse = z.infer<typeof ForceVerifyAttendeeResponse>;
