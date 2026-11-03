import { z } from 'zod';

import {
  InviteRole,
  ListInvitesResponse,
  ManagedInvite,
  Membership,
  MembershipRole,
  MembershipStatus,
  Shortcode,
} from '@momentlens/shared-types';
import type {
  CancelJoinRequestResponse,
  InviteLookup,
  JoinEventResponse,
  RegenerateInviteRequest,
  RegenerateInviteResponse,
  ResolveInviteResponse,
} from '@momentlens/shared-types';

import { isForeignKeyViolation } from '../db/sql';
import type { Sql } from '../db/sql';
import type { PresignGet } from '../lib/r2';
import { ApiError } from '../middleware/errors';
import { MAX_ACTIVE_GUESTS, presignCover, toTimestamp } from './events';

// A live invite's preview before its cover is presigned (D-115). Timestamps are already in
// toISOString form.
export interface InvitePreviewRecord {
  role: InviteRole;
  event: {
    id: string;
    name: string;
    coverKey: string | null;
    startsAt: string;
    endsAt: string;
    venueNames: string[];
  };
  // The caller's own membership in the event, null when signed out or when they have none.
  membership: Membership | null;
}

// What join_event did (supabase/migrations/..._invite_and_join.sql). A join never leaves the
// caller blocked or removed, so the membership is active or pending. no_account is a valid token
// whose account was deleted since it was issued.
export type JoinResult =
  | {
      outcome: 'created' | 'rejoined' | 'member';
      membership: JoinEventResponse['membership'];
    }
  | { outcome: 'dead' | 'blocked' | 'full' | 'no_account' };

// Every read and write the invite endpoints make. It checks nothing about who asks; the functions
// below do.
export interface InviteStore {
  // Null when the invite is dead: unknown, revoked, or its event deleted or archived
  // (arch:invite). userId is null for a caller with no session.
  resolve(lookup: InviteLookup, userId: string | null): Promise<InvitePreviewRecord | null>;
  // One join_event call, with maxGuests as the cap on active Guests.
  join(userId: string, lookup: InviteLookup, maxGuests: number): Promise<JoinResult>;
  // Deletes the user's row in this event only while it is pending, then returns the row the user
  // holds there, if any.
  cancelJoinRequest(eventId: string, userId: string): Promise<Membership | null>;
}

function lookupParams(lookup: InviteLookup) {
  return 'token' in lookup
    ? { p_token: lookup.token, p_shortcode: null }
    : { p_token: null, p_shortcode: lookup.code };
}

// resolve_invite's and join_event's arguments. Exported so the dev-project test can call both
// functions with the publishable key and see them refused.
export function resolveInviteParams(lookup: InviteLookup, userId: string | null) {
  return { ...lookupParams(lookup), p_user_id: userId };
}

export function joinEventParams(userId: string, lookup: InviteLookup, maxGuests: number) {
  return { p_user_id: userId, ...lookupParams(lookup), p_max_guests: maxGuests };
}

// A row of resolve_invite. Parsed rather than cast, so a renamed column fails here, and every
// column not named here is dropped.
const PreviewRow = z.object({
  role: InviteRole,
  event_id: z.uuid(),
  name: z.string(),
  cover_key: z.string().nullable(),
  starts_at: z.string().transform(toTimestamp),
  ends_at: z.string().transform(toTimestamp),
  venue_names: z.array(z.string()),
  member_role: MembershipRole.nullable(),
  member_status: MembershipStatus.nullable(),
});

const JoinRow = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.enum(['created', 'rejoined', 'member']),
    role: MembershipRole,
    status: MembershipStatus.extract(['active', 'pending']),
  }),
  z.object({ outcome: z.enum(['dead', 'blocked', 'full']) }),
]);

