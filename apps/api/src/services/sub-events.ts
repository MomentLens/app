import { z } from 'zod';

import type {
  AddSubEventRequest,
  ListSubEventsResponse,
  SubEvent,
  UpdateSubEventRequest,
  VenueChoice,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { ApiError } from '../middleware/errors';
import { requireAdmin, requireMember, toTimestamp } from './events';
import type { EventStore } from './events';

// What add_sub_event, update_sub_event and delete_sub_event did
// (supabase/migrations/..._sub_event_writes.sql). A refusal carries no schedule and wrote nothing.
// not_found is an event soft-deleted, or a sub-event deleted, after the service's check.
export type AddResult =
  | { outcome: 'added' | 'repeated'; subEvents: SubEvent[] }
  | { outcome: 'not_found' | 'taken' | 'no_venue' | 'too_many' | 'too_long' };

export type UpdateResult =
  | { outcome: 'updated'; subEvents: SubEvent[] }
  | { outcome: 'not_found' | 'no_venue' | 'too_long' };

export type DeleteResult =
  { outcome: 'deleted'; subEvents: SubEvent[] } | { outcome: 'not_found' | 'last' };

// Every read and write of an event's schedule. It checks nothing about who asks; the functions
// below check the caller against the event store first, and pass each write the event they checked.
export interface SubEventStore {
  // The event a sub-event belongs to, deleted or not. Null when no sub-event has this id.
  findEventId(subEventId: string): Promise<string | null>;
  // The event's schedule in the Schedule's order. Null when the event does not exist or is
  // soft-deleted.
  schedule(eventId: string): Promise<SubEvent[] | null>;
  add(eventId: string, request: AddSubEventRequest): Promise<AddResult>;
  update(
    eventId: string,
    subEventId: string,
    request: UpdateSubEventRequest,
  ): Promise<UpdateResult>;
  remove(eventId: string, subEventId: string): Promise<DeleteResult>;
}

// One element of sub_event_schedule's array. Parsed rather than cast, so a renamed key fails here,
// and every key not named here, qr_secret included, is dropped.
const ScheduleRow = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    starts_at: z.string().transform(toTimestamp),
    ends_at: z.string().transform(toTimestamp),
    verification_radius_m: z.int(),
    venue: z.object({ id: z.uuid(), name: z.string(), lat: z.number(), lng: z.number() }),
  })
  .transform((row): SubEvent => ({
    id: row.id,
    name: row.name,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    verificationRadiusM: row.verification_radius_m,
    venue: row.venue,
  }));

const Schedule = z.array(ScheduleRow);

// One row of each write function, as the store hands it on. `schedule` is the schedule after a
// write, and null for every refusal. An outcome not named here fails the parse, so a function that
// grew one fails loudly rather than reaching the app.
const AddRow = z.union([
  z
    .object({ outcome: z.enum(['added', 'repeated']), schedule: Schedule })
    .transform((row) => ({ outcome: row.outcome, subEvents: row.schedule })),
  z
    .object({
      outcome: z.enum(['not_found', 'taken', 'no_venue', 'too_many', 'too_long']),
      schedule: z.null(),
    })
    .transform((row) => ({ outcome: row.outcome })),
]);

const UpdateRow = z.union([
  z
    .object({ outcome: z.literal('updated'), schedule: Schedule })
    .transform((row) => ({ outcome: row.outcome, subEvents: row.schedule })),
  z
    .object({ outcome: z.enum(['not_found', 'no_venue', 'too_long']), schedule: z.null() })
    .transform((row) => ({ outcome: row.outcome })),
]);

const DeleteRow = z.union([
  z
    .object({ outcome: z.literal('deleted'), schedule: Schedule })
    .transform((row) => ({ outcome: row.outcome, subEvents: row.schedule })),
  z
    .object({ outcome: z.enum(['not_found', 'last']), schedule: z.null() })
    .transform((row) => ({ outcome: row.outcome })),
]);

