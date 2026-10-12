import { z } from 'zod';

import {
  FullName,
  InviteRole,
  MembershipRole,
  MembershipStatus,
  VerificationState,
} from '@momentlens/shared-types';
import type {
  AttendeeMembership,
  ForceVerifyAttendeeResponse,
  ListAttendeesRequest,
  ListAttendeesResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { ApiError } from '../middleware/errors';
import { MAX_ACTIVE_GUESTS, requireAdmin, toTimestamp } from './events';
import type { EventStore } from './events';

// Keep the bigint counter as text, so versions beyond Number.MAX_SAFE_INTEGER still compare.
const Counter = z
  .string()
  .max(19)
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const Version = z.strictObject({ id: z.uuid(), version: Counter });
export type Version = z.infer<typeof Version>;
const Cursor = z.strictObject({
  eventId: z.uuid(),
  search: z.string(),
  role: MembershipRole.nullable(),
  subEventId: z.uuid().nullable(),
  checkIn: z.enum(['checked_in', 'not_checked_in']).nullable(),
  name: FullName,
  userId: z.uuid(),
});
type Cursor = z.infer<typeof Cursor>;

// The opaque tokens the app hands back unchanged: access versions here, and the cursors of
// Attendees and Pending Approvals (D-143, D-144).
export function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decode<T>(schema: z.ZodType<T>, token: string): T {
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('Noncanonical token');
    return schema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    throw new ApiError('invalid_request', 'Invalid token');
  }
}

export function accessVersion(id: string, version: string): string {
  return encode(Version.parse({ id, version }));
}

export interface AttendeeRecord {
  id: string;
  userId: string;
  fullName: string;
  role: MembershipRole;
  requestedAt: string;
  version: string;
  verification: VerificationState;
}
export interface AttendeePage {
  search: string;
  role: MembershipRole | null;
  subEventId: string | null;
  checkIn: NonNullable<ListAttendeesRequest['checkIn']> | null;
  after: { name: string; userId: string } | null;
}
export type AttendeeAction = 'role' | 'remove' | 'block';
const Refusal = z.enum([
  'not_found',
  'not_member',
  'wrong_role',
  'invalid_request',
  'membership_changed',
  'event_full',
]);
type Refusal = z.infer<typeof Refusal>;
export type ListResult = { outcome: 'listed'; rows: AttendeeRecord[] } | { outcome: Refusal };
export type MutationResult =
  { outcome: 'updated'; membership: AttendeeMembership } | { outcome: Refusal };
export type ForceVerifyResult =
  ({ outcome: 'verified' } & ForceVerifyAttendeeResponse) | { outcome: Refusal };
export interface AttendeeStore {
  list(eventId: string, actorId: string, page: AttendeePage): Promise<ListResult>;
  mutate(
    eventId: string,
    actorId: string,
    userId: string,
    action: AttendeeAction,
    expected: Version,
    role: InviteRole | null,
    maxGuests: number,
  ): Promise<MutationResult>;
  forceVerify(
    eventId: string,
    actorId: string,
    userId: string,
    expected: Version,
  ): Promise<ForceVerifyResult>;
}

const MemberRow = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  role: MembershipRole,
  status: MembershipStatus,
  access_version: Counter,
});
const AttendeeRow = MemberRow.omit({ status: true }).extend({
  full_name: FullName,
  requested_at: z.string().transform(toTimestamp),
  every_sub_event: z.boolean(),
  verified_sub_event_ids: VerificationState.shape.subEventIds,
});
const ListRow = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('listed'), attendees: z.array(AttendeeRow).max(51) }),
  z.object({ outcome: Refusal }),
]);
const MutationRow = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('updated'), membership: MemberRow }),
  z.object({ outcome: Refusal }),
]);
const ForceVerifyRow = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('verified'),
    membership: MemberRow.extend({ role: InviteRole, status: z.literal('active') }),
    admin_verified_at: z.string().transform(toTimestamp),
  }),
  z.object({ outcome: Refusal }),
]);

export function attendeeMutationParams(
  eventId: string,
  actorId: string,
  userId: string,
  expected: Version,
) {
  return {
    p_event_id: eventId,
    p_actor_id: actorId,
    p_user_id: userId,
    p_expected_id: expected.id,
    p_expected_version: expected.version,
  };
}

