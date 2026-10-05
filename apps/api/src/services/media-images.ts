import { z } from 'zod';

import type {
  MediaImagesRequest,
  MediaImagesResponse,
  PresignedImage,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import type { PresignGet } from '../lib/r2';
import { requireMember } from './events';
import type { EventStore } from './events';

export interface MediaImagesRecord {
  id: string;
  eventId: string;
  uploaderUserId: string;
  uploadKey: string;
  uploadThumbKey: string;
  publicKey: string | null;
  publicThumbKey: string | null;
  variantVersion: number;
  processedAt: string | null;
  deletedAt: string | null;
}

export interface MediaImagesStore {
  findForServing(eventId: string, mediaIds: string[]): Promise<MediaImagesRecord[]>;
}

const MediaImageDbRow = z.object({
  id: z.uuid(),
  event_id: z.uuid(),
  uploader_user_id: z.uuid(),
  upload_key: z.string(),
  upload_thumb_key: z.string(),
  public_key: z.string().nullable(),
  public_thumb_key: z.string().nullable(),
  variant_version: z.number(),
  processed_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

export function createMediaImagesStore(supabase: Supabase): MediaImagesStore {
  return {
    async findForServing(eventId, mediaIds) {
      if (mediaIds.length === 0) return [];
      const { data, error } = await supabase
        .from('media')
        .select(
          'id, event_id, uploader_user_id, upload_key, upload_thumb_key, public_key, public_thumb_key, variant_version, processed_at, deleted_at',
        )
        .eq('event_id', eventId)
        .in('id', mediaIds)
        .not('processed_at', 'is', null)
        .is('deleted_at', null);

      if (error) throw error;
      const parsed = z.array(MediaImageDbRow).parse(data);
      return parsed.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        uploaderUserId: r.uploader_user_id,
        uploadKey: r.upload_key,
        uploadThumbKey: r.upload_thumb_key,
        publicKey: r.public_key,
        publicThumbKey: r.public_thumb_key,
        variantVersion: r.variant_version,
        processedAt: r.processed_at,
        deletedAt: r.deleted_at,
      }));
    },
  };
}

export interface ServeImagesDeps {
  events: EventStore;
  mediaImages: MediaImagesStore;
  presignGet: PresignGet;
}

// POST /events/{eventId}/media/images (D-57, D-60, D-86, D-148, arch §1, arch §3).
// Serves presigned URLs and versioned cache keys for visible published media.
// Omitted: foreign event rows, unprocessed rows, soft-deleted rows, and other uploaders'
// rows when requested by a Photographer.
export async function serveMediaImages(
  deps: ServeImagesDeps,
  userId: string,
  eventId: string,
  request: MediaImagesRequest,
): Promise<MediaImagesResponse> {
  const role = await requireMember(deps.events, eventId, userId);
  const isPhotographer = role === 'photographer';

  const rows = await deps.mediaImages.findForServing(eventId, request.mediaIds);

  const images: Record<string, PresignedImage> = {};

  for (const row of rows) {
    if (row.processedAt === null || row.deletedAt !== null) {
      continue;
    }

    // A Photographer sees only their own published uploads (arch §1, D-148).
    if (isPhotographer && row.uploaderUserId !== userId) {
      continue;
    }

    const key = request.size === 'thumbnail' ? row.publicThumbKey : row.publicKey;
    if (!key) {
      continue;
    }

    const url = await deps.presignGet(key);
    const cacheKey = `${key}#v${row.variantVersion}`;

    images[row.id] = {
      url,
      cacheKey,
    };
  }

  return { images };
}
