import { z } from 'zod';

import { FullName, InviteRole, MembershipRole, MembershipStatus } from '@momentlens/shared-types';
import type {
  AttendeeMembership,
  ListPendingRequestsRequest,
  ListPendingRequestsResponse,
  PendingRequestTarget,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { ApiError } from '../middleware/errors';
import { accessVersion, decode, encode, Version } from './attendees';
import { MAX_ACTIVE_GUESTS, requireAdmin, toTimestamp } from './events';
import type { EventStore } from './events';

// requested_at as list_pending_requests prints it: UTC, to the microsecond Postgres keeps. The
// cursor carries it unchanged, because a millisecond cursor would skip a request made later in the
// same millisecond. The round trip refuses a date that does not exist, such as 30 February, which
// Date would roll into March, so a tampered cursor is a 400 and never reaches Postgres.
const RequestTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => {
    const date = new Date(`${value.slice(0, 23)}Z`);
    return date.getTime() >= 0 && date.toISOString().slice(0, 23) === value.slice(0, 23);
  });
const Cursor = z.strictObject({ eventId: z.uuid(), requestedAt: RequestTime, userId: z.uuid() });

// One pending membership as list_pending_requests reads it, before its version is encoded.
export interface PendingRecord {
  id: string;
  userId: string;
  fullName: string;
  role: InviteRole;
  requestedAt: string;
  version: string;
}
export type JoinRequestAction = 'approve' | 'reject' | 'block';
// One person an action names, with the row id and counter their token held.
export interface RequestTarget {
  userId: string;
  expected: Version;
}
const Refusal = z.enum([
  'not_found',
  'not_member',
  'wrong_role',
  'invalid_request',
  'membership_changed',
  'event_full',
]);
type Refusal = z.infer<typeof Refusal>;
export type PendingListResult =
  { outcome: 'listed'; rows: PendingRecord[]; activeGuests: number } | { outcome: Refusal };
export type RequestActionResult =
  { outcome: 'updated'; memberships: AttendeeMembership[] } | { outcome: Refusal };

// The four Pending Approvals functions (supabase/migrations/..._pending_approvals.sql). Each takes
// the actor and rechecks them, the event and every target under the event's lock (D-144).
export interface JoinRequestStore {
  list(
    eventId: string,
    actorId: string,
    after: { requestedAt: string; userId: string } | null,
  ): Promise<PendingListResult>;
  // maxGuests applies to an approve only.
  act(
    eventId: string,
    actorId: string,
    action: JoinRequestAction,
    targets: RequestTarget[],
    maxGuests: number,
  ): Promise<RequestActionResult>;
}

const PendingRow = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  full_name: FullName,
  role: InviteRole,
  requested_at: RequestTime,
  access_version: z.string(),
});
const ListRow = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('listed'),
    requests: z.array(PendingRow).max(51),
    active_guests: z.int().min(0),
  }),
  z.object({ outcome: Refusal }),
]);
const MemberRow = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  role: MembershipRole,
  status: MembershipStatus,
  access_version: z.string(),
});
const ActionRow = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('updated'), memberships: z.array(MemberRow).min(1).max(50) }),
  z.object({ outcome: Refusal }),
]);

// p_targets for approve_requests and reject_requests. The counter stays text, so a version past
// Number.MAX_SAFE_INTEGER reaches Postgres unchanged.
export function requestTargetsParam(targets: RequestTarget[]) {
  return targets.map((target) => ({
    user_id: target.userId,
    id: target.expected.id,
    version: target.expected.version,
  }));
}

