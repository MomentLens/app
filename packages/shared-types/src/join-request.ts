import { z } from 'zod';

import { AccessVersion, Attendee, AttendeeMembership } from './attendee';
import { InviteRole, MembershipStatus } from './event';

/** The most people one approve or reject names (D-144). Select All stops here too. */
export const MAX_JOIN_REQUEST_BATCH = 50;

/**
 * One `pending` membership in the Admin's Pending Approvals queue (D-144). The fields are an
 * attendee's. `role` is the one the requester's invite carried, so never `admin`, and
 * `requestedAt` is the join or rejoin that made the request. The app sends `accessVersion` back
 * unchanged with an approve, reject or block, so a request cancelled and made again through the
 * other link never matches an old one (D-143).
 *
 * `avatar` is null for everyone, and the API reads no avatar key, until S-29 (D-144).
 */
export const PendingRequest = Attendee.extend({
  role: InviteRole,
});
export type PendingRequest = z.infer<typeof PendingRequest>;

/**
 * GET /events/{eventId}/join-requests, for the event's active Admin only (D-144). A query field,
 * with no body. The path alone identifies the event.
 *
 * The API returns pages of 50 `pending` rows, oldest `requestedAt` first, then user id. The app
 * passes the opaque `cursor` back unchanged; the API validates its encoding and answers 400
 * `invalid_request` for a cursor from another event.
 */
export const ListPendingRequestsRequest = z.strictObject({
  cursor: z.string().min(1).optional(),
});
export type ListPendingRequestsRequest = z.infer<typeof ListPendingRequestsRequest>;

/**
 * GET /events/{eventId}/join-requests. An empty page is valid and `nextCursor: null` ends
 * pagination.
 *
 * `guestPlacesLeft` is how many more Guests the event can make `active` under the 150 cap when
 * this page was read, never below 0. The Admin and Photographers do not count (spec §4.17,
 * D-102). The app shows it after an approve answers 422 `event_full`, because the error body has
 * no room for it (D-144).
 *
 * All four join-request endpoints refuse a missing or expired session with 401 `no_session`, an
 * unknown or deleted event with 404 `not_found`, a non-active actor with 403 `not_member`, and an
 * active Guest or Photographer actor with 403 `wrong_role` (hb §5.3, D-143). An archived event
 * permits reads and writes, and sub-event timing gates none of them (D-144).
 */
export const ListPendingRequestsResponse = z.object({
  requests: z.array(PendingRequest).max(50),
  nextCursor: z.string().min(1).nullable(),
  guestPlacesLeft: z.int().min(0),
});
export type ListPendingRequestsResponse = z.infer<typeof ListPendingRequestsResponse>;

/**
 * One person an approve or reject acts on, with the `accessVersion` the list returned for them as
 * `expectedVersion` (D-143, D-144).
 */
export const PendingRequestTarget = z.strictObject({
  userId: z.uuid(),
  expectedVersion: AccessVersion,
});
export type PendingRequestTarget = z.infer<typeof PendingRequestTarget>;

// 1 to 50 distinct people. `z.uuid()` accepts upper-case hex and Postgres reads both spellings as
// one user, so the duplicate check compares lower case.
const PendingRequestTargets = z
  .array(PendingRequestTarget)
  .min(1)
  .max(MAX_JOIN_REQUEST_BATCH)
  .refine(
    (targets) => new Set(targets.map((t) => t.userId.toLowerCase())).size === targets.length,
    { message: 'A person appears more than once' },
  );

/**
 * POST /events/{eventId}/join-requests/approve. Sets every target `active` in one
 * `approve_requests` call, all or nothing (D-144). A tap on one row sends a batch of one.
 *
 * - A target with no row in this event, one that is not `pending`, the Admin included, or a stale
 *   `expectedVersion` refuses the batch with 409 `membership_changed`.
 * - Guests that would take the event past 150 `active` Guests refuse it with 422 `event_full`.
 *   Photographers do not count (D-102).
 * - A duplicate `userId`, or more than 50 targets, is 400 `invalid_request`.
 * - A refusal writes nothing. The app refetches the list after a 409, a 422 or an uncertain
 *   result. It never queues an approve or retries one whose result is uncertain; the one resend
 *   after a 401 and an Auth refresh still applies (hb §5.3).
 */
export const ApproveRequestsRequest = z.strictObject({
  targets: PendingRequestTargets,
});
export type ApproveRequestsRequest = z.infer<typeof ApproveRequestsRequest>;

/**
 * POST /events/{eventId}/join-requests/approve. A 200 with one membership per target, now
 * `active`, with its new version and no profile, in no promised order. S-27 reads the user ids.
 */
export const ApproveRequestsResponse = z.object({
  memberships: z
    .array(
      AttendeeMembership.extend({
        role: InviteRole,
        status: MembershipStatus.extract(['active']),
      }),
    )
    .min(1)
    .max(MAX_JOIN_REQUEST_BATCH),
});
export type ApproveRequestsResponse = z.infer<typeof ApproveRequestsResponse>;

/**
 * POST /events/{eventId}/join-requests/reject. The same body, target checks and 409 as an
 * approve, with no cap, in one `reject_requests` call (D-144). Sets every target `removed` and
 * keeps the row, so the person may ask again through a live invite (D-102). The app asks nothing
 * first.
 */
export const RejectRequestsRequest = z.strictObject({
  targets: PendingRequestTargets,
});
export type RejectRequestsRequest = z.infer<typeof RejectRequestsRequest>;

/**
 * POST /events/{eventId}/join-requests/reject. A 200 with one membership per target, now
 * `removed`, with its new version and no profile, in no promised order. S-27 reads the user ids.
 */
export const RejectRequestsResponse = z.object({
  memberships: z
    .array(
      AttendeeMembership.extend({
        role: InviteRole,
        status: MembershipStatus.extract(['removed']),
      }),
    )
    .min(1)
    .max(MAX_JOIN_REQUEST_BATCH),
});
export type RejectRequestsResponse = z.infer<typeof RejectRequestsResponse>;

/**
 * POST /events/{eventId}/join-requests/{userId}/block. One target, named by the path, in one
 * `block_request` call (D-144). There is no bulk block, and the app confirms first.
 *
 * The target checks are an approve's: no row in this event, not `pending`, the Admin included, or
 * a stale `expectedVersion` is 409 `membership_changed`, and the refusal writes nothing. Block sets
 * `blocked`, and the person sees Join Blocked the next time they open an invite (D-115).
 */
export const BlockRequestRequest = z.strictObject({
  expectedVersion: AccessVersion,
});
export type BlockRequestRequest = z.infer<typeof BlockRequestRequest>;

/** POST /events/{eventId}/join-requests/{userId}/block. A 200 with the blocked target. */
export const BlockRequestResponse = z.object({
  membership: AttendeeMembership.extend({
    role: InviteRole,
    status: MembershipStatus.extract(['blocked']),
  }),
});
export type BlockRequestResponse = z.infer<typeof BlockRequestResponse>;
