import { z } from 'zod';

import { FullName } from '@momentlens/shared-types';
import type {
  ListPeopleResponse,
  ListPhotoFacesResponse,
  PhotoFace,
} from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
import { ApiError } from '../middleware/errors';
import { requireMember } from './events';
import type { EventStore } from './events';

// The People half of the filter sheet and the Recognized Faces strip (spec §2.5.2, §2.5.6,
// D-176). Which matched faces a viewer may see is one SQL rule, face_hidden, that list_people and
// list_photo_faces both call, so this file never decides it. It passes the caller from the session
// as the viewer and nothing from the request (root invariant 4).

export interface PersonRecord {
  userId: string;
  fullName: string;
  photoCount: number;
}

export interface FaceStore {
  // Active members with a face matched in a published photo of the event, as this viewer may see
  // them.
  people(eventId: string, viewerId: string): Promise<PersonRecord[]>;

  // Each identity in one photo, left to right, as this viewer may see them. Null when the photo is
  // not a published, undeleted photo of this event.
  photoFaces(eventId: string, mediaId: string, viewerId: string): Promise<PhotoFace[] | null>;
}

const ListPeopleRpcResult = z.object({
  people: z.array(
    z.object({
      user_id: z.uuid(),
      full_name: FullName,
      photo_count: z.int().positive(),
    }),
  ),
});

const ListPhotoFacesRpcResult = z
  .object({
    faces: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('person'), user_id: z.uuid(), full_name: FullName }),
        z.object({ kind: z.literal('unknown'), cluster_id: z.uuid() }),
      ]),
    ),
  })
  .nullable();

export function createFaceStore(sql: Sql): FaceStore {
  return {
    async people(eventId, viewerId) {
      const [row] = await sql`
        select public.list_people(p_event_id => ${eventId}, p_viewer_id => ${viewerId}) as result`;
      return ListPeopleRpcResult.parse(row?.result).people.map((p) => ({
        userId: p.user_id,
        fullName: p.full_name,
        photoCount: p.photo_count,
      }));
    },

    async photoFaces(eventId, mediaId, viewerId) {
      const [row] = await sql`
        select public.list_photo_faces(
          p_event_id => ${eventId},
          p_media_id => ${mediaId},
          p_viewer_id => ${viewerId}
        ) as result`;
      const parsed = ListPhotoFacesRpcResult.parse(row?.result ?? null);
      if (parsed === null) return null;
      return parsed.faces.map((f) =>
        f.kind === 'person'
          ? { kind: 'person', userId: f.user_id, fullName: f.full_name }
          : { kind: 'unknown', clusterId: f.cluster_id },
      );
    },
  };
}

// The album's readers only: a Photographer sees no other member's name, because the name list is
// the guest list (D-08), and has no album (spec §4.10).
async function requireAlbumReader(
  events: EventStore,
  eventId: string,
  userId: string,
  refusal: string,
): Promise<void> {
  if ((await requireMember(events, eventId, userId)) === 'photographer') {
    throw new ApiError('wrong_role', refusal);
  }
}

export async function listPeople(
  events: EventStore,
  store: FaceStore,
  eventId: string,
  userId: string,
): Promise<ListPeopleResponse> {
  await requireAlbumReader(events, eventId, userId, 'Photographers cannot list people');
  const records = await store.people(eventId, userId);
  // No avatar until S-29 presigns one through the avatar function (D-143).
  return { people: records.map((r) => ({ ...r, avatar: null })) };
}

export async function listPhotoFaces(
  events: EventStore,
  store: FaceStore,
  eventId: string,
  mediaId: string,
  userId: string,
): Promise<ListPhotoFacesResponse> {
  await requireAlbumReader(events, eventId, userId, 'Photographers cannot see recognized faces');
  const faces = await store.photoFaces(eventId, mediaId, userId);
  if (faces === null) {
    throw new ApiError('not_found', 'Photo not found');
  }
  return { faces };
}
