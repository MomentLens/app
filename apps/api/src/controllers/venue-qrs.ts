import type { Request, Response } from 'express';

import {
  ListVenueQrsResponse,
  RegenerateVenueQrRequest,
  RegenerateVenueQrResponse,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { listVenueQrs, regenerateVenueQr } from '../services/venue-qrs';
import type { VenueQrStore } from '../services/venue-qrs';

export function listVenueQrsController(store: VenueQrStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const result = await listVenueQrs(store, eventId, id);
    res.json(ListVenueQrsResponse.parse(result));
  };
}

export function regenerateVenueQrController(store: VenueQrStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const venueId = parseInput(PathId, req.params.venueId);
    const request = parseInput(RegenerateVenueQrRequest, req.body);
    const result = await regenerateVenueQr(store, eventId, id, venueId, request);
    res.json(RegenerateVenueQrResponse.parse(result));
  };
}
