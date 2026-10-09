import { z } from 'zod';

import {
  EventName,
  InviteRole,
  MAX_SUB_EVENTS,
  Membership,
  MembershipStatus,
  Timestamp,
} from './event';
import { PresignedImage } from './image';

/**
 * An invite's token, the last segment of `momentlens://invite/{token}` (D-101): 32 random bytes as
 * base64url without padding, so 43 characters (arch:invite).
 */
export const InviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type InviteToken = z.infer<typeof InviteToken>;

/**
 * The characters a shortcode is made from. 0, O, 1, I and L are left out because they read alike
 * (arch:invite). The migration that generates codes draws from this same set.
 */
export const SHORTCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SHORTCODE_LENGTH = 6;

/**
 * A shortcode as someone typed or pasted it, in the stored form: every whitespace character
 * removed and the rest uppercased, since entry ignores case and spaces (arch:invite). It checks
 * nothing else; `Shortcode` does.
 */
export function normalizeShortcode(input: string): string {
  return input.replace(/\s/g, '').toUpperCase();
}

/**
 * A shortcode, normalized before it is checked, so the API reads "ab3 k7x" as "AB3K7X". Anything
 * that is not then 6 characters from `SHORTCODE_ALPHABET` fails, and Manual Join Entry shows that
 * inline without asking the API (spec §2.4).
 */
export const Shortcode = z
  .string()
  .transform(normalizeShortcode)
  .pipe(z.string().regex(new RegExp(`^[${SHORTCODE_ALPHABET}]{${SHORTCODE_LENGTH}}$`)));
export type Shortcode = z.infer<typeof Shortcode>;

/**
 * How the app names an invite: the token from an opened or pasted link, or a typed shortcode. It
 * goes in the body and never the path, because hb §5.3 puts only uuids in a path and nginx logs
 * every path (arch:invite).
 *
 * Each object is strict, so a body must carry exactly one of the two and nothing else. A body
 * with both is a 400 rather than a guess at which one the app meant.
 */
export const InviteLookup = z.union([
  z.strictObject({ token: InviteToken }),
  z.strictObject({ code: Shortcode }),
]);
export type InviteLookup = z.infer<typeof InviteLookup>;

/**
 * The event as its invite previews it (D-115). Join Confirmation, the signup banner and Join
 * Blocked show it (spec §2.3.1, §2.5.8).
 *
 * - `id` lets the app open Event Home for a member and Pending Approval for a requester. The
 *   cover's `cacheKey` carries the same id, so it tells an invite holder nothing new.
 * - `startsAt` and `endsAt` are the span, computed as `EventSummary` computes them.
 * - `venueNames` holds each venue once, in the order its first sub-event starts.
 * - It carries no member, no venue position and no `qr_secret` (arch §1). zod drops an unknown
 *   key, so a column that leaks into the mapping never reaches the body, and the API tests for
 *   it too.
 */
