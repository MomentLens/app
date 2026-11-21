import type { Request, Response } from 'express';

import { CreateReferenceUploadResponse, ListReferencesResponse } from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import {
  addReference,
  listReferences,
  removeReference,
  startReferenceUpload,
} from '../services/references';
import type { ReferenceDeps } from '../services/references';

// Each answer is parsed with its contract before sending, so a value the contract rejects is a 500,
// not a bad body. Every answer holds URLs signed for the caller, so no cache may keep one. None of
// these requests has a body; the photo goes to R2 by its presigned PUT (root invariant 5).

// GET /events/{eventId}/references
export function listReferencesController(deps: ReferenceDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const answer = await listReferences(deps, id, eventId);
    res.set('Cache-Control', 'no-store').json(ListReferencesResponse.parse(answer));
  };
}

// POST /events/{eventId}/references/upload
export function createReferenceUploadController(deps: ReferenceDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const upload = await startReferenceUpload(deps, id, eventId);
    res.set('Cache-Control', 'no-store').json(CreateReferenceUploadResponse.parse(upload));
  };
}

// PUT /events/{eventId}/references/{uploadId}. 201 for a new reference, 200 for a repeat.
export function addReferenceController(deps: ReferenceDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const referenceId = parseInput(PathId, req.params.referenceId);
    const { created, response } = await addReference(deps, id, eventId, referenceId);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(ListReferencesResponse.parse(response));
  };
}

// DELETE /events/{eventId}/references/{referenceId}
export function removeReferenceController(deps: ReferenceDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const referenceId = parseInput(PathId, req.params.referenceId);
    const answer = await removeReference(deps, id, eventId, referenceId);
    res.set('Cache-Control', 'no-store').json(ListReferencesResponse.parse(answer));
  };
}
