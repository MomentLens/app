import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  ApprovalMode,
  EventType,
  InviteRole,
  MembershipRole,
  MembershipStatus,
} from '@momentlens/shared-types';
import type {
  CreateCoverUploadResponse,
  CreateEventRequest,
  EventSettings,
  EventSummary,
  GetEventResponse,
  GetEventSettingsResponse,
  JoinRequest,
  ListEventsResponse,
  PresignedImage,
  SetEventCoverResponse,
  UpdateEventSettingsRequest,
  UpdateEventSettingsResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { coverKey } from '../lib/keys';
import type { ObjectExists, PresignGet, PresignPut } from '../lib/r2';
import { ApiError } from '../middleware/errors';

// At most 150 active Guests in one event. The Admin and Photographers do not count (spec §4.17,
// D-102). join_event and update_event_settings enforce it under the event's lock, with this number.
export const MAX_ACTIVE_GUESTS = 150;

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

// What findAccess reads: the access, and whether the album is open, which pre-flight checks (D-122).
export interface MemberAccess extends EventAccess {
  albumOpen: boolean;
}

// One event read for one caller by get_my_event. `event` is null unless the caller's membership is
// active and the event is not deleted, so the store never returns an event the caller may not see.
export interface CallerEvent extends EventAccess {
  event: EventRecord | null;
}

// The Event Settings form as event_settings reads it, before its cover is presigned (D-142).
export interface SettingsRecord {
  name: string;
  description: string | null;
  approvalMode: ApprovalMode;
  coverKey: string | null;
  pendingCount: number;
  pendingPhotographers: string[];
}

// What update_event_settings did (supabase/migrations/..._update_event_settings.sql). not_found is
// an event soft-deleted after the service's check, and then nothing was written.
export type UpdateSettingsResult =
  { outcome: 'updated'; admitted: number; settings: SettingsRecord } | { outcome: 'not_found' };

// Every read and write of event, venue, sub_event and membership that S-02 makes, S-03's list of
// join requests, and S-07a's settings. It checks nothing about who asks; the functions below do.
export interface EventStore {
  create(userId: string, request: CreateEventRequest): Promise<CreateEventResult>;
  // Every event where the user's membership is active, soft-deleted events left out (D-110).
  listForMember(userId: string): Promise<EventRecord[]>;
  // Every one of the user's own pending memberships, soft-deleted events left out (D-115).
  listJoinRequests(userId: string): Promise<JoinRequest[]>;
  // Null when no event has this id.
  findForCaller(eventId: string, userId: string): Promise<CallerEvent | null>;
  // Null when no event has this id.
  findAccess(eventId: string, userId: string): Promise<MemberAccess | null>;
  // False when the event does not exist or is soft-deleted, and then nothing was written.
  setCover(eventId: string, key: string): Promise<boolean>;
  // Null when the event does not exist or is soft-deleted.
  settings(eventId: string): Promise<SettingsRecord | null>;
  // One update_event_settings call. A switch to auto admits Guests until maxGuests are active.
  updateSettings(
    eventId: string,
    request: UpdateEventSettingsRequest,
    maxGuests: number,
  ): Promise<UpdateSettingsResult>;
}

// Postgres prints a timestamptz with microseconds and +00:00. The contract wants toISOString's
// form, and an unreadable value is a bug to fail on, not one to send.
export function toTimestamp(value: string): string {
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

// A pending membership with its event, from the embedded select in listJoinRequests. The event's
// deleted_at is read back to prove the inner join's filter held.
const JoinRequestRow = z.object({
  role: InviteRole,
  requested_at: z.string().transform(toTimestamp),
  event: z.object({ id: z.uuid(), name: z.string(), deleted_at: z.null() }),
});

// The access half of a get_my_event row. role and status are null together, when the caller has
// no membership.
const CallerRow = z.object({
  deleted: z.boolean(),
  role: MembershipRole.nullable(),
  status: MembershipStatus.nullable(),
});

// event_settings' object. Parsed rather than cast, so a renamed key fails here. So does a null in
// pending_photographers, a Photographer with no profile, rather than drop them from the confirm.
const SettingsRow = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    approval_mode: ApprovalMode,
    cover_key: z.string().nullable(),
    pending_count: z.int().min(0),
    pending_photographers: z.array(z.string()),
  })
  .transform((row): SettingsRecord => ({
    name: row.name,
    description: row.description,
    approvalMode: row.approval_mode,
    coverKey: row.cover_key,
    pendingCount: row.pending_count,
    pendingPhotographers: row.pending_photographers,
  }));

// update_event_settings' one row. An outcome not named here fails the parse.
const UpdateSettingsRow = z.union([
  z.object({ outcome: z.literal('updated'), admitted: z.int().min(0), settings: SettingsRow }),
  z
    .object({ outcome: z.literal('not_found'), admitted: z.literal(0), settings: z.null() })
    .transform(() => ({ outcome: 'not_found' as const })),
]);