// The venue half of add_sub_event's and update_sub_event's arguments: the id of one of the event's
// venues, a new venue's name and pin, or, for an edit only, nothing.
function venueParams(venue: VenueChoice | undefined) {
  if (venue === undefined) {
    return { p_venue_id: null, p_venue_name: null, p_venue_lat: null, p_venue_lng: null };
  }
  return 'id' in venue
    ? { p_venue_id: venue.id, p_venue_name: null, p_venue_lat: null, p_venue_lng: null }
    : {
        p_venue_id: null,
        p_venue_name: venue.name,
        p_venue_lat: venue.lat,
        p_venue_lng: venue.lng,
      };
}

// add_sub_event's and update_sub_event's arguments for a parsed request. Exported so the
// dev-project test can call both functions with the publishable key and see them refused.
export function addSubEventParams(eventId: string, request: AddSubEventRequest) {
  return {
    p_event_id: eventId,
    p_request_id: request.requestId,
    p_name: request.name,
    p_description: request.description ?? null,
    p_starts_at: request.startsAt,
    p_ends_at: request.endsAt,
    ...venueParams(request.venue),
    p_verification_radius_m: request.verificationRadiusM,
  };
}

// A field the request leaves out is null, which the function leaves as it is. An empty description
// is sent as it is, and the function clears the description for it.
export function updateSubEventParams(
  eventId: string,
  subEventId: string,
  request: UpdateSubEventRequest,
) {
  return {
    p_event_id: eventId,
    p_sub_event_id: subEventId,
    p_name: request.name ?? null,
    p_description: request.description ?? null,
    p_starts_at: request.startsAt ?? null,
    p_ends_at: request.endsAt ?? null,
    ...venueParams(request.venue),
    p_verification_radius_m: request.verificationRadiusM ?? null,
  };
}

// Calls a write function and reads its one row. One rpc is one transaction, under the event's
// lock (D-95, D-121).
async function callWrite<T extends z.ZodType>(
  supabase: Supabase,
  name: string,
  params: Record<string, unknown>,
  row: T,
): Promise<z.output<T>> {
  const result = await supabase.rpc(name, params);
  if (result.error) {
    throw result.error;
  }
  // Without generated database types, rpc types its data as any, so it is parsed as unknown.
  const [first, ...rest] = z.array(row).parse(result.data as unknown);
  if (first === undefined || rest.length > 0) {
    throw new Error(`${name} returned ${rest.length + (first ? 1 : 0)} rows, expected 1`);
  }
  return first;
}

