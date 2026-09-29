import type { Request, Response } from 'express';

import {
  CancelJoinRequestResponse,
  JoinEventRequest,
  JoinEventResponse,
  ResolveInviteRequest,
  ResolveInviteResponse,
} from '@momentlens/shared-types';

import type { PresignGet } from '../lib/r2';
import { authenticatedUser, sessionUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { cancelJoinRequest, joinEvent, resolveInvite } from '../services/invites';
import type { InviteStore } from '../services/invites';

// Every response is parsed with its contract before sending, as in controllers/events.ts, and none
// may be cached: the preview carries a URL signed for this caller, and each answer depends on who
// asks.

// POST /invites/resolve, with or without a session (D-115). The token or code is in the body,
// never the path, because nginx logs every path (arch:invite).
export function resolveInviteController(invites: InviteStore, presignGet: PresignGet) {
  return async (req: Request, res: Response): Promise<void> => {
    const user = sessionUser(req);
    const lookup = parseInput(ResolveInviteRequest, req.body);
    const preview = await resolveInvite(invites, presignGet, user?.id ?? null, lookup);
    res.set('Cache-Control', 'no-store').json(ResolveInviteResponse.parse(preview));
  };
}

// POST /invites/join. 201 when this call made the caller's row, 200 for a rejoin or a repeat.
export function joinEventController(invites: InviteStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const lookup = parseInput(JoinEventRequest, req.body);
    const { created, membership } = await joinEvent(invites, id, lookup);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(JoinEventResponse.parse({ membership }));
  };
}

// DELETE /events/{eventId}/join-request. The request has no body.
export function cancelJoinRequestController(invites: InviteStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const result = await cancelJoinRequest(invites, id, eventId);
    res.set('Cache-Control', 'no-store').json(CancelJoinRequestResponse.parse(result));
  };
}