const AccessRows = {
  event: z.object({ deleted_at: z.string().nullable(), album_open: z.boolean() }),
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
    p_approval_mode: request.approvalMode,
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
      verification_radius_m: subEvent.verificationRadiusM,
    })),
  };
}

// update_event_settings' arguments for a parsed request. A field the request leaves out is null,
// which the function leaves as it is. An empty description is sent as it is, and the function
// clears the description for it. Exported so the dev-project test can call the function directly.
export function updateEventSettingsParams(
  eventId: string,
  request: UpdateEventSettingsRequest,
  maxGuests: number,
) {
  return {
    p_event_id: eventId,
    p_name: request.name ?? null,
    p_description: request.description ?? null,
    p_approval_mode: request.approvalMode ?? null,
    p_max_guests: maxGuests,
  };
}

// Postgres foreign_key_violation on membership.user_id: the caller's account no longer exists.
export function isMissingAccount(error: { code?: string; message?: string }): boolean {
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

    async findForCaller(eventId, userId) {
      // An rpc for the span, as in listForMember, and so the access and the event come from one
      // snapshot: a membership changed between two reads cannot pair one answer with the other.
      const result = await supabase.rpc('get_my_event', {
        p_event_id: eventId,
        p_user_id: userId,
      });
      if (result.error) {
        throw result.error;
      }
      const rows = z.array(z.unknown()).parse(result.data as unknown);
      if (rows.length > 1) {
        throw new Error(`get_my_event returned ${rows.length} rows, expected at most 1`);
      }
      const [row] = rows;
      if (row === undefined) {
        return null;
      }
      const access = CallerRow.parse(row);
      const membership =
        access.role === null || access.status === null
          ? null
          : { role: access.role, status: access.status };
      // EventRow refuses the null columns get_my_event sends anyone else, so a function that
      // stopped nulling them for an active member would fail here rather than send a blank event.
      const shown = !access.deleted && membership?.status === 'active';
      return {
        deleted: access.deleted,
        membership,
        event: shown ? toRecord(EventRow.parse(row)) : null,
      };
    },

    async listJoinRequests(userId) {
      // The (user_id, status) index finds the rows. The inner join drops a row whose event is
      // soft-deleted, where a plain embed would return it with a null event.
      const result = await supabase
        .from('membership')
        .select('role, requested_at, event!inner(id, name, deleted_at)')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .is('event.deleted_at', null);
      if (result.error) {
        throw result.error;
      }
      return z
        .array(JoinRequestRow)
        .parse(result.data as unknown)
        .map((row) => ({
          eventId: row.event.id,
          eventName: row.event.name,
          role: row.role,
          requestedAt: row.requested_at,
        }));
    },

    async findAccess(eventId, userId) {
      // Two indexed reads, by primary key and by the (event_id, user_id) unique key.
      const [event, membership] = await Promise.all([
        supabase.from('event').select('deleted_at, album_open').eq('id', eventId).maybeSingle(),
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
      const row = AccessRows.event.parse(event.data);
      return {
        deleted: row.deleted_at !== null,
        albumOpen: row.album_open,
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

    async settings(eventId) {
      // An rpc so the pending count and the names come from one snapshot, and so GET and the
      // write read the settings in one place.
      const result = await supabase.rpc('event_settings', { p_event_id: eventId });
      if (result.error) {
        throw result.error;
      }
      return SettingsRow.nullable().parse(result.data as unknown);
    },

    async updateSettings(eventId, request, maxGuests) {
      // One rpc, one transaction, under the event's lock: the fields, the switch and every
      // request it admits commit together or not at all (D-95, D-142).
      const result = await supabase.rpc(
        'update_event_settings',
        updateEventSettingsParams(eventId, request, maxGuests),
      );
      if (result.error) {
        throw result.error;
      }
      const [row, ...rest] = z.array(UpdateSettingsRow).parse(result.data as unknown);
      if (row === undefined || rest.length > 0) {
        throw new Error(
          `update_event_settings returned ${rest.length + (row ? 1 : 0)} rows, expected 1`,
        );
      }
      return row;
    },
  };
}

// The one function that presigns an event cover. Call it only for a viewer the endpoint has
// already checked is an active member of the event, or holds one of its live invites (arch §1,
// arch §3, D-115).
//
// The cover never passes through the worker, so a Do Not Publish guest in it is unblurred, and
// through an invite that reaches people who are not members yet; spec §6.2 defers that (D-110,
// D-115). The cache key is the object key, which is new for every cover.
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
// the caller may see. The join requests carry no cover, and are the caller's own pending rows only.
export async function listEvents(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
): Promise<ListEventsResponse> {
  const [records, joinRequests] = await Promise.all([
    store.listForMember(userId),
    store.listJoinRequests(userId),
  ]);
  return {
    events: await Promise.all(records.map((record) => toSummary(record, presignGet))),
    joinRequests,
  };
}

// GET /events/{eventId}, the Event shell's one read of the caller's role (D-118). The checks run
// before the cover is presigned, so a refused caller gets no URL (root invariant 3). A deleted event
// is 404 to everyone, its Admin included. Any caller who is not active, pending included, is 403
// not_member; the app finds a pending caller's request in GET /events (hb §5.3).
export async function getEvent(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
  eventId: string,
): Promise<GetEventResponse> {
  const found = await store.findForCaller(eventId, userId);
  if (found === null || found.deleted) {
    throw new ApiError('not_found', 'No such event');
  }
  if (found.membership?.status !== 'active') {
    throw new ApiError('not_member', 'Not an active member of this event');
  }
  if (found.event === null) {
    throw new Error('The event store found an active member of a live event but no event');
  }
  return { event: await toSummary(found.event, presignGet) };
}

// The check an endpoint on one event makes before anything else: the event exists and is not
// deleted, and the caller is an active member of it (hb §5.3). A 403 on an event is how the app
// learns its user was removed or blocked. Returns the caller's role, and whether the album is open
// for pre-flight, which checks it after this (D-122).
export async function requireActiveMember(
  store: EventStore,
  eventId: string,
  userId: string,
): Promise<{ role: MembershipRole; albumOpen: boolean }> {
  const access = await store.findAccess(eventId, userId);
  if (access === null || access.deleted) {
    throw new ApiError('not_found', 'No such event');
  }
  if (access.membership?.status !== 'active') {
    throw new ApiError('not_member', 'Not an active member of this event');
  }
  return { role: access.membership.role, albumOpen: access.albumOpen };
}

// requireActiveMember, for an endpoint that needs only the caller's role.
export async function requireMember(
  store: EventStore,
  eventId: string,
  userId: string,
): Promise<MembershipRole> {
  return (await requireActiveMember(store, eventId, userId)).role;
}

// requireMember, and then that member is the event's Admin. `refusal` is the 403 wrong_role
// message, for logs.
export async function requireAdmin(
  store: EventStore,
  eventId: string,
  userId: string,
  refusal: string,
): Promise<void> {
  if ((await requireMember(store, eventId, userId)) !== 'admin') {
    throw new ApiError('wrong_role', refusal);
  }
}

const COVER_REFUSAL = "Only the event's Admin sets its cover";

// POST /events/{eventId}/cover-upload. A presigned PUT for a new cover key. Nothing is written:
// the cover changes only when PUT /events/{eventId}/cover finds the object.
export async function startCoverUpload(
  store: EventStore,
  presignPut: PresignPut,
  userId: string,
  eventId: string,
): Promise<CreateCoverUploadResponse> {
  await requireAdmin(store, eventId, userId, COVER_REFUSAL);
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
  await requireAdmin(store, eventId, userId, COVER_REFUSAL);
  const key = coverKey(eventId, uploadId);
  if (!(await objectExists(key))) {
    throw new ApiError('upload_missing', 'No cover has been uploaded for this uploadId');
  }
  if (!(await store.setCover(eventId, key))) {
    throw new ApiError('not_found', 'No such event');
  }
  return { cover: await presignCover(key, presignGet) };
}

const SETTINGS_REFUSAL = "Only the event's Admin reads or changes its settings";

async function toSettings(record: SettingsRecord, presignGet: PresignGet): Promise<EventSettings> {
  return {
    name: record.name,
    description: record.description,
    approvalMode: record.approvalMode,
    cover: record.coverKey === null ? null : await presignCover(record.coverKey, presignGet),
    pendingCount: record.pendingCount,
    pendingPhotographers: record.pendingPhotographers,
  };
}

// GET /events/{eventId}/settings, for the event's Admin only (D-142). The check runs before the
// read, so a refused caller gets no field, no pending name and no cover URL (root invariant 3).
export async function getEventSettings(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
  eventId: string,
): Promise<GetEventSettingsResponse> {
  await requireAdmin(store, eventId, userId, SETTINGS_REFUSAL);
  const settings = await store.settings(eventId);
  if (settings === null) {
    // Soft-deleted after the check.
    throw new ApiError('not_found', 'No such event');
  }
  return { settings: await toSettings(settings, presignGet) };
}

// PATCH /events/{eventId}/settings, for the event's Admin only (D-142). The store is called only
// after the check, so a refused caller writes nothing and admits nobody. The cap is the server's,
// never the request's.
export async function updateEventSettings(
  store: EventStore,
  presignGet: PresignGet,
  userId: string,
  eventId: string,
  request: UpdateEventSettingsRequest,
): Promise<UpdateEventSettingsResponse> {
  await requireAdmin(store, eventId, userId, SETTINGS_REFUSAL);
  const result = await store.updateSettings(eventId, request, MAX_ACTIVE_GUESTS);
  if (result.outcome === 'not_found') {
    throw new ApiError('not_found', 'No such event');
  }
  return {
    settings: await toSettings(result.settings, presignGet),
    admitted: result.admitted,
  };
}