export function createInviteStore(sql: Sql): InviteStore {
  return {
    async resolve(lookup, userId) {
      // A function because the span and the venue order are aggregates over sub_event.
      const params = resolveInviteParams(lookup, userId);
      const rows = await sql`
        select * from public.resolve_invite(
          p_token => ${params.p_token},
          p_shortcode => ${params.p_shortcode},
          p_user_id => ${params.p_user_id}
        )`;
      const [row, ...rest] = z.array(PreviewRow).parse(rows);
      if (rest.length > 0) {
        throw new Error(`resolve_invite returned ${rest.length + 1} rows, expected at most 1`);
      }
      if (row === undefined) {
        return null;
      }
      return {
        role: row.role,
        event: {
          id: row.event_id,
          name: row.name,
          coverKey: row.cover_key,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          venueNames: row.venue_names,
        },
        membership:
          row.member_role === null || row.member_status === null
            ? null
            : { role: row.member_role, status: row.member_status },
      };
    },

    async join(userId, lookup, maxGuests) {
      // One call, one transaction under the event's lock, so two joins never both take the last
      // place (D-95, D-115).
      const params = joinEventParams(userId, lookup, maxGuests);
      const rows = await sql`
        select * from public.join_event(
          p_user_id => ${params.p_user_id},
          p_token => ${params.p_token},
          p_shortcode => ${params.p_shortcode},
          p_max_guests => ${params.p_max_guests}
        )`.catch((error: unknown) => {
        // The caller's account no longer exists, deleted within its token's hour.
        if (isForeignKeyViolation(error, 'membership_user_id_fkey')) {
          return null;
        }
        throw error;
      });
      if (rows === null) {
        return { outcome: 'no_account' };
      }
      const [row, ...rest] = z.array(JoinRow).parse(rows);
      if (row === undefined || rest.length > 0) {
        throw new Error(`join_event returned ${rest.length + (row ? 1 : 0)} rows, expected 1`);
      }
      switch (row.outcome) {
        case 'created':
        case 'rejoined':
        case 'member':
          return { outcome: row.outcome, membership: { role: row.role, status: row.status } };
        case 'dead':
        case 'blocked':
        case 'full':
          return { outcome: row.outcome };
      }
    },

    async cancelJoinRequest(eventId, userId) {
      // The status filter is the race guard. A delete that meets a row an approve is updating
      // waits for it, then checks the filter again against the approved row and deletes nothing
      // (arch:membership). The read after it reports whatever the caller holds now.
      await sql`
        delete from public.membership
        where event_id = ${eventId} and user_id = ${userId} and status = 'pending'`;
      const [left] = await sql`
        select role, status from public.membership where event_id = ${eventId} and user_id = ${userId}`;
      return left === undefined ? null : Membership.parse(left);
    },
  };
}

// POST /invites/resolve. Everyone holding a live invite sees the same preview, signed in or not,
// and that live invite is the check that lets the cover be presigned for them (arch §3, D-115).
// userId adds only the caller's own membership.
export async function resolveInvite(
  store: InviteStore,
  presignGet: PresignGet,
  userId: string | null,
  lookup: InviteLookup,
): Promise<ResolveInviteResponse> {
  const record = await store.resolve(lookup, userId);
  if (record === null) {
    throw new ApiError('not_found', 'No live invite has this token or code');
  }
  const { event } = record;
  return {
    role: record.role,
    event: {
      id: event.id,
      name: event.name,
      cover: event.coverKey === null ? null : await presignCover(event.coverKey, presignGet),
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      venueNames: event.venueNames,
    },
    membership: record.membership,
  };
}

// POST /invites/join. created is true only when this call inserted the caller's row, so a rejoin
// and a repeat answer 200 (hb §5.3).
export async function joinEvent(
  store: InviteStore,
  userId: string,
  lookup: InviteLookup,
): Promise<{ created: boolean; membership: JoinEventResponse['membership'] }> {
  const result = await store.join(userId, lookup, MAX_ACTIVE_GUESTS);
  switch (result.outcome) {
    case 'created':
    case 'rejoined':
    case 'member':
      return { created: result.outcome === 'created', membership: result.membership };
    case 'dead':
      throw new ApiError('not_found', 'No live invite has this token or code');
    case 'blocked':
      // Never not_member: hb §5.3 turns that into Access Removed, and the app shows Join Blocked.
      throw new ApiError('blocked', "The event's Admin blocked this account");
    case 'full':
      throw new ApiError('event_full', `The event has ${MAX_ACTIVE_GUESTS} active Guests`);
    case 'no_account':
      // As POST /events does for an account deleted within the token's hour.
      throw new ApiError('no_session', 'No account for this session');
  }
}