export function createSubEventStore(supabase: Supabase): SubEventStore {
  return {
    async findEventId(subEventId) {
      // By primary key.
      const { data, error } = await supabase
        .from('sub_event')
        .select('event_id')
        .eq('id', subEventId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data === null ? null : z.object({ event_id: z.uuid() }).parse(data).event_id;
    },

    async schedule(eventId) {
      // An rpc so that GET and the writes build the schedule in one place, in one order.
      const result = await supabase.rpc('sub_event_schedule', { p_event_id: eventId });
      if (result.error) {
        throw result.error;
      }
      return Schedule.nullable().parse(result.data as unknown);
    },

    async add(eventId, request) {
      const params = addSubEventParams(eventId, request);
      return callWrite(supabase, 'add_sub_event', params, AddRow);
    },

    async update(eventId, subEventId, request) {
      const params = updateSubEventParams(eventId, subEventId, request);
      return callWrite(supabase, 'update_sub_event', params, UpdateRow);
    },

    async remove(eventId, subEventId) {
      const params = { p_event_id: eventId, p_sub_event_id: subEventId };
      return callWrite(supabase, 'delete_sub_event', params, DeleteRow);
    },
  };
}

const WRITE_REFUSAL = "Only the event's Admin changes its schedule";

// The event a sub-event belongs to, once the caller is checked as its Admin. An unknown sub-event
// is 404. A caller who is not an active member of its event is 403 not_member, another event's
// Admin included, so an Admin's role never carries across events.
async function requireSubEventAdmin(
  events: EventStore,
  subEvents: SubEventStore,
  userId: string,
  subEventId: string,
): Promise<string> {
  const eventId = await subEvents.findEventId(subEventId);
  if (eventId === null) {
    throw new ApiError('not_found', 'No such sub-event');
  }
  await requireAdmin(events, eventId, userId, WRITE_REFUSAL);
  return eventId;
}

// The answer to each refusal a write function gives (hb §5.3, D-121).
function refuse(outcome: string): never {
  switch (outcome) {
    case 'not_found':
      // The event was soft-deleted, or the sub-event deleted, after the check.
      throw new ApiError('not_found', 'No such event or sub-event');
    case 'taken':
      // Another event's sub-event holds this requestId. Saying nothing about it keeps that event
      // hidden; an honest app never reuses a requestId it did not make, as with POST /events.
      throw new ApiError('duplicate', 'This requestId belongs to another sub-event');
    case 'no_venue':
      throw new ApiError('invalid_request', 'No such venue in this event');
    case 'too_many':
      throw new ApiError('too_many_sub_events', 'An event has at most 15 sub-events');
    case 'too_long':
      throw new ApiError('event_too_long', 'An event runs at most 336 hours');
    case 'last':
      throw new ApiError('last_sub_event', "An event's last sub-event cannot be deleted");
    default:
      throw new Error(`No answer for the refusal ${outcome}`);
  }
}

// GET /events/{eventId}/sub-events, for every active role (D-121). The schedule carries no
// qr_secret, so a Guest and a Photographer read the same body as the Admin.
export async function listSubEvents(
  events: EventStore,
  subEvents: SubEventStore,
  userId: string,
  eventId: string,
): Promise<ListSubEventsResponse> {
  await requireMember(events, eventId, userId);
  const schedule = await subEvents.schedule(eventId);
  if (schedule === null) {
    // Soft-deleted after the check.
    throw new ApiError('not_found', 'No such event');
  }
  return { subEvents: schedule };
}

// POST /events/{eventId}/sub-events, for the event's Admin. `added` is false when the requestId
// repeated and nothing was written.
export async function addSubEvent(
  events: EventStore,
  subEvents: SubEventStore,
  userId: string,
  eventId: string,
  request: AddSubEventRequest,
): Promise<{ added: boolean; schedule: ListSubEventsResponse }> {
  await requireAdmin(events, eventId, userId, WRITE_REFUSAL);
  const result = await subEvents.add(eventId, request);
  if (!('subEvents' in result)) {
    refuse(result.outcome);
  }
  return { added: result.outcome === 'added', schedule: { subEvents: result.subEvents } };
}

// PATCH /sub-events/{subEventId}, for the Admin of the sub-event's own event. The event comes from
// the sub-event's row, never from the request.
export async function updateSubEvent(
  events: EventStore,
  subEvents: SubEventStore,
  userId: string,
  subEventId: string,
  request: UpdateSubEventRequest,
): Promise<ListSubEventsResponse> {
  const eventId = await requireSubEventAdmin(events, subEvents, userId, subEventId);
  const result = await subEvents.update(eventId, subEventId, request);
  if (!('subEvents' in result)) {
    refuse(result.outcome);
  }
  return { subEvents: result.subEvents };
}

// DELETE /sub-events/{subEventId}, for the Admin of the sub-event's own event. A delete that already
// happened is 404, like any unknown sub-event.
export async function deleteSubEvent(
  events: EventStore,
  subEvents: SubEventStore,
  userId: string,
  subEventId: string,
): Promise<ListSubEventsResponse> {
  const eventId = await requireSubEventAdmin(events, subEvents, userId, subEventId);
  const result = await subEvents.remove(eventId, subEventId);
  if (!('subEvents' in result)) {
    refuse(result.outcome);
  }
  return { subEvents: result.subEvents };
}