export function createJoinRequestStore(supabase: Supabase): JoinRequestStore {
  return {
    async list(eventId, actorId, after) {
      const result = await supabase.rpc('list_pending_requests', {
        p_event_id: eventId,
        p_actor_id: actorId,
        p_after_requested_at: after?.requestedAt ?? null,
        p_after_user_id: after?.userId ?? null,
      });
      if (result.error) throw result.error;
      const row = ListRow.parse(result.data as unknown);
      if (row.outcome !== 'listed') return row;
      return {
        outcome: 'listed',
        activeGuests: row.active_guests,
        rows: row.requests.map((request) => ({
          id: request.id,
          userId: request.user_id,
          fullName: request.full_name,
          role: request.role,
          requestedAt: request.requested_at,
          version: request.access_version,
        })),
      };
    },
    async act(eventId, actorId, action, targets, maxGuests) {
      const actor = { p_event_id: eventId, p_actor_id: actorId };
      let result;
      if (action === 'block') {
        const [target, ...rest] = targets;
        if (target === undefined || rest.length > 0) {
          throw new Error(`block_request takes one target, got ${targets.length}`);
        }
        result = await supabase.rpc('block_request', {
          ...actor,
          p_user_id: target.userId,
          p_expected_id: target.expected.id,
          p_expected_version: target.expected.version,
        });
      } else if (action === 'approve') {
        result = await supabase.rpc('approve_requests', {
          ...actor,
          p_targets: requestTargetsParam(targets),
          p_max_guests: maxGuests,
        });
      } else {
        result = await supabase.rpc('reject_requests', {
          ...actor,
          p_targets: requestTargetsParam(targets),
        });
      }
      if (result.error) throw result.error;
      const row = ActionRow.parse(result.data as unknown);
      if (row.outcome !== 'updated') return row;
      return {
        outcome: 'updated',
        memberships: row.memberships.map((member) => ({
          userId: member.user_id,
          role: member.role,
          status: member.status,
          accessVersion: accessVersion(member.id, member.access_version),
        })),
      };
    },
  };
}

const REFUSAL = "Only the event's Admin manages join requests";

// GET /events/{eventId}/join-requests (D-144). The avatar stays null and no avatar key is read
// until S-29, as on Attendees (D-143).
export async function listPendingRequests(
  events: EventStore,
  store: JoinRequestStore,
  eventId: string,
  actorId: string,
  request: ListPendingRequestsRequest,
): Promise<ListPendingRequestsResponse> {
  const cursor = request.cursor === undefined ? null : decode(Cursor, request.cursor);
  if (cursor !== null && cursor.eventId !== eventId)
    throw new ApiError('invalid_request', 'Cursor is from another event');
  await requireAdmin(events, eventId, actorId, REFUSAL);
  const result = await store.list(
    eventId,
    actorId,
    cursor === null ? null : { requestedAt: cursor.requestedAt, userId: cursor.userId },
  );
  if (result.outcome !== 'listed') throw new ApiError(result.outcome, 'Join request list refused');
  const shown = result.rows.slice(0, 50);
  const last = shown.at(-1);
  return {
    requests: shown.map((row) => ({
      userId: row.userId,
      fullName: row.fullName,
      role: row.role,
      requestedAt: toTimestamp(row.requestedAt),
      accessVersion: accessVersion(row.id, row.version),
      avatar: null,
    })),
    nextCursor:
      result.rows.length > 50 && last !== undefined
        ? encode({ eventId, requestedAt: last.requestedAt, userId: last.userId })
        : null,
    guestPlacesLeft: Math.max(0, MAX_ACTIVE_GUESTS - result.activeGuests),
  };
}

async function act(
  events: EventStore,
  store: JoinRequestStore,
  eventId: string,
  actorId: string,
  action: JoinRequestAction,
  targets: PendingRequestTarget[],
): Promise<AttendeeMembership[]> {
  // Lower case, as Postgres prints a uuid, so the response names each person as the list did.
  const decoded = targets.map((target) => ({
    userId: target.userId.toLowerCase(),
    expected: decode(Version, target.expectedVersion),
  }));
  await requireAdmin(events, eventId, actorId, REFUSAL);
  const result = await store.act(eventId, actorId, action, decoded, MAX_ACTIVE_GUESTS);
  if (result.outcome !== 'updated')
    throw new ApiError(result.outcome, 'Join request action refused');
  return result.memberships;
}

// POST /events/{eventId}/join-requests/approve and /reject. One call, all or nothing (D-144).
export async function actOnRequests(
  events: EventStore,
  store: JoinRequestStore,
  eventId: string,
  actorId: string,
  action: 'approve' | 'reject',
  targets: PendingRequestTarget[],
): Promise<{ memberships: AttendeeMembership[] }> {
  return { memberships: await act(events, store, eventId, actorId, action, targets) };
}

// POST /events/{eventId}/join-requests/{userId}/block. One target, named by the path (D-144).
export async function blockRequest(
  events: EventStore,
  store: JoinRequestStore,
  eventId: string,
  actorId: string,
  userId: string,
  token: string,
): Promise<{ membership: AttendeeMembership }> {
  const [membership, ...rest] = await act(events, store, eventId, actorId, 'block', [
    { userId, expectedVersion: token },
  ]);
  if (membership === undefined || rest.length > 0) {
    throw new Error(`block_request returned ${rest.length + (membership ? 1 : 0)} memberships`);
  }
  return { membership };
}
