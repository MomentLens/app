import type { Request, Response } from 'express';

import {
  CompleteUploadResponse,
  ListAlbumRequest,
  ListAlbumResponse,
  ListUploadersResponse,
  MediaImagesRequest,
  MediaImagesResponse,
  MediaStatusRequest,
  MediaStatusResponse,
  PreflightUploadRequest,
  PreflightUploadResponse,
} from '@momentlens/shared-types';

import { authenticatedUser } from '../middleware/auth';
import { parseInput, PathId } from '../middleware/body';
import { listAlbum, listUploaders } from '../services/album';
import type { AlbumStore } from '../services/album';
import type { EventStore } from '../services/events';
import { serveMediaImages } from '../services/media-images';
import type { ServeImagesDeps } from '../services/media-images';
import { completeUpload, mediaStatus, preflightUpload } from '../services/media';
import type { MediaDeps } from '../services/media';

// Each answer is parsed with its contract before sending, so a value the contract rejects is a 500,
// not a bad body. A pre-flight answer holds signed URLs, so no cache may keep either.

// POST /events/{eventId}/media/preflight. 201 when this call created the media row, 200 when it
// resumed the caller's own unfinished one (D-122).
export function preflightUploadController(deps: MediaDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(PreflightUploadRequest, req.body);
    const { created, upload } = await preflightUpload(deps, id, eventId, request);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(PreflightUploadResponse.parse(upload));
  };
}

// POST /media/{mediaId}/complete. The request has no body.
export function completeUploadController(deps: MediaDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const mediaId = parseInput(PathId, req.params.mediaId);
    const answer = await completeUpload(deps, id, mediaId);
    res.set('Cache-Control', 'no-store').json(CompleteUploadResponse.parse(answer));
  };
}

export function mediaStatusController(deps: Pick<MediaDeps, 'events' | 'media'>) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(MediaStatusRequest, req.body);
    const answer = await mediaStatus(deps, id, eventId, request);
    res.set('Cache-Control', 'no-store').json(MediaStatusResponse.parse(answer));
  };
}

// GET /events/{eventId}/media
export function listAlbumController(events: EventStore, album: AlbumStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(ListAlbumRequest, req.query);
    const answer = await listAlbum(events, album, eventId, id, request);
    res.set('Cache-Control', 'no-store').json(ListAlbumResponse.parse(answer));
  };
}

// GET /events/{eventId}/media/uploaders
export function listUploadersController(events: EventStore, album: AlbumStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const answer = await listUploaders(events, album, eventId, id);
    res.set('Cache-Control', 'no-store').json(ListUploadersResponse.parse(answer));
  };
}

// POST /events/{eventId}/media/images
export function mediaImagesController(deps: ServeImagesDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const eventId = parseInput(PathId, req.params.eventId);
    const request = parseInput(MediaImagesRequest, req.body);
    const answer = await serveMediaImages(deps, id, eventId, request);
    res.set('Cache-Control', 'no-store').json(MediaImagesResponse.parse(answer));
  };
}
