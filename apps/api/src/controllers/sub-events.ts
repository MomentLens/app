import type { Request, Response } from 'express';

import {
  AddSubEventRequest,
  ListSubEventsResponse,
  UpdateSubEventRequest,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import type { EventStore } from '../services/events';
import { addSubEvent, deleteSubEvent, listSubEvents, updateSubEvent } from '../services/sub-events';
import type { SubEventStore } from '../services/sub-events';

// Every answer is the schedule, parsed with its contract before sending, so a stored row the
// contract rejects is a 500, not a bad body. It is one member's view of one event, so no cache may
// keep it.

// GET /events/{eventId}/sub-events, for every active role (D-121).
export function listSubEventsController(events: EventStore, subEvents: SubEventStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const schedule = await listSubEvents(events, subEvents, id, eventId);
    res.set('Cache-Control', 'no-store').json(ListSubEventsResponse.parse(schedule));
  };
}

// POST /events/{eventId}/sub-events, for the event's Admin. 201 when this call added the
// sub-event, 200 when its requestId repeated.
export function addSubEventController(events: EventStore, subEvents: SubEventStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(AddSubEventRequest, req.body);
    const { added, schedule } = await addSubEvent(events, subEvents, id, eventId, request);
    res
      .status(added ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(ListSubEventsResponse.parse(schedule));
  };
}

// PATCH /sub-events/{subEventId}, for the Admin of the sub-event's event. An edit and a Delay alike.
export function updateSubEventController(events: EventStore, subEvents: SubEventStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const subEventId = parseInput(PathId, req.params.subEventId);
    const request = parseInput(UpdateSubEventRequest, req.body);
    const schedule = await updateSubEvent(events, subEvents, id, subEventId, request);
    res.set('Cache-Control', 'no-store').json(ListSubEventsResponse.parse(schedule));
  };
}

// DELETE /sub-events/{subEventId}, for the Admin of the sub-event's event. The request has no body.
export function deleteSubEventController(events: EventStore, subEvents: SubEventStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const subEventId = parseInput(PathId, req.params.subEventId);
    const schedule = await deleteSubEvent(events, subEvents, id, subEventId);
    res.set('Cache-Control', 'no-store').json(ListSubEventsResponse.parse(schedule));
  };
}
