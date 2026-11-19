import type { Request, Response } from 'express';

import { AddBlurRegionRequest, ListBlurRegionsResponse } from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { addBlurRegion, listBlurRegions, removeBlurRegion } from '../services/blur-regions';
import type { BlurRegionStore } from '../services/blur-regions';

// Each answer is parsed with its contract before sending, so a value the contract rejects is a 500,
// not a bad body. A region list changes with every draw, so no cache may keep one.

// POST /media/{mediaId}/blur-regions. 201 for a new region, 200 for a repeat of one the caller
// already stored on this photo.
export function addBlurRegionController(store: BlurRegionStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const mediaId = parseInput(PathId, req.params.mediaId);
    const request = parseInput(AddBlurRegionRequest, req.body);
    const { created, answer } = await addBlurRegion(store, id, mediaId, request);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(ListBlurRegionsResponse.parse(answer));
  };
}

// GET /media/{mediaId}/blur-regions
export function listBlurRegionsController(store: BlurRegionStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const mediaId = parseInput(PathId, req.params.mediaId);
    const answer = await listBlurRegions(store, id, mediaId);
    res.set('Cache-Control', 'no-store').json(ListBlurRegionsResponse.parse(answer));
  };
}

// DELETE /blur-regions/{regionId}. The request has no body.
export function removeBlurRegionController(store: BlurRegionStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const regionId = parseInput(PathId, req.params.regionId);
    const answer = await removeBlurRegion(store, id, regionId);
    res.set('Cache-Control', 'no-store').json(ListBlurRegionsResponse.parse(answer));
  };
}