export const InvitePreview = z.object({
  id: z.uuid(),
  name: EventName,
  cover: PresignedImage.nullable(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  venueNames: z.array(EventName).min(1).max(MAX_SUB_EVENTS),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

/**
 * POST /invites/resolve, with or without a session (D-115). No header means signed out. A header
 * with a bad or expired session is a 401 `no_session`, never a signed-out lookup.
 */
export const ResolveInviteRequest = InviteLookup;
export type ResolveInviteRequest = z.infer<typeof ResolveInviteRequest>;

/**
 * POST /invites/resolve. Everyone holding a live invite gets the same `role` and `event`. A dead
 * invite is a 404 `not_found`: an unknown token or code, a revoked invite, or a deleted or
 * archived event (arch:invite). There is no rate limit (D-115).
 *
 * The app reads a 404 by where the invite came from. A link goes to Join Error. A typed code gets
 * inline validation on Manual Join Entry, whether it was mistyped or revoked, because one `code`
 * cannot tell those apart (spec §2.4).
 *
 * `role` is the one the invite joins as. `membership` is the caller's own in this event, and null
 * when they are signed out or have no row. The app routes on it: `active` to Event Home,
 * `pending` to Pending Approval, `blocked` to Join Blocked, and null or `removed` to Join
 * Confirmation.
 */
export const ResolveInviteResponse = z.object({
  role: InviteRole,
  event: InvitePreview,
  membership: Membership.nullable(),
});
export type ResolveInviteResponse = z.infer<typeof ResolveInviteResponse>;

/** POST /invites/join, for a signed-in caller, with the invite Join Confirmation showed. */
export const JoinEventRequest = InviteLookup;
export type JoinEventRequest = z.infer<typeof JoinEventRequest>;

/**
 * POST /invites/join. One `join_event` call makes the caller `active` or `pending` by the event's
 * approval mode, with the role the invite carries (arch:membership, D-115).
 *
 * - A 201 when this call inserted the caller's row, and a 200 when it did not (hb §5.3).
 * - A rejoin after removal is a 200. It updates the `removed` row to the link's role, `active` or
 *   `pending` by the approval mode.
 * - A repeat is a 200 and returns the row unchanged, so an Admin or a Photographer who opens the
 *   Guest Link keeps their role, and a requester stays `pending`.
 * - A 404 `not_found` when the invite died after Join Confirmation showed it, and the app shows
 *   Join Error.
 * - A 403 `blocked` when the Admin blocked the caller, and the app shows Join Blocked (D-115).
 * - A 422 `event_full` when the caller would be the 151st `active` Guest, shown inline on Join
 *   Confirmation. A Photographer does not count, and a request to a `manual` event past 150 is
 *   let in as `pending`, because the cap applies at approval (spec §4.17).
 */
export const JoinEventResponse = z.object({
  membership: Membership.extend({
    status: MembershipStatus.extract(['active', 'pending']),
  }),
});
export type JoinEventResponse = z.infer<typeof JoinEventResponse>;

/**
 * DELETE /events/{eventId}/join-request, for a signed-in caller, with no body. It deletes the
 * caller's own row in that event, and only while the row is `pending` (arch:membership).
 *
 * `membership` is what the caller holds afterwards, always with a 200. It is null once the request
 * is gone, whether this call deleted it or there was none. A row in any other state is left alone
 * and returned, so a cancel that loses a race with an approve comes back `active` and the app
 * opens Event Home.
 */
export const CancelJoinRequestResponse = z.object({
  membership: Membership.nullable(),
});
export type CancelJoinRequestResponse = z.infer<typeof CancelJoinRequestResponse>;

/** The active Admin's current credentials for one role (D-152, arch:invite). */
export const ManagedInvite = z.object({
  id: z.uuid(),
  role: InviteRole,
  token: InviteToken,
  code: Shortcode,
});
export type ManagedInvite = z.infer<typeof ManagedInvite>;

/**
 * GET /events/{eventId}/invites, with no request body. The active Admin receives one current
 * invite per role. A missing role or extra current row is 500 `internal_error`; the read issues
 * no credential. Unknown or deleted events return 404 `not_found`, inactive or absent members
 * return 403 `not_member`, and other active roles return 403 `wrong_role` (D-152, hb §5.3).
 * Archived events permit management, while the app disables Copy and Share.
 */
export const ListInvitesResponse = z.object({
  invites: z
    .array(ManagedInvite)
    .length(2)
    .refine((invites) => new Set(invites.map((invite) => invite.role)).size === 2, {
      message: 'Expected one Guest invite and one Photographer invite',
    }),
});
export type ListInvitesResponse = z.infer<typeof ListInvitesResponse>;

/**
 * POST /events/{eventId}/invites/regenerate. The Admin sends the id currently displayed for the
 * chosen role. A stale, revoked or cross-event id returns 409 `invite_changed` without a write.
 * The app refetches before another explicit action and never retries an uncertain result (D-152).
 */
export const RegenerateInviteRequest = z.strictObject({
  role: InviteRole,
  expectedInviteId: z.uuid(),
});
export type RegenerateInviteRequest = z.infer<typeof RegenerateInviteRequest>;

/**
 * The replacement after the transaction commits. Both management responses use no-store.
 * The old token and code die together; memberships and the other role's invite stay unchanged.
 * Issuance failure rolls back revocation. Access refusals match ListInvitesResponse (D-152).
 */
export const RegenerateInviteResponse = z.object({
  invite: ManagedInvite,
});
export type RegenerateInviteResponse = z.infer<typeof RegenerateInviteResponse>;
