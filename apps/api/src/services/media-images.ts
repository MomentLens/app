import { z } from 'zod';

import type { MediaImage, MediaImagesRequest, MediaImagesResponse } from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
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
  // The requester's own file and thumbnail from the dnp_subject row whose subject belongs to them,
  // both null when they are not a subject in this photo (D-57, hb §5.2).
  variantKey: string | null;
  variantThumbKey: string | null;
}

export interface MediaImagesStore {
  // userId is the authenticated requester, never a value the client sent (root invariant 3).
  findForServing(eventId: string, mediaIds: string[], userId: string): Promise<MediaImagesRecord[]>;
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
  variant_key: z.string().nullable(),
  variant_thumb_key: z.string().nullable(),
});

export function createMediaImagesStore(sql: Sql): MediaImagesStore {
  return {
    async findForServing(eventId, mediaIds, userId) {
      if (mediaIds.length === 0) return [];
      // The requester's own dnp_subject row, if any. dnp_subject.subject_id points at subject,
      // whose user_id is its own column, so the match is on subject.user_id (D-63). The primary key
      // (media_id, subject_id) and subject's unique user_id leave at most one row per photo.
      const rows = await sql`
        select m.id, m.event_id, m.uploader_user_id, m.upload_key, m.upload_thumb_key,
          m.public_key, m.public_thumb_key, m.variant_version, m.processed_at, m.deleted_at,
          own.variant_key, own.variant_thumb_key
        from public.media m
        left join lateral (
          select d.variant_key, d.variant_thumb_key
          from public.dnp_subject d
          join public.subject s on s.id = d.subject_id
          where d.media_id = m.id and s.user_id = ${userId}
        ) own on true
        where m.event_id = ${eventId}
          and m.id = any(${mediaIds}::uuid[])
          and m.processed_at is not null
          and m.deleted_at is null`;
      const parsed = z.array(MediaImageDbRow).parse(rows);
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
        variantKey: r.variant_key,
        variantThumbKey: r.variant_thumb_key,
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
// Serves presigned URLs and versioned cache keys for visible published media: the requester's own
// Do Not Publish file when they are a subject in the photo, the public file otherwise.
// Omitted: foreign event rows, unprocessed rows, soft-deleted rows, and other uploaders'
// rows when requested by a Photographer. The visibility check comes first; being a subject says
// which file, never whether the requester may have one (hb §5.2).
export async function serveMediaImages(
  deps: ServeImagesDeps,
  userId: string,
  eventId: string,
  request: MediaImagesRequest,
): Promise<MediaImagesResponse> {
  const role = await requireMember(deps.events, eventId, userId);
  const isPhotographer = role === 'photographer';

  const rows = await deps.mediaImages.findForServing(eventId, request.mediaIds, userId);

  const images: Record<string, MediaImage> = {};

  for (const row of rows) {
    if (row.processedAt === null || row.deletedAt !== null) {
      continue;
    }

    // A Photographer sees only their own published uploads (arch §1, D-148).
    if (isPhotographer && row.uploaderUserId !== userId) {
      continue;
    }

    // Both keys come from columns the worker wrote; nothing here builds a derived key (root
    // invariant 12). A subject's row always carries both files, so a thumbnail never falls back
    // to the public one while the full size is theirs.
    const isOwnVariant = row.variantKey !== null && row.variantThumbKey !== null;
    const key = isOwnVariant
      ? request.size === 'thumbnail'
        ? row.variantThumbKey
        : row.variantKey
      : request.size === 'thumbnail'
        ? row.publicThumbKey
        : row.publicKey;
    if (!key) {
      continue;
    }

    const url = await deps.presignGet(key);
    // The signed key plus variant_version, so a regeneration reaches phones as a new cache entry
    // (root invariant 2, D-86, D-148).
    const cacheKey = `${key}#v${row.variantVersion}`;

    images[row.id] = { url, cacheKey, isOwnVariant };
  }

  return { images };
}
