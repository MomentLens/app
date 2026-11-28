import type { Request, Response } from 'express';

import {
  KeepBlurRegionResponse,
  KeepPhotoFlagsResponse,
  ListFlaggedPhotosRequest,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsRequest,
  ListReviewBlurRegionsResponse,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import type { EventStore } from '../services/events';
import {
  keepBlurRegion,
  keepPhotoFlags,
  listFlaggedPhotos,
  listReviewBlurRegions,
} from '../services/review-queue';
import type { ReviewQueueStore } from '../services/review-queue';

// Each answer is parsed with its contract before sending so a mismatch is a 500, not a bad body.
// Review Queue responses reflect moderation actions immediately, so no cache may keep one.

// GET /events/{eventId}/review-queue/flags
export function listFlaggedPhotosController(events: EventStore, reviewQueue: ReviewQueueStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(ListFlaggedPhotosRequest, req.query);
    const answer = await listFlaggedPhotos(events, reviewQueue, eventId, id, request);
    res.set('Cache-Control', 'no-store').json(ListFlaggedPhotosResponse.parse(answer));
  };
}

// POST /media/{mediaId}/flags/keep. No body.
export function keepPhotoFlagsController(reviewQueue: ReviewQueueStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const mediaId = parseInput(PathId, req.params.mediaId);
    const answer = await keepPhotoFlags(reviewQueue, id, mediaId);
    res.set('Cache-Control', 'no-store').json(KeepPhotoFlagsResponse.parse(answer));
  };
}

// GET /events/{eventId}/review-queue/blur-regions
export function listReviewBlurRegionsController(events: EventStore, reviewQueue: ReviewQueueStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(ListReviewBlurRegionsRequest, req.query);
    const answer = await listReviewBlurRegions(events, reviewQueue, eventId, id, request);
    res.set('Cache-Control', 'no-store').json(ListReviewBlurRegionsResponse.parse(answer));
  };
}

// POST /blur-regions/{regionId}/keep. No body.
export function keepBlurRegionController(reviewQueue: ReviewQueueStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const regionId = parseInput(PathId, req.params.regionId);
    const answer = await keepBlurRegion(reviewQueue, id, regionId);
    res.set('Cache-Control', 'no-store').json(KeepBlurRegionResponse.parse(answer));
  };
}
