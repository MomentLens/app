import type { Request, Response } from 'express';

import {
  ApproveRequestsRequest,
  ApproveRequestsResponse,
  BlockRequestRequest,
  BlockRequestResponse,
  ListPendingRequestsRequest,
  ListPendingRequestsResponse,
  RejectRequestsRequest,
  RejectRequestsResponse,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import type { EventStore } from '../services/events';
import { actOnRequests, blockRequest, listPendingRequests } from '../services/join-requests';
import type { JoinRequestStore } from '../services/join-requests';

export function listPendingRequestsController(events: EventStore, joinRequests: JoinRequestStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(ListPendingRequestsRequest, req.query);
    const result = await listPendingRequests(events, joinRequests, eventId, id, request);
    res.set('Cache-Control', 'no-store').json(ListPendingRequestsResponse.parse(result));
  };
}

export function requestBatchController(
  events: EventStore,
  joinRequests: JoinRequestStore,
  action: 'approve' | 'reject',
) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(
      action === 'approve' ? ApproveRequestsRequest : RejectRequestsRequest,
      req.body,
    );
    const result = await actOnRequests(events, joinRequests, eventId, id, action, request.targets);
    const response = action === 'approve' ? ApproveRequestsResponse : RejectRequestsResponse;
    res.set('Cache-Control', 'no-store').json(response.parse(result));
  };
}

export function blockRequestController(events: EventStore, joinRequests: JoinRequestStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const userId = parseInput(PathId, req.params.userId);
    const request = parseInput(BlockRequestRequest, req.body);
    const result = await blockRequest(
      events,
      joinRequests,
      eventId,
      id,
      userId,
      request.expectedVersion,
    );
    res.set('Cache-Control', 'no-store').json(BlockRequestResponse.parse(result));
  };
}
