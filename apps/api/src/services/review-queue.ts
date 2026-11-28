import { z } from 'zod';

import {
  EventName,
  FullName,
  MAX_REVIEW_QUEUE_PAGE,
  MembershipRole,
} from '@momentlens/shared-types';
import type {
  KeepBlurRegionResponse,
  KeepPhotoFlagsResponse,
  ListFlaggedPhotosRequest,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsRequest,
  ListReviewBlurRegionsResponse,
  ReviewBlurRegion,
} from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
import { ApiError } from '../middleware/errors';
import { requireAdmin, toTimestamp } from './events';
import type { EventStore } from './events';

// Admin Review Queue (spec §2.5.7, arch:photo_flag, arch:manual_blur_region, D-181).
// Lists open Guest flags (collapsed per published photo) and open Guest-drawn blur regions
// (newest first, keyset-paginated at 50 per page), and keeps either idempotently.

// Postgres-precision timestamp with timezone offset preserved in keyset cursors so rows sharing
// the same millisecond never fall between pages (as in album.ts).
const PgTimestamp = z.iso.datetime({ offset: true });

export const FlaggedPhotosCursorPayload = z.strictObject({
  kind: z.literal('flags'),
  eventId: z.uuid(),
  latestFlaggedAt: PgTimestamp,
  mediaId: z.uuid(),
});
export type FlaggedPhotosCursorPayload = z.infer<typeof FlaggedPhotosCursorPayload>;

export const ReviewBlurRegionsCursorPayload = z.strictObject({
  kind: z.literal('blur-regions'),
  eventId: z.uuid(),
  createdAt: PgTimestamp,
  regionId: z.uuid(),
});
export type ReviewBlurRegionsCursorPayload = z.infer<typeof ReviewBlurRegionsCursorPayload>;

function encodeCursor(
  payload: FlaggedPhotosCursorPayload | ReviewBlurRegionsCursorPayload,
): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor<T extends z.ZodType>(token: string, schema: T): z.infer<T> {
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('Noncanonical token');
    return schema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    throw new ApiError('invalid_request', 'Invalid cursor');
  }
}

export function encodeFlaggedPhotosCursor(payload: FlaggedPhotosCursorPayload): string {
  return encodeCursor(payload);
}

export function decodeFlaggedPhotosCursor(token: string): FlaggedPhotosCursorPayload {
  return decodeCursor(token, FlaggedPhotosCursorPayload);
}

export function encodeReviewBlurRegionsCursor(payload: ReviewBlurRegionsCursorPayload): string {
  return encodeCursor(payload);
}

export function decodeReviewBlurRegionsCursor(token: string): ReviewBlurRegionsCursorPayload {
  return decodeCursor(token, ReviewBlurRegionsCursorPayload);
}

export interface FlaggedPhotoRow {
  media: {
    id: string;
    subEventId: string;
    capturedAt: string;
    uploaderUserId: string;
    uploaderName: string;
    uploaderRole: MembershipRole;
    width: number | null;
    height: number | null;
    variantVersion: number;
  };
  subEventName: string;
  flagCount: number;
  latestFlaggedAt: string;
}

export interface FlaggedPhotosPage {
  openCount: number;
  rows: FlaggedPhotoRow[];
}

export type KeepPhotoFlagsResult =
  { outcome: 'not_found' | 'not_member' | 'wrong_role' } | { outcome: 'kept'; keptCount: number };

export interface ReviewBlurRegionRow {
  region: ReviewBlurRegion['region'];
  media: ReviewBlurRegion['media'];
}

export interface ReviewBlurRegionsPage {
  openCount: number;
  rows: ReviewBlurRegionRow[];
}

export interface KeepBlurRegionResult {
  outcome: 'not_found' | 'not_member' | 'wrong_role' | 'kept';
}

export interface ReviewQueueStore {
  listFlags(
    eventId: string,
    options: {
      cursor?: { latestFlaggedAt: string; mediaId: string };
      limit: number;
    },
  ): Promise<FlaggedPhotosPage>;

  keepPhotoFlags(mediaId: string, userId: string): Promise<KeepPhotoFlagsResult>;

