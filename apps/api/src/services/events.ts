import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { EventType, MembershipRole } from '@momentlens/shared-types';
import type {
  CreateCoverUploadResponse,
  CreateEventRequest,
  EventSummary,
  PresignedImage,
  SetEventCoverResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { coverKey } from '../lib/keys';
import type { ObjectExists, PresignGet, PresignPut } from '../lib/r2';
import { ApiError } from '../middleware/errors';

export const MembershipStatus = z.enum(['pending', 'active', 'blocked', 'removed']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

// One event as the caller sees it, before its cover is presigned. Timestamps are already in
// toISOString form.
export interface EventRecord {
  id: string;
  name: string;
  type: EventType;
  role: MembershipRole;
  coverKey: string | null;
  startsAt: string;
  endsAt: string;
  archivedAt: string | null;
}

// What create_event did (supabase/migrations/..._create_event_venue_sub_event_membership.sql).
// no_account is a valid token whose account was deleted since it was issued.
export type CreateEventResult =
  | { outcome: 'created' | 'repeated'; event: EventRecord }
  | { outcome: 'taken' | 'gone' | 'no_account' };

// The caller's membership of one event, and whether the event is soft-deleted.
export interface EventAccess {
  deleted: boolean;
  membership: { role: MembershipRole; status: MembershipStatus } | null;
}

// Every read and write of event, venue, sub_event and membership that S-02 makes. It checks
// nothing about who asks; the functions below do.
export interface EventStore {
  create(userId: string, request: CreateEventRequest): Promise<CreateEventResult>;
  // Every event where the user's membership is active, soft-deleted events left out (D-110).
  listForMember(userId: string): Promise<EventRecord[]>;
  // Null when no event has this id.
  findAccess(eventId: string, userId: string): Promise<EventAccess | null>;
  // False when the event does not exist or is soft-deleted, and then nothing was written.
  setCover(eventId: string, key: string): Promise<boolean>;
}

// Postgres prints a timestamptz with microseconds and +00:00. The contract wants toISOString's
// form, and an unreadable value is a bug to fail on, not one to send.
function toTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unreadable timestamp from Postgres: ${value}`);
  }
  return date.toISOString();
}

// A row of list_my_events, and the summary half of a create_event row. Parsed rather than cast,
// so a renamed column fails here, and every column not named here, qr_secret included, is dropped.
const EventRow = z.object({
  id: z.uuid(),
  name: z.string(),
  type: EventType,
  role: MembershipRole,
  cover_key: z.string().nullable(),
  starts_at: z.string().transform(toTimestamp),
  ends_at: z.string().transform(toTimestamp),
  archived_at: z.string().transform(toTimestamp).nullable(),
});

function toRecord(row: z.infer<typeof EventRow>): EventRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    role: row.role,
    coverKey: row.cover_key,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    archivedAt: row.archived_at,
  };
}

const CreateEventRow = z.discriminatedUnion('outcome', [
  EventRow.extend({ outcome: z.enum(['created', 'repeated']) }),
  z.object({ outcome: z.enum(['taken', 'gone']) }),
]);

const AccessRows = {
  event: z.object({ deleted_at: z.string().nullable() }),
  membership: z.object({ role: MembershipRole, status: MembershipStatus }),
};

// create_event's arguments for a parsed request. Exported so the dev-project test can call the
// function with a request the contract would refuse, and see the database refuse it too.
export function createEventParams(userId: string, request: CreateEventRequest) {
  return {
    p_user_id: userId,
    p_request_id: request.requestId,
    p_name: request.name,
    p_type: request.type,
    p_description: request.description ?? null,
    p_verification_radius_m: request.verificationRadiusM,
    p_venues: request.venues.map((venue) => ({
      name: venue.name,
      lat: venue.lat,
      lng: venue.lng,
    })),
    p_sub_events: request.subEvents.map((subEvent) => ({
      name: subEvent.name,
      description: subEvent.description ?? null,
      starts_at: subEvent.startsAt,
      ends_at: subEvent.endsAt,
      venue_index: subEvent.venueIndex,
    })),
  };
}

// Postgres foreign_key_violation on membership.user_id: the caller's account no longer exists.
function isMissingAccount(error: { code?: string; message?: string }): boolean {
  return error.code === '23503' && (error.message ?? '').includes('membership_user_id_fkey');
}

export function createEventStore(supabase: Supabase): EventStore {
  return {
    async create(userId, request) {
      // One rpc, one transaction: the event, its venues, its sub-events and the Admin's row
      // commit together or not at all (D-95, D-110).
      // Without generated database types, rpc types its data as any, so it is parsed as unknown.
      const result = await supabase.rpc('create_event', createEventParams(userId, request));
      if (result.error) {
        if (isMissingAccount(result.error)) {
          return { outcome: 'no_account' };
        }
        throw result.error;
      }
      const [row, ...rest] = z.array(CreateEventRow).parse(result.data as unknown);
      if (row === undefined || rest.length > 0) {
        throw new Error(`create_event returned ${rest.length + (row ? 1 : 0)} rows, expected 1`);
      }
      switch (row.outcome) {
        case 'created':
        case 'repeated':
          return { outcome: row.outcome, event: toRecord(row) };
        case 'taken':
        case 'gone':
          return { outcome: row.outcome };
      }
    },

    async listForMember(userId) {
      // An rpc because the span is an aggregate over sub_event, which PostgREST does not compute.
      const result = await supabase.rpc('list_my_events', { p_user_id: userId });
      if (result.error) {
        throw result.error;
      }
      return z
        .array(EventRow)
        .parse(result.data as unknown)
        .map(toRecord);
    },

    async findAccess(eventId, userId) {
      // Two indexed reads, by primary key and by the (event_id, user_id) unique key.
      const [event, membership] = await Promise.all([
        supabase.from('event').select('deleted_at').eq('id', eventId).maybeSingle(),
        supabase
          .from('membership')
          .select('role, status')
          .eq('event_id', eventId)
          .eq('user_id', userId)
          .maybeSingle(),
      ]);
      if (event.error) {
        throw event.error;
      }
      if (membership.error) {
        throw membership.error;
      }
      if (event.data === null) {
        return null;
      }
      return {
        deleted: AccessRows.event.parse(event.data).deleted_at !== null,
        membership: membership.data === null ? null : AccessRows.membership.parse(membership.data),
      };
    },

    async setCover(eventId, key) {
      // The deleted_at filter makes the write refuse an event deleted since findAccess read it.
      const { data, error } = await supabase
        .from('event')
        .update({ cover_key: key })
        .eq('id', eventId)
        .is('deleted_at', null)
        .select('id');
      if (error) {
        throw error;
      }
      return z.array(z.object({ id: z.uuid() })).parse(data).length === 1;
    },
  };
}

// The one function that presigns an event cover. Call it only for a viewer the endpoint has
// already checked is an active member of the event (arch §1, arch §3).
//
// The cover never passes through the worker, so a Do Not Publish guest in it is unblurred; spec
// §6.2 defers that (D-110). The cache key is the object key, which is new for every cover.
export async function presignCover(key: string, presignGet: PresignGet): Promise<PresignedImage> {
  return { url: await presignGet(key), cacheKey: key };
}

async function toSummary(record: EventRecord, presignGet: PresignGet): Promise<EventSummary> {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    role: record.role,
    cover: record.coverKey === null ? null : await presignCover(record.coverKey, presignGet),
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    archivedAt: record.archivedAt,
  };
}

// POST /events. Anyone signed in may create an event and becomes its Admin (spec §2.5.1, D-102).
export async function createEvent(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
  request: CreateEventRequest,
): Promise<{ created: boolean; event: EventSummary }> {
  const result = await store.create(userId, request);
  switch (result.outcome) {
    case 'created':
    case 'repeated':
      return {
        created: result.outcome === 'created',
        event: await toSummary(result.event, presignGet),
      };
    case 'taken':
      // Another account's event holds this requestId. Saying nothing about it keeps that event
      // hidden; an honest app never reuses a requestId it did not make (D-110).
      throw new ApiError('duplicate', 'This requestId belongs to another account');
    case 'gone':
      throw new ApiError('not_found', 'The event this requestId created has been deleted');
    case 'no_account':
      // As GET /profiles/me does for an account deleted within the token's hour.
      throw new ApiError('no_session', 'No account for this session');
  }
}

// GET /events. The store returns only the caller's active memberships, so every cover here is one
// the caller may see.
export async function listEvents(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
): Promise<EventSummary[]> {
  const records = await store.listForMember(userId);
  return Promise.all(records.map((record) => toSummary(record, presignGet)));
}

// The check both cover endpoints make before anything else: the event exists and is not deleted,
// the caller is an active member of it, and that member is its Admin (hb §5.3). A 403 on an event
// is how the app learns its user was removed or blocked.
async function requireAdmin(store: EventStore, eventId: string, userId: string): Promise<void> {
  const access = await store.findAccess(eventId, userId);
  if (access === null || access.deleted) {
    throw new ApiError('not_found', 'No such event');
  }
  if (access.membership?.status !== 'active') {
    throw new ApiError('not_member', 'Not an active member of this event');
  }
  if (access.membership.role !== 'admin') {
    throw new ApiError('wrong_role', "Only the event's Admin sets its cover");
  }
}

// POST /events/{eventId}/cover-upload. A presigned PUT for a new cover key. Nothing is written:
// the cover changes only when PUT /events/{eventId}/cover finds the object.
export async function startCoverUpload(
  store: EventStore,
  presignPut: PresignPut,
  userId: string,
  eventId: string,
): Promise<CreateCoverUploadResponse> {
  await requireAdmin(store, eventId, userId);
  const uploadId = randomUUID();
  return {
    uploadId,
    uploadUrl: await presignPut(coverKey(eventId, uploadId), 'image/jpeg'),
  };
}

// PUT /events/{eventId}/cover. The key comes from the path's event and the uploadId, never from
// the body, so an uploadId presigned for another event names an object that is not there
// (root invariant 12). The HEAD runs after the Admin check, so nobody else learns what exists.
export async function setEventCover(
  store: EventStore,
  objectExists: ObjectExists,
  presignGet: PresignGet,
  userId: string,
  eventId: string,
  uploadId: string,
): Promise<SetEventCoverResponse> {
  await requireAdmin(store, eventId, userId);
  const key = coverKey(eventId, uploadId);
  if (!(await objectExists(key))) {
    throw new ApiError('upload_missing', 'No cover has been uploaded for this uploadId');
  }
  if (!(await store.setCover(eventId, key))) {
    throw new ApiError('not_found', 'No such event');
  }
  return { cover: await presignCover(key, presignGet) };
}
