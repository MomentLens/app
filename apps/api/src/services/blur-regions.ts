import { z } from 'zod';

import { MembershipRole } from '@momentlens/shared-types';
import type {
  AddBlurRegionRequest,
  BlurRegion,
  ListBlurRegionsResponse,
} from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
import { ApiError } from '../middleware/errors';
import { toTimestamp } from './events';

// Blur regions (D-83, D-170, spec §4.11.4.4, arch:manual_blur_region). Any active Guest or the
// event's Admin draws one on a photo they can see; its drawer or the Admin removes it. Each change
// enqueues blur_region inside add_blur_region or remove_blur_region, which also make the access
// checks under the event's lock, so a write never runs on a check made before it.

// Whether the caller may use a photo's regions at all: the photo exists, is processed and not
// deleted, its event is not deleted, and the caller is an active member of that event.
export type PhotoAccess =
  | { outcome: 'not_found' }
  | { outcome: 'not_member' }
  | { outcome: 'active'; role: MembershipRole };

export type AddRegionResult =
  | { outcome: 'not_found' | 'not_member' | 'wrong_role' | 'duplicate' }
  | { outcome: 'added' | 'repeat'; role: MembershipRole };

export type RemoveRegionResult =
  | { outcome: 'not_found' | 'not_member' | 'wrong_role' | 'not_drawer' }
  | { outcome: 'removed'; role: MembershipRole; mediaId: string };

export interface BlurRegionStore {
  access(mediaId: string, userId: string): Promise<PhotoAccess>;
  // `drawnBy` null lists every region on the photo; otherwise only that person's.
  list(mediaId: string, drawnBy: string | null): Promise<BlurRegion[]>;
  add(userId: string, mediaId: string, request: AddBlurRegionRequest): Promise<AddRegionResult>;
  remove(regionId: string, userId: string): Promise<RemoveRegionResult>;
}

const AccessRow = z.object({
  role: MembershipRole.nullable(),
  status: z.string().nullable(),
});

// The profile is joined with a left join so a missing one is a 500, not a region left out of the
// list that nobody could then remove. An account with regions cannot be deleted, and its profile
// goes only with it, so a missing profile is a bug.
const RegionRow = z.object({
  id: z.uuid(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  drawn_by_user_id: z.uuid(),
  full_name: z.string().nullable(),
  created_at: z.string().transform(toTimestamp),
});

const AddRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'wrong_role', 'duplicate', 'added', 'repeat']),
  role: MembershipRole.nullable(),
  message_id: z.number().nullable(),
});

const RemoveRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'wrong_role', 'not_drawer', 'removed']),
  role: MembershipRole.nullable(),
  media_id: z.uuid().nullable(),
  message_id: z.number().nullable(),
});

function one<T>(name: string, rows: T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`${name} returned ${rows.length} rows, expected 1`);
  }
  return first;
}

function withRole(name: string, role: MembershipRole | null): MembershipRole {
  if (role === null) throw new Error(`${name} answered success with no role`);
  return role;
}