  listBlurRegions(
    eventId: string,
    options: {
      cursor?: { createdAt: string; regionId: string };
      limit: number;
    },
  ): Promise<ReviewBlurRegionsPage>;

  keepBlurRegion(regionId: string, userId: string): Promise<KeepBlurRegionResult>;
}

const FlaggedQueryResult = z.object({
  open_count: z.number(),
  rows: z.array(
    z.object({
      id: z.uuid(),
      sub_event_id: z.uuid(),
      captured_at: PgTimestamp,
      uploader_user_id: z.uuid(),
      uploader_name: FullName.nullable(),
      uploader_role: MembershipRole,
      width: z.number().nullable(),
      height: z.number().nullable(),
      variant_version: z.number(),
      sub_event_name: EventName,
      flag_count: z.number(),
      latest_flagged_at: PgTimestamp,
    }),
  ),
});

const BlurRegionsQueryResult = z.object({
  open_count: z.number(),
  rows: z.array(
    z.object({
      region_id: z.uuid(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      drawn_by_user_id: z.uuid(),
      drawer_name: FullName.nullable(),
      created_at: PgTimestamp,
      media_id: z.uuid(),
      media_width: z.number().nullable(),
      media_height: z.number().nullable(),
      variant_version: z.number(),
    }),
  ),
});

const KeepFlagsRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'wrong_role', 'kept']),
  kept_count: z.number(),
});

const KeepRegionRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'wrong_role', 'kept']),
});

function one<T>(name: string, rows: T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`${name} returned ${rows.length} rows, expected 1`);
  }
  return first;
}