export function createAttendeeStore(supabase: Supabase): AttendeeStore {
  return {
    async list(eventId, actorId, page) {
      const result = await supabase.rpc('list_attendees', {
        p_event_id: eventId,
        p_actor_id: actorId,
        p_search: page.search,
        p_role: page.role,
        p_after_name: page.after?.name ?? null,
        p_after_user_id: page.after?.userId ?? null,
        p_sub_event_id: page.subEventId,
        p_check_in: page.checkIn,
      });
      if (result.error) throw result.error;
      const row = ListRow.parse(result.data as unknown);
      if (row.outcome !== 'listed') return row;
      return {
        outcome: 'listed',
        rows: row.attendees.map((member) => ({
          id: member.id,
          userId: member.user_id,
          fullName: member.full_name,
          role: member.role,
          requestedAt: member.requested_at,
          version: member.access_version,
          verification: {
            everySubEvent: member.every_sub_event,
            subEventIds: member.verified_sub_event_ids,
          },
        })),
      };
    },
    async mutate(eventId, actorId, userId, action, expected, role, maxGuests) {
      const params = attendeeMutationParams(eventId, actorId, userId, expected);
      const result = await supabase.rpc(
        action === 'role' ? 'change_attendee_role' : `${action}_attendee`,
        action === 'role' ? { ...params, p_role: role, p_max_guests: maxGuests } : params,
      );
      if (result.error) throw result.error;
      const row = MutationRow.parse(result.data as unknown);
      if (row.outcome !== 'updated') return row;
      const member = row.membership;
      return {
        outcome: 'updated',
        membership: {
          userId: member.user_id,
          role: member.role,
          status: member.status,
          accessVersion: accessVersion(member.id, member.access_version),
        },
      };
    },
    async forceVerify(eventId, actorId, userId, expected) {
      const result = await supabase.rpc(
        'force_verify_attendee',
        attendeeMutationParams(eventId, actorId, userId, expected),
      );
      if (result.error) throw result.error;
      const row = ForceVerifyRow.parse(result.data as unknown);
      if (row.outcome !== 'verified') return row;
      return {
        outcome: 'verified',
        membership: {
          userId: row.membership.user_id,
          role: row.membership.role,
          status: row.membership.status,
          accessVersion: accessVersion(row.membership.id, row.membership.access_version),
        },
        adminVerifiedAt: row.admin_verified_at,
      };
    },
  };
}

export async function listAttendees(
  events: EventStore,
  store: AttendeeStore,
  eventId: string,
  actorId: string,
  request: ListAttendeesRequest,
): Promise<ListAttendeesResponse> {
  const search = request.search ?? '';
  const role = request.role ?? null;
  const subEventId = request.subEventId ?? null;
  const checkIn = request.checkIn ?? null;
  const cursor = request.cursor === undefined ? null : decode(Cursor, request.cursor);
  if (
    cursor !== null &&
    (cursor.eventId !== eventId ||
      cursor.search !== search ||
      cursor.role !== role ||
      cursor.subEventId !== subEventId ||
      cursor.checkIn !== checkIn)
  )
    throw new ApiError('invalid_request', 'Cursor does not match this attendee query');
  await requireAdmin(events, eventId, actorId, "Only the event's Admin manages attendees");
  const result = await store.list(eventId, actorId, {
    search,
    role,
    subEventId,
    checkIn,
    after: cursor === null ? null : { name: cursor.name, userId: cursor.userId },
  });
  if (result.outcome !== 'listed') throw new ApiError(result.outcome, 'Attendee list refused');
  const shown = result.rows.slice(0, 50);
  const last = shown.at(-1);
  return {
    attendees: shown.map((row) => ({
      userId: row.userId,
      fullName: row.fullName,
      role: row.role,
      requestedAt: row.requestedAt,
      accessVersion: accessVersion(row.id, row.version),
      avatar: null,
      verification: row.verification,
    })),
    nextCursor:
      result.rows.length > 50 && last !== undefined
        ? encode({
            eventId,
            search,
            role,
            subEventId,
            checkIn,
            name: last.fullName,
            userId: last.userId,
          })
        : null,
  };
}

export async function forceVerifyAttendee(
  events: EventStore,
  store: AttendeeStore,
  eventId: string,
  actorId: string,
  userId: string,
  token: string,
): Promise<ForceVerifyAttendeeResponse> {
  const expected = decode(Version, token);
  await requireAdmin(events, eventId, actorId, "Only the event's Admin manages attendees");
  const result = await store.forceVerify(eventId, actorId, userId, expected);
  if (result.outcome !== 'verified') throw new ApiError(result.outcome, 'Manual check-in refused');
  return { membership: result.membership, adminVerifiedAt: result.adminVerifiedAt };
}

export async function mutateAttendee(
  events: EventStore,
  store: AttendeeStore,
  eventId: string,
  actorId: string,
  userId: string,
  action: AttendeeAction,
  token: string,
  role: InviteRole | null = null,
): Promise<{ membership: AttendeeMembership }> {
  const expected = decode(Version, token);
  await requireAdmin(events, eventId, actorId, "Only the event's Admin manages attendees");
  const result = await store.mutate(
    eventId,
    actorId,
    userId,
    action,
    expected,
    role,
    MAX_ACTIVE_GUESTS,
  );
  if (result.outcome !== 'updated') throw new ApiError(result.outcome, 'Attendee action refused');
  return { membership: result.membership };
}
