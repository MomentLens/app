import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type {
  CompleteUploadResponse,
  MembershipRole,
  PreflightUploadRequest,
  PreflightUploadResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { uploadKeys } from '../lib/keys';
import type { DeleteObject, ObjectSize, PresignPut } from '../lib/r2';
import { ApiError } from '../middleware/errors';
import { requireActiveMember, requireMember } from './events';
import type { EventStore } from './events';

// The most media rows an event holds that are not soft-deleted, unfinished ones included
// (spec §4.17, D-95). start_upload counts against it under the event lock.
export const MAX_EVENT_MEDIA = 2000;

// The most unfinished rows one person holds in an event that are not soft-deleted (D-122). The phone
// uploads one photo at a time and resumes its own unfinished row, so only rows it abandoned add up.
// Without a limit, one member could fill MAX_EVENT_MEDIA with pre-flights that never upload.
export const MAX_UNFINISHED_UPLOADS = 50;

// The two limits start_upload checks under the event lock. Tests pass smaller ones.
export interface UploadLimits {
  maxMedia: number;
  maxUnfinished: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
  maxMedia: MAX_EVENT_MEDIA,
  maxUnfinished: MAX_UNFINISHED_UPLOADS,
};

// Pre-flight's album check (D-12, D-82). Off until S-31 gives the Admin the toggle, because every
// event's album starts closed and nothing could open it before then (D-122).
export const ALBUM_CHECK = false;

const PHOTO_TYPE = 'image/jpeg';
const THUMBNAIL_TYPE = 'image/webp';

// A new media row as pre-flight offers it to start_upload. The id and both keys are built here
// before the call, and start_upload keeps them only when it inserts (root invariant 12).
export interface NewUpload {
  mediaId: string;
  eventId: string;
  subEventId: string;
  userId: string;
  role: MembershipRole;
  contentHash: string;
  // Null when the photo has no EXIF time; start_upload then stamps the pre-flight's time (D-98).
  capturedAt: string | null;
  uploadKey: string;
  uploadThumbKey: string;
}

// What start_upload did (supabase/migrations/..._media_upload.sql). `created` inserted the row
// offered; `resumed` found the caller's own unfinished row with this hash and returns its id and
// keys, which are the ones to sign. A refusal wrote nothing.
export type StartResult =
  | { outcome: 'created' | 'resumed'; mediaId: string; uploadKey: string; uploadThumbKey: string }
  | { outcome: 'not_found' | 'sub_event_missing' | 'duplicate' | 'full' | 'too_many' };

// One media row as completion reads it, before any check.
export interface UploadRecord {
  id: string;
  eventId: string;
  uploaderUserId: string;
  uploadKey: string;
  uploadThumbKey: string;
  uploaded: boolean;
}

// What complete_upload did. `completed` carries the id of the message it sent, or null when the
// row was already finished and it sent none. `duplicate` deleted the row, whose objects are the
// caller's to delete. `gone` found no row, or a soft-deleted one. Another completion deleted it as a
// duplicate, or its uploader deleted it (D-122).
// `not_found` is an event soft-deleted since the service's check.
export type CompleteResult =
  | { outcome: 'completed'; messageId: number | null }
  | { outcome: 'duplicate' | 'gone' | 'not_uploader' | 'not_found' };

// Every read and write of media that upload makes. It checks nothing about who asks; the functions
// below do, before each call.
export interface MediaStore {
  start(upload: NewUpload, limits: UploadLimits): Promise<StartResult>;
  // Null when no row has this id, or the row was soft-deleted (D-122).
  findUpload(mediaId: string): Promise<UploadRecord | null>;
  complete(mediaId: string, userId: string, sizeBytes: number): Promise<CompleteResult>;
}

export interface MediaDeps {
  events: EventStore;
  media: MediaStore;
  presignPut: PresignPut;
  objectSize: ObjectSize;
  deleteObject: DeleteObject;
  logger: Logger;
}

// One row of start_upload. The id and keys are null for every refusal.
const StartRow = z.union([
  z
    .object({
      outcome: z.enum(['created', 'resumed']),
      media_id: z.uuid(),
      upload_key: z.string(),
      upload_thumb_key: z.string(),
    })
    .transform((row) => ({
      outcome: row.outcome,
      mediaId: row.media_id,
      uploadKey: row.upload_key,
      uploadThumbKey: row.upload_thumb_key,
    })),
  z
    .object({
      outcome: z.enum(['not_found', 'sub_event_missing', 'duplicate', 'full', 'too_many']),
      media_id: z.null(),
      upload_key: z.null(),
      upload_thumb_key: z.null(),
    })
    .transform((row) => ({ outcome: row.outcome })),
]);

// One row of complete_upload. message_id is pgmq's bigint, well inside a double's integers.
const CompleteRow = z.union([
  z
    .object({ outcome: z.literal('completed'), message_id: z.int().nullable() })
    .transform((row) => ({ outcome: row.outcome, messageId: row.message_id })),
  z
    .object({
      outcome: z.enum(['duplicate', 'gone', 'not_uploader', 'not_found']),
      message_id: z.null(),
    })
    .transform((row) => ({ outcome: row.outcome })),
]);

const UploadRow = z
  .object({
    id: z.uuid(),
    event_id: z.uuid(),
    uploader_user_id: z.uuid(),
    upload_key: z.string(),
    upload_thumb_key: z.string(),
    uploaded_at: z.string().nullable(),
  })
  .transform((row): UploadRecord => ({
    id: row.id,
    eventId: row.event_id,
    uploaderUserId: row.uploader_user_id,
    uploadKey: row.upload_key,
    uploadThumbKey: row.upload_thumb_key,
    uploaded: row.uploaded_at !== null,
  }));

// start_upload's arguments. Exported so the dev-project test can call it with the publishable key
// and see it refused.
export function startUploadParams(upload: NewUpload, limits: UploadLimits) {
  return {
    p_media_id: upload.mediaId,
    p_event_id: upload.eventId,
    p_sub_event_id: upload.subEventId,
    p_user_id: upload.userId,
    p_role: upload.role,
    p_content_hash: upload.contentHash,
    p_captured_at: upload.capturedAt,
    p_upload_key: upload.uploadKey,
    p_upload_thumb_key: upload.uploadThumbKey,
    p_max_media: limits.maxMedia,
    p_max_unfinished: limits.maxUnfinished,
  };
}

// Calls a function that returns one row, and parses it. One rpc is one transaction (D-95).
async function callOne<T extends z.ZodType>(
  supabase: Supabase,
  name: string,
  params: Record<string, unknown>,
  row: T,
): Promise<z.output<T>> {
  const result = await supabase.rpc(name, params);
  if (result.error) {
    throw result.error;
  }
  // Without generated database types, rpc types its data as any, so it is parsed as unknown.
  const [first, ...rest] = z.array(row).parse(result.data as unknown);
  if (first === undefined || rest.length > 0) {
    throw new Error(`${name} returned ${rest.length + (first ? 1 : 0)} rows, expected 1`);
  }
  return first;
}

export function createMediaStore(supabase: Supabase): MediaStore {
  return {
    async start(upload, limits) {
      return callOne(supabase, 'start_upload', startUploadParams(upload, limits), StartRow);
    },

    async findUpload(mediaId) {
      // By primary key. A soft-deleted row reads as none, as complete_upload treats it.
      const { data, error } = await supabase
        .from('media')
        .select('id, event_id, uploader_user_id, upload_key, upload_thumb_key, uploaded_at')
        .eq('id', mediaId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data === null ? null : UploadRow.parse(data);
    },

    async complete(mediaId, userId, sizeBytes) {
      const params = { p_media_id: mediaId, p_user_id: userId, p_size_bytes: sizeBytes };
      return callOne(supabase, 'complete_upload', params, CompleteRow);
    },
  };
}

// POST /events/{eventId}/media/preflight, for every active role alike (D-58). `created` is false
// for a resume. The event comes from the path and the role from the membership, never the body.
// start_upload decides the sub-event, the resume, the duplicate, the cap and the caller's limit on
// unfinished rows under the event lock, in that order, and the API makes no lookups of its own
// first (arch §4, D-122). S-15 adds the verification check between the duplicate and the cap.
export async function preflightUpload(
  deps: MediaDeps,
  userId: string,
  eventId: string,
  request: PreflightUploadRequest,
  albumCheck: boolean = ALBUM_CHECK,
): Promise<{ created: boolean; upload: PreflightUploadResponse }> {
  const { role, albumOpen } = await requireActiveMember(deps.events, eventId, userId);
  if (albumCheck && !albumOpen) {
    throw new ApiError('album_closed', "The event's album is closed");
  }

  const mediaId = randomUUID();
  const keys = uploadKeys(mediaId);
  const result = await deps.media.start(
    {
      mediaId,
      eventId,
      subEventId: request.subEventId,
      userId,
      role,
      contentHash: request.contentHash,
      capturedAt: request.capturedAt ?? null,
      uploadKey: keys.photo,
      uploadThumbKey: keys.thumbnail,
    },
    UPLOAD_LIMITS,
  );

  switch (result.outcome) {
    case 'created':
    case 'resumed': {
      // The keys start_upload returned, which for a resume are the row's own and not the ones
      // built above. A resumed upload re-PUTs them; nobody can read them before uploaded_at is set.
      const [photoUploadUrl, thumbnailUploadUrl] = await Promise.all([
        deps.presignPut(result.uploadKey, PHOTO_TYPE),
        deps.presignPut(result.uploadThumbKey, THUMBNAIL_TYPE),
      ]);
      return {
        created: result.outcome === 'created',
        upload: { mediaId: result.mediaId, photoUploadUrl, thumbnailUploadUrl },
      };
    }
    case 'not_found':
      // Soft-deleted after the check.
      throw new ApiError('not_found', 'No such event');
    case 'sub_event_missing':
      throw new ApiError('sub_event_missing', 'No such sub-event in this event');
    case 'duplicate':
      // A finished photo in this event, deleted or not, has these bytes (D-96).
      throw new ApiError('duplicate', 'This photo is already in the event');
    case 'full':
      throw new ApiError('event_full', `The event holds ${MAX_EVENT_MEDIA} photos`);
    case 'too_many':
      throw new ApiError(
        'too_many_unfinished',
        `The caller holds ${MAX_UNFINISHED_UPLOADS} unfinished uploads in this event`,
      );
  }
}

// Deletes a duplicate's two objects after complete_upload deleted its row. A failure is logged and
// changes nothing about the answer (D-122).
async function deleteObjects(deps: MediaDeps, upload: UploadRecord): Promise<void> {
  const keys = [upload.uploadKey, upload.uploadThumbKey];
  const results = await Promise.allSettled(keys.map((key) => deps.deleteObject(key)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      deps.logger.error(
        { err: result.reason as unknown, mediaId: upload.id, key: keys[index] },
        'could not delete a duplicate upload from R2',
      );
    }
  });
}

const DUPLICATE_MESSAGE = 'Another finished photo in this event has these bytes';

// POST /media/{mediaId}/complete, by the photo's uploader. The checks run in arch §4's order, all
// before R2 is asked anything (D-122). Then the two HEADs, then complete_upload, which marks the row
// uploaded and enqueues its job in one transaction (D-95). The row's processed_at stays null; the
// worker sets it last (root invariant 1).
export async function completeUpload(
  deps: MediaDeps,
  userId: string,
  mediaId: string,
): Promise<CompleteUploadResponse> {
  const upload = await deps.media.findUpload(mediaId);
  if (upload === null) {
    // A duplicate completion deleted the row, and this is the answer the phone lost, or the uploader
    // deleted it. Either way the phone drops the photo (D-122).
    throw new ApiError('duplicate', DUPLICATE_MESSAGE);
  }
  if (upload.uploaderUserId !== userId) {
    throw new ApiError('not_uploader', 'Only the uploader completes an upload');
  }
  await requireMember(deps.events, upload.eventId, userId);
  if (upload.uploaded) {
    // uploaded_at never goes back to null, so a repeat has nothing to check or send.
    return { status: 'completed' };
  }

  const [photoSize, thumbnailSize] = await Promise.all([
    deps.objectSize(upload.uploadKey),
    deps.objectSize(upload.uploadThumbKey),
  ]);
  // An empty object is a PUT that sent nothing, so the phone uploads both files again.
  if (photoSize === null || thumbnailSize === null || photoSize === 0 || thumbnailSize === 0) {
    throw new ApiError('upload_missing', 'The photo or its thumbnail is not in storage');
  }

  const result = await deps.media.complete(mediaId, userId, photoSize);
  switch (result.outcome) {
    case 'completed':
      if (result.messageId !== null) {
        deps.logger.info(
          { mediaId, eventId: upload.eventId, messageId: result.messageId },
          'upload completed and its job enqueued',
        );
      }
      return { status: 'completed' };
    case 'duplicate':
      await deleteObjects(deps, upload);
      throw new ApiError('duplicate', DUPLICATE_MESSAGE);
    case 'gone':
      throw new ApiError('duplicate', DUPLICATE_MESSAGE);
    case 'not_uploader':
      throw new ApiError('not_uploader', 'Only the uploader completes an upload');
    case 'not_found':
      throw new ApiError('not_found', 'No such event');
  }
}