export function createReviewQueueStore(sql: Sql): ReviewQueueStore {
  return {
    async listFlags(eventId, options) {
      const afterLatestFlaggedAt = options.cursor?.latestFlaggedAt ?? null;
      const afterMediaId = options.cursor?.mediaId ?? null;
      const rows = await sql`
        with flagged as (
          select
            m.id,
            m.sub_event_id,
            m.captured_at,
            m.uploader_user_id,
            p.full_name as uploader_name,
            m.uploader_role_at_upload,
            m.width,
            m.height,
            m.variant_version,
            se.name as sub_event_name,
            count(*)::int as flag_count,
            max(pf.created_at) as latest_flagged_at
          from public.photo_flag pf
          join public.media m on m.id = pf.media_id
          join public.sub_event se on se.id = m.sub_event_id and se.event_id = m.event_id
          left join public.profile p on p.user_id = m.uploader_user_id
          where pf.state = 'open'
            and m.event_id = ${eventId}
            and m.processed_at is not null
            and m.deleted_at is null
          group by
            m.id,
            m.sub_event_id,
            m.captured_at,
            m.uploader_user_id,
            p.full_name,
            m.uploader_role_at_upload,
            m.width,
            m.height,
            m.variant_version,
            se.name
        ),
        total as (
          select count(*)::int as open_count from flagged
        ),
        page as (
          select *
          from flagged f
          where (
            ${afterLatestFlaggedAt}::timestamptz is null
            or (f.latest_flagged_at, f.id) < (${afterLatestFlaggedAt}::timestamptz, ${afterMediaId}::uuid)
          )
          order by f.latest_flagged_at desc, f.id desc
          limit ${options.limit + 1}
        )
        select
          (select open_count from total) as open_count,
          coalesce(
            (
              select jsonb_agg(
                jsonb_build_object(
                  'id', p.id,
                  'sub_event_id', p.sub_event_id,
                  'captured_at', p.captured_at,
                  'uploader_user_id', p.uploader_user_id,
                  'uploader_name', p.uploader_name,
                  'uploader_role', p.uploader_role_at_upload,
                  'width', p.width,
                  'height', p.height,
                  'variant_version', p.variant_version,
                  'sub_event_name', p.sub_event_name,
                  'flag_count', p.flag_count,
                  'latest_flagged_at', p.latest_flagged_at
                )
                order by p.latest_flagged_at desc, p.id desc
              )
              from page p
            ),
            '[]'::jsonb
          ) as rows`;

      const row = one('list_review_queue_flags', rows);
      const parsed = FlaggedQueryResult.parse(row);
      return {
        openCount: parsed.open_count,
        rows: parsed.rows.map((r) => {
          if (r.uploader_name === null) {
            throw new Error(`Flagged photo ${r.id} has an uploader with no profile`);
          }
          return {
            media: {
              id: r.id,
              subEventId: r.sub_event_id,
              capturedAt: r.captured_at,
              uploaderUserId: r.uploader_user_id,
              uploaderName: r.uploader_name,
              uploaderRole: r.uploader_role,
              width: r.width,
              height: r.height,
              variantVersion: r.variant_version,
            },
            subEventName: r.sub_event_name,
            flagCount: r.flag_count,
            latestFlaggedAt: r.latest_flagged_at,
          };
        }),
      };
    },

    async keepPhotoFlags(mediaId, userId) {
      const rows = await sql`
        select * from public.keep_photo_flags(
          p_media_id => ${mediaId},
          p_user_id => ${userId}
        )`;
      const row = one('keep_photo_flags', z.array(KeepFlagsRow).parse(rows));
      if (row.outcome === 'kept') {
        return { outcome: 'kept', keptCount: row.kept_count };
      }
      return { outcome: row.outcome };
    },

    async listBlurRegions(eventId, options) {
      const afterCreatedAt = options.cursor?.createdAt ?? null;
      const afterRegionId = options.cursor?.regionId ?? null;
      const rows = await sql`
        with open_regions as (
          select
            r.id as region_id,
            r.x,
            r.y,
            r.width,
            r.height,
            r.drawn_by_user_id,
            p.full_name as drawer_name,
            r.created_at,
            m.id as media_id,
            m.width as media_width,
            m.height as media_height,
            m.variant_version
          from public.manual_blur_region r
          join public.media m on m.id = r.media_id
          left join public.profile p on p.user_id = r.drawn_by_user_id
          where r.state = 'open'
            and m.event_id = ${eventId}
            and m.processed_at is not null
            and m.deleted_at is null
        ),
        total as (
          select count(*)::int as open_count from open_regions
        ),
        page as (
          select *
          from open_regions o
          where (
            ${afterCreatedAt}::timestamptz is null
            or (o.created_at, o.region_id) < (${afterCreatedAt}::timestamptz, ${afterRegionId}::uuid)
          )
          order by o.created_at desc, o.region_id desc
          limit ${options.limit + 1}
        )
        select
          (select open_count from total) as open_count,
          coalesce(
            (
              select jsonb_agg(
                jsonb_build_object(
                  'region_id', p.region_id,
                  'x', p.x,
                  'y', p.y,
                  'width', p.width,
                  'height', p.height,
                  'drawn_by_user_id', p.drawn_by_user_id,
                  'drawer_name', p.drawer_name,
                  'created_at', p.created_at,
                  'media_id', p.media_id,
                  'media_width', p.media_width,
                  'media_height', p.media_height,
                  'variant_version', p.variant_version
                )
                order by p.created_at desc, p.region_id desc
              )
              from page p
            ),
            '[]'::jsonb
          ) as rows`;

      const row = one('list_review_queue_blur_regions', rows);
      const parsed = BlurRegionsQueryResult.parse(row);
      return {
        openCount: parsed.open_count,
        rows: parsed.rows.map((r) => {
          if (r.drawer_name === null) {
            throw new Error(`Blur region ${r.region_id} has a drawer with no profile`);
          }
          return {
            region: {
              id: r.region_id,
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              drawnBy: {
                userId: r.drawn_by_user_id,
                fullName: r.drawer_name,
              },
              createdAt: r.created_at,
            },
            media: {
              id: r.media_id,
              width: r.media_width,
              height: r.media_height,
              variantVersion: r.variant_version,
            },
          };
        }),
      };
    },

    async keepBlurRegion(regionId, userId) {
      const rows = await sql`
        select * from public.keep_blur_region(
          p_region_id => ${regionId},
          p_user_id => ${userId}
        )`;
      return one('keep_blur_region', z.array(KeepRegionRow).parse(rows));
    },
  };
}

const ADMIN_REFUSAL = "Only the event's Admin can access the Review Queue";