export function createBlurRegionStore(sql: Sql): BlurRegionStore {
  return {
    async access(mediaId, userId) {
      const rows = await sql`
        select mb.role, mb.status
        from public.media m
        join public.event e on e.id = m.event_id
        left join public.membership mb on mb.event_id = m.event_id and mb.user_id = ${userId}
        where m.id = ${mediaId}
          and m.processed_at is not null
          and m.deleted_at is null
          and e.deleted_at is null`;
      const found = z.array(AccessRow).parse(rows)[0];
      if (found === undefined) return { outcome: 'not_found' };
      if (found.status !== 'active' || found.role === null) return { outcome: 'not_member' };
      return { outcome: 'active', role: found.role };
    },

    async list(mediaId, drawnBy) {
      const rows = await sql`
        select r.id, r.x, r.y, r.width, r.height, r.drawn_by_user_id, p.full_name, r.created_at
        from public.manual_blur_region r
        left join public.profile p on p.user_id = r.drawn_by_user_id
        where r.media_id = ${mediaId}
          and (${drawnBy}::uuid is null or r.drawn_by_user_id = ${drawnBy}::uuid)
        order by r.created_at, r.id`;
      return z
        .array(RegionRow)
        .parse(rows)
        .map((r) => {
          if (r.full_name === null) {
            throw new Error(`Blur region ${r.id} has a drawer with no profile`);
          }
          return {
            id: r.id,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            drawnBy: { userId: r.drawn_by_user_id, fullName: r.full_name },
            createdAt: r.created_at,
          };
        });
    },

    async add(userId, mediaId, request) {
      const rows = await sql`
        select * from public.add_blur_region(
          p_region_id => ${request.id},
          p_media_id => ${mediaId},
          p_user_id => ${userId},
          p_x => ${request.x},
          p_y => ${request.y},
          p_width => ${request.width},
          p_height => ${request.height}
        )`;
      const row = one('add_blur_region', z.array(AddRow).parse(rows));
      if (row.outcome === 'added' || row.outcome === 'repeat') {
        return { outcome: row.outcome, role: withRole('add_blur_region', row.role) };
      }
      return { outcome: row.outcome };
    },

    async remove(regionId, userId) {
      const rows = await sql`
        select * from public.remove_blur_region(
          p_region_id => ${regionId},
          p_user_id => ${userId}
        )`;
      const row = one('remove_blur_region', z.array(RemoveRow).parse(rows));
      if (row.outcome === 'removed') {
        if (row.media_id === null) throw new Error('remove_blur_region removed no photo');
        return {
          outcome: 'removed',
          role: withRole('remove_blur_region', row.role),
          mediaId: row.media_id,
        };
      }
      return { outcome: row.outcome };
    },
  };
}

// A Guest lists their own regions; the Admin lists every region (D-170).
function listFor(
  store: BlurRegionStore,
  mediaId: string,
  userId: string,
  role: MembershipRole,
): Promise<BlurRegion[]> {
  return store.list(mediaId, role === 'admin' ? null : userId);
}

// The refusals the three endpoints share, in the contract's order (blur-region.ts).
function refuse(
  outcome: 'not_found' | 'not_member' | 'wrong_role' | 'duplicate' | 'not_drawer',
): never {
  switch (outcome) {
    case 'not_found':
      throw new ApiError('not_found', 'No such photo or region');
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'wrong_role':
      throw new ApiError('wrong_role', 'A Photographer does not draw blur regions');
    case 'duplicate':
      throw new ApiError('duplicate', 'This region id is already used');
    case 'not_drawer':
      throw new ApiError('not_drawer', 'Only its drawer or the Admin removes a region');
  }
}

// GET /media/{mediaId}/blur-regions
export async function listBlurRegions(
  store: BlurRegionStore,
  userId: string,
  mediaId: string,
): Promise<ListBlurRegionsResponse> {
  const access = await store.access(mediaId, userId);
  if (access.outcome !== 'active') refuse(access.outcome);
  if (access.role === 'photographer') refuse('wrong_role');
  return { regions: await listFor(store, mediaId, userId, access.role) };
}

// POST /media/{mediaId}/blur-regions. `created` is false for a repeat of an id the caller already
// stored on this photo, which changed nothing.
export async function addBlurRegion(
  store: BlurRegionStore,
  userId: string,
  mediaId: string,
  request: AddBlurRegionRequest,
): Promise<{ created: boolean; answer: ListBlurRegionsResponse }> {
  const result = await store.add(userId, mediaId, request);
  if (result.outcome !== 'added' && result.outcome !== 'repeat') refuse(result.outcome);
  return {
    created: result.outcome === 'added',
    answer: { regions: await listFor(store, mediaId, userId, result.role) },
  };
}

// DELETE /blur-regions/{regionId}. Answers the list for the region's photo, as GET would.
export async function removeBlurRegion(
  store: BlurRegionStore,
  userId: string,
  regionId: string,
): Promise<ListBlurRegionsResponse> {
  const result = await store.remove(regionId, userId);
  if (result.outcome !== 'removed') refuse(result.outcome);
  return { regions: await listFor(store, result.mediaId, userId, result.role) };
}
