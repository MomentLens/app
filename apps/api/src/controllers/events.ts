import type { Request, Response } from 'express';

import {
  CreateCoverUploadResponse,
  CreateEventRequest,
  CreateEventResponse,
  ListEventsResponse,
  SetEventCoverRequest,
  SetEventCoverResponse,
} from '@momentlens/shared-types';

import type { ObjectExists, PresignGet, PresignPut } from '../lib/r2';
import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { createEvent, listEvents, setEventCover, startCoverUpload } from '../services/events';
import type { EventStore } from '../services/events';

// Every response is parsed with its contract before sending, so a stored row the contract rejects
// is a 500, not a bad body. Each carries URLs signed for this caller, so no cache may keep it.

// POST /events (D-110). 201 when this call made the event, 200 when its requestId repeated.
export function createEventController(events: EventStore, presignGet: PresignGet) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const request = parseInput(CreateEventRequest, req.body);
    const { created, event } = await createEvent(events, presignGet, id, request);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(CreateEventResponse.parse({ event }));
  };
}

// GET /events. The caller's events and nobody else's; the user comes from the token only.
export function listEventsController(events: EventStore, presignGet: PresignGet) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const list = await listEvents(events, presignGet, id);
    res.set('Cache-Control', 'no-store').json(ListEventsResponse.parse({ events: list }));
  };
}

// POST /events/{eventId}/cover-upload, for the event's Admin. The request has no body.
export function createCoverUploadController(events: EventStore, presignPut: PresignPut) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const upload = await startCoverUpload(events, presignPut, id, eventId);
    res.set('Cache-Control', 'no-store').json(CreateCoverUploadResponse.parse(upload));
  };
}

// PUT /events/{eventId}/cover, for the event's Admin, once the upload has reached R2.
export function setEventCoverController(
  events: EventStore,
  objectExists: ObjectExists,
  presignGet: PresignGet,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const { uploadId } = parseInput(SetEventCoverRequest, req.body);
    const result = await setEventCover(events, objectExists, presignGet, id, eventId, uploadId);
    res.set('Cache-Control', 'no-store').json(SetEventCoverResponse.parse(result));
  };
}