// GET /events/{eventId}/review-queue/flags
export async function listFlaggedPhotos(
  events: EventStore,
  store: ReviewQueueStore,
  eventId: string,
  userId: string,
  request: ListFlaggedPhotosRequest,
): Promise<ListFlaggedPhotosResponse> {
  let cursor: { latestFlaggedAt: string; mediaId: string } | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeFlaggedPhotosCursor(request.cursor);
    if (decoded.eventId !== eventId) {
      throw new ApiError('invalid_request', 'Cursor event mismatch');
    }
    cursor = { latestFlaggedAt: decoded.latestFlaggedAt, mediaId: decoded.mediaId };
  }

  await requireAdmin(events, eventId, userId, ADMIN_REFUSAL);

  const page = await store.listFlags(eventId, { cursor, limit: MAX_REVIEW_QUEUE_PAGE });
  const hasNextPage = page.rows.length > MAX_REVIEW_QUEUE_PAGE;
  const items = hasNextPage ? page.rows.slice(0, MAX_REVIEW_QUEUE_PAGE) : page.rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasNextPage && last !== undefined
      ? encodeFlaggedPhotosCursor({
          kind: 'flags',
          eventId,
          latestFlaggedAt: last.latestFlaggedAt,
          mediaId: last.media.id,
        })
      : null;

  return {
    photos: items.map((item) => ({
      media: {
        ...item.media,
        capturedAt: toTimestamp(item.media.capturedAt),
      },
      subEventName: item.subEventName,
      flagCount: item.flagCount,
      latestFlaggedAt: toTimestamp(item.latestFlaggedAt),
    })),
    openCount: page.openCount,
    nextCursor,
  };
}

// POST /media/{mediaId}/flags/keep
export async function keepPhotoFlags(
  store: ReviewQueueStore,
  userId: string,
  mediaId: string,
): Promise<KeepPhotoFlagsResponse> {
  const result = await store.keepPhotoFlags(mediaId, userId);
  switch (result.outcome) {
    case 'not_found':
      throw new ApiError('not_found', 'No such photo');
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'wrong_role':
      throw new ApiError('wrong_role', ADMIN_REFUSAL);
    case 'kept':
      return { mediaId, keptCount: result.keptCount };
  }
}

// GET /events/{eventId}/review-queue/blur-regions
export async function listReviewBlurRegions(
  events: EventStore,
  store: ReviewQueueStore,
  eventId: string,
  userId: string,
  request: ListReviewBlurRegionsRequest,
): Promise<ListReviewBlurRegionsResponse> {
  let cursor: { createdAt: string; regionId: string } | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeReviewBlurRegionsCursor(request.cursor);
    if (decoded.eventId !== eventId) {
      throw new ApiError('invalid_request', 'Cursor event mismatch');
    }
    cursor = { createdAt: decoded.createdAt, regionId: decoded.regionId };
  }

  await requireAdmin(events, eventId, userId, ADMIN_REFUSAL);

  const page = await store.listBlurRegions(eventId, { cursor, limit: MAX_REVIEW_QUEUE_PAGE });
  const hasNextPage = page.rows.length > MAX_REVIEW_QUEUE_PAGE;
  const items = hasNextPage ? page.rows.slice(0, MAX_REVIEW_QUEUE_PAGE) : page.rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasNextPage && last !== undefined
      ? encodeReviewBlurRegionsCursor({
          kind: 'blur-regions',
          eventId,
          createdAt: last.region.createdAt,
          regionId: last.region.id,
        })
      : null;

  return {
    regions: items.map((item) => ({
      region: {
        ...item.region,
        createdAt: toTimestamp(item.region.createdAt),
      },
      media: item.media,
    })),
    openCount: page.openCount,
    nextCursor,
  };
}

// POST /blur-regions/{regionId}/keep
export async function keepBlurRegion(
  store: ReviewQueueStore,
  userId: string,
  regionId: string,
): Promise<KeepBlurRegionResponse> {
  const result = await store.keepBlurRegion(regionId, userId);
  switch (result.outcome) {
    case 'not_found':
      throw new ApiError('not_found', 'No such blur region');
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'wrong_role':
      throw new ApiError('wrong_role', ADMIN_REFUSAL);
    case 'kept':
      return { regionId, state: 'kept' };
  }
}
