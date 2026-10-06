import { z } from 'zod';

import { FullName, MAX_ALBUM_PAGE, MembershipRole } from '@momentlens/shared-types';
import type {
  ListAlbumRequest,
  ListAlbumResponse,
  ListUploadersResponse,
  SectionCount,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { ApiError } from '../middleware/errors';
import { requireMember, toTimestamp } from './events';
import type { EventStore } from './events';

// A timestamp exactly as Postgres wrote it, microseconds and offset included. The cursor carries
// the last row's values unchanged, because list_album compares them with the columns themselves:
// cut to the API's milliseconds, a row captured later in the same millisecond would fall between
// two pages, and a sub-event starting part-way through one would restart its section.
const PgTimestamp = z.iso.datetime({ offset: true });

export const CursorPayload = z.strictObject({
  eventId: z.uuid(),
  subEventId: z.uuid().nullable(),
  uploaderId: z.uuid().nullable(),
  startsAt: PgTimestamp,
  subEventIdRow: z.uuid(),
  capturedAt: PgTimestamp,
  mediaId: z.uuid(),
});
export type CursorPayload = z.infer<typeof CursorPayload>;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(token: string): CursorPayload {
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('Noncanonical token');
    return CursorPayload.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    throw new ApiError('invalid_request', 'Invalid cursor');
  }
}

export interface AlbumMediaRow {
  id: string;
  subEventId: string;
  capturedAt: string;
  uploaderRole: MembershipRole;
  width: number | null;
  height: number | null;
  variantVersion: number;
  startsAt: string;
}

export interface AlbumQueryResult {
  media: AlbumMediaRow[];
  sectionCounts: SectionCount[] | null;
}

export interface UploaderRecord {
  userId: string;
  fullName: string;
  role: MembershipRole;
  photoCount: number;
}

// Where the next page starts: the last row of the page before it, as Postgres wrote it.
export interface AlbumCursor {
  startsAt: string;
  subEventIdRow: string;
  capturedAt: string;
  mediaId: string;
}

export interface AlbumStore {
  query(
    eventId: string,
    options: {
      subEventId?: string;
      uploaderId?: string;
      cursor?: AlbumCursor;
      limit: number;
    },
  ): Promise<AlbumQueryResult>;

  uploaders(eventId: string): Promise<UploaderRecord[]>;
}

const ListAlbumRpcResult = z.object({
  media: z.array(
    z.object({
      id: z.uuid(),
      sub_event_id: z.uuid(),
      captured_at: PgTimestamp,
      uploader_role: MembershipRole,
      width: z.number().nullable(),
      height: z.number().nullable(),
      variant_version: z.number(),
      starts_at: PgTimestamp,
    }),
  ),
  section_counts: z
    .array(
      z.object({
        sub_event_id: z.uuid(),
        count: z.number(),
      }),
    )
    .nullable(),
});

const ListUploadersRpcResult = z.object({
  uploaders: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: FullName,
      role: MembershipRole,
      photo_count: z.number(),
    }),
  ),
});

export function createAlbumStore(supabase: Supabase): AlbumStore {
  return {
    async query(eventId, options) {
      const result = await supabase.rpc('list_album', {
        p_event_id: eventId,
        p_sub_event_id: options.subEventId ?? null,
        p_uploader_id: options.uploaderId ?? null,
        p_after_starts_at: options.cursor?.startsAt ?? null,
        p_after_sub_event_id: options.cursor?.subEventIdRow ?? null,
        p_after_captured_at: options.cursor?.capturedAt ?? null,
        p_after_media_id: options.cursor?.mediaId ?? null,
        p_limit: options.limit,
      });
      if (result.error) throw result.error;
      const parsed = ListAlbumRpcResult.parse(result.data as unknown);
      return {
        media: parsed.media.map((m) => ({
          id: m.id,
          subEventId: m.sub_event_id,
          capturedAt: m.captured_at,
          uploaderRole: m.uploader_role,
          width: m.width,
          height: m.height,
          variantVersion: m.variant_version,
          startsAt: m.starts_at,
        })),
        sectionCounts: parsed.section_counts
          ? parsed.section_counts.map((sc) => ({
              subEventId: sc.sub_event_id,
              count: sc.count,
            }))
          : null,
      };
    },

    async uploaders(eventId) {
      const result = await supabase.rpc('list_uploaders', {
        p_event_id: eventId,
      });
      if (result.error) throw result.error;
      const parsed = ListUploadersRpcResult.parse(result.data as unknown);
      return parsed.uploaders.map((u) => ({
        userId: u.user_id,
        fullName: u.full_name,
        role: u.role,
        photoCount: u.photo_count,
      }));
    },
  };
}

export async function listAlbum(
  events: EventStore,
  store: AlbumStore,
  eventId: string,
  userId: string,
  request: ListAlbumRequest,
): Promise<ListAlbumResponse> {
  const role = await requireMember(events, eventId, userId);
  if (role === 'photographer') {
    throw new ApiError('wrong_role', 'Photographers cannot access the album');
  }

  let cursorPayload: CursorPayload | undefined;
  if (request.cursor) {
    cursorPayload = decodeCursor(request.cursor);
    if (
      cursorPayload.eventId !== eventId ||
      cursorPayload.subEventId !== (request.subEventId ?? null) ||
      cursorPayload.uploaderId !== (request.uploaderId ?? null)
    ) {
      throw new ApiError('invalid_request', 'Cursor filters mismatch');
    }
  }

  const result = await store.query(eventId, {
    subEventId: request.subEventId,
    uploaderId: request.uploaderId,
    cursor: cursorPayload
      ? {
          startsAt: cursorPayload.startsAt,
          subEventIdRow: cursorPayload.subEventIdRow,
          capturedAt: cursorPayload.capturedAt,
          mediaId: cursorPayload.mediaId,
        }
      : undefined,
    limit: MAX_ALBUM_PAGE,
  });

  const hasNextPage = result.media.length > MAX_ALBUM_PAGE;
  const pageItems = hasNextPage ? result.media.slice(0, MAX_ALBUM_PAGE) : result.media;

  let nextCursor: string | null = null;
  const lastItem = pageItems[pageItems.length - 1];
  if (hasNextPage && lastItem !== undefined) {
    nextCursor = encodeCursor({
      eventId,
      subEventId: request.subEventId ?? null,
      uploaderId: request.uploaderId ?? null,
      startsAt: lastItem.startsAt,
      subEventIdRow: lastItem.subEventId,
      capturedAt: lastItem.capturedAt,
      mediaId: lastItem.id,
    });
  }

  return {
    media: pageItems.map((item) => ({
      id: item.id,
      subEventId: item.subEventId,
      capturedAt: toTimestamp(item.capturedAt),
      uploaderRole: item.uploaderRole,
      width: item.width,
      height: item.height,
      variantVersion: item.variantVersion,
    })),
    sectionCounts: result.sectionCounts,
    nextCursor,
  };
}

export async function listUploaders(
  events: EventStore,
  store: AlbumStore,
  eventId: string,
  userId: string,
): Promise<ListUploadersResponse> {
  const role = await requireMember(events, eventId, userId);
  if (role === 'photographer') {
    throw new ApiError('wrong_role', 'Photographers cannot access uploaders');
  }

  const records = await store.uploaders(eventId);
  return {
    uploaders: records.map((r) => ({
      userId: r.userId,
      fullName: r.fullName,
      role: r.role,
      photoCount: r.photoCount,
      avatar: null,
    })),
  };
}
