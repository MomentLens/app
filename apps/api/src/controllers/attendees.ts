import type { Request, Response } from 'express';

import {
  BlockAttendeeRequest,
  BlockAttendeeResponse,
  ChangeAttendeeRoleRequest,
  ChangeAttendeeRoleResponse,
  ListAttendeesRequest,
  ListAttendeesResponse,
  RemoveAttendeeRequest,
  RemoveAttendeeResponse,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { listAttendees, mutateAttendee } from '../services/attendees';
import type { AttendeeAction, AttendeeStore } from '../services/attendees';
import type { EventStore } from '../services/events';

export function listAttendeesController(events: EventStore, attendees: AttendeeStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(ListAttendeesRequest, req.query);
    const result = await listAttendees(events, attendees, eventId, id, request);
    res.set('Cache-Control', 'no-store').json(ListAttendeesResponse.parse(result));
  };
}

export function attendeeMutationController(
  events: EventStore,
  attendees: AttendeeStore,
  action: AttendeeAction,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const userId = parseInput(PathId, req.params.userId);
    const request =
      action === 'role'
        ? parseInput(ChangeAttendeeRoleRequest, req.body)
        : {
            ...parseInput(
              action === 'remove' ? RemoveAttendeeRequest : BlockAttendeeRequest,
              req.body,
            ),
            role: null,
          };
    const result = await mutateAttendee(
      events,
      attendees,
      eventId,
      id,
      userId,
      action,
      request.expectedVersion,
      request.role,
    );
    const response =
      action === 'role'
        ? ChangeAttendeeRoleResponse
        : action === 'remove'
          ? RemoveAttendeeResponse
          : BlockAttendeeResponse;
    res.set('Cache-Control', 'no-store').json(response.parse(result));
  };
}