// DELETE /events/{eventId}/join-request. Only ever the caller's own row, and only a pending one.
// There is no 404: an event that does not exist, or one the caller never asked to join, leaves
// them holding nothing there, which is what a cancel answers.
export async function cancelJoinRequest(
  store: InviteStore,
  userId: string,
  eventId: string,
): Promise<CancelJoinRequestResponse> {
  return { membership: await store.cancelJoinRequest(eventId, userId) };
}

const ManagementRefusal = z.enum(['not_found', 'not_member', 'wrong_role']);
const ManagedRow = z
  .object({
    id: ManagedInvite.shape.id,
    role: InviteRole,
    token: ManagedInvite.shape.token,
    shortcode: Shortcode,
  })
  .transform(({ shortcode, ...invite }) => ({ ...invite, code: shortcode }));
const ManagedListRow = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('listed'), invites: z.array(ManagedRow) }),
  z.object({ outcome: ManagementRefusal.or(z.literal('internal_error')) }),
]);
const RegeneratedRow = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('regenerated'), invite: ManagedRow }),
  z.object({ outcome: ManagementRefusal.or(z.enum(['invalid_request', 'invite_changed'])) }),
]);

export type ManagedListResult =
  | { outcome: 'listed'; invites: ManagedInvite[] }
  | { outcome: z.infer<typeof ManagementRefusal> | 'internal_error' };
export type RegeneratedInviteResult = z.infer<typeof RegeneratedRow>;

// Each SQL function checks the event and authenticated actor itself. The read uses one snapshot;
// replacement checks the displayed invite under joining's event lock (D-152).
export interface InviteManagementStore {
  list(eventId: string, actorId: string): Promise<ManagedListResult>;
  regenerate(
    eventId: string,
    actorId: string,
    request: RegenerateInviteRequest,
  ): Promise<RegeneratedInviteResult>;
}

export function createInviteManagementStore(sql: Sql): InviteManagementStore {
  return {
    async list(eventId, actorId) {
      const [row] = await sql`
        select public.list_event_invites(p_event_id => ${eventId}, p_actor_id => ${actorId}) as result`;
      const parsed = ManagedListRow.parse(row?.result);
      if (parsed.outcome !== 'listed') return parsed;
      // Validate both roles before any credentials leave the service. A GET never repairs data.
      return { outcome: 'listed', invites: ListInvitesResponse.parse(parsed).invites };
    },
    async regenerate(eventId, actorId, request) {
      const [row] = await sql`
        select public.regenerate_event_invite(
          p_event_id => ${eventId},
          p_actor_id => ${actorId},
          p_role => ${request.role},
          p_expected_invite_id => ${request.expectedInviteId}
        ) as result`;
      const parsed = RegeneratedRow.parse(row?.result);
      if (parsed.outcome === 'regenerated' && parsed.invite.role !== request.role) {
        throw new Error('regenerate_event_invite returned the wrong role');
      }
      return parsed;
    },
  };
}

export async function listEventInvites(
  store: InviteManagementStore,
  eventId: string,
  actorId: string,
): Promise<ListInvitesResponse> {
  const result = await store.list(eventId, actorId);
  if (result.outcome !== 'listed') throw new ApiError(result.outcome, 'Invite list refused');
  return { invites: result.invites };
}

export async function regenerateEventInvite(
  store: InviteManagementStore,
  eventId: string,
  actorId: string,
  request: RegenerateInviteRequest,
): Promise<RegenerateInviteResponse> {
  const result = await store.regenerate(eventId, actorId, request);
  if (result.outcome !== 'regenerated')
    throw new ApiError(result.outcome, 'Invite replacement refused');
  return { invite: result.invite };
}
