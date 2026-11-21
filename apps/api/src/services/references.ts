import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import {
  MAX_REFERENCES_PER_EVENT,
  ReferenceRejectReason,
  ReferenceStatus,
} from '@momentlens/shared-types';
import type {
  CreateReferenceUploadResponse,
  ListReferencesResponse,
} from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
import { referenceKey } from '../lib/keys';
import type { DeleteObject, ObjectExists, PresignGet, PresignPut } from '../lib/r2';
import { ApiError } from '../middleware/errors';
import { requireMember, toTimestamp } from './events';
import type { EventStore } from './events';

// Reference photos, one person's in one event (spec §4.2, D-91, D-141, D-172,
// arch:face_reference). Every endpoint answers about the caller's own rows in the path's event and
// nobody else's, so a reference is presigned for its owner alone, the Admin included (arch §3).
// The embedding is never read here; it stays in the database and the worker.

// One of the caller's references as the list reads it, before its photo is presigned.
export interface ReferenceRecord {
  id: string;
  status: ReferenceStatus;
  rejectReason: ReferenceRejectReason | null;
  photoKey: string;
  createdAt: string;
}

// Who a reference id belongs to: the subject's user and the event.
export interface ReferenceOwner {
  userId: string | null;
  eventId: string;
}

// add_face_reference's outcomes, checked under the event's share lock and the subject's row lock.
// `taken` is an id already used by another person or another event.
export type AddReferenceOutcome =
  'not_found' | 'not_member' | 'taken' | 'repeat' | 'too_many' | 'added';

export type RemoveReferenceResult =
  { outcome: 'not_found' | 'not_member' } | { outcome: 'removed'; photoKey: string };

export interface ReferenceStore {
  // The caller's references in this event, of every status, by created_at, then id.
  list(eventId: string, userId: string): Promise<ReferenceRecord[]>;
  // How many of the caller's references in this event are not rejected.
  countKept(eventId: string, userId: string): Promise<number>;
  // Null when no row has this id.
  findOwner(referenceId: string): Promise<ReferenceOwner | null>;
  // One add_face_reference call: the pending row and its reference_process message.
  add(
    referenceId: string,
    eventId: string,
    userId: string,
    photoKey: string,
  ): Promise<AddReferenceOutcome>;
  // One delete_face_reference call. `removed` carries the deleted row's key, for R2.
  remove(referenceId: string, eventId: string, userId: string): Promise<RemoveReferenceResult>;
}

const ListRow = z.object({
  id: z.uuid(),
  status: ReferenceStatus,
  reject_reason: ReferenceRejectReason.nullable(),
  photo_key: z.string(),
  created_at: z.string().transform(toTimestamp),
});

const OwnerRow = z.object({ user_id: z.uuid().nullable(), event_id: z.uuid() });

const AddRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'taken', 'repeat', 'too_many', 'added']),
  message_id: z.number().nullable(),
});

const RemoveRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'removed']),
  photo_key: z.string().nullable(),
});

function one<T>(name: string, rows: T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`${name} returned ${rows.length} rows, expected 1`);
  }
  return first;
}

export function createReferenceStore(sql: Sql): ReferenceStore {
  return {
    async list(eventId, userId) {
      // face_reference_subject_event_idx covers the filter and the order.
      const rows = await sql`
        select fr.id, fr.status, fr.reject_reason, fr.photo_key, fr.created_at
        from public.face_reference fr
        join public.subject s on s.id = fr.subject_id
        where s.user_id = ${userId} and fr.event_id = ${eventId}
        order by fr.created_at, fr.id`;
      return z
        .array(ListRow)
        .parse(rows)
        .map((r) => ({
          id: r.id,
          status: r.status,
          rejectReason: r.reject_reason,
          photoKey: r.photo_key,
          createdAt: r.created_at,
        }));
    },

    async countKept(eventId, userId) {
      const rows = await sql`
        select count(*)::int as kept
        from public.face_reference fr
        join public.subject s on s.id = fr.subject_id
        where s.user_id = ${userId} and fr.event_id = ${eventId} and fr.status <> 'rejected'`;
      return one('countKept', z.array(z.object({ kept: z.number().int() })).parse(rows)).kept;
    },

    async findOwner(referenceId) {
      const rows = await sql`
        select s.user_id, fr.event_id
        from public.face_reference fr
        join public.subject s on s.id = fr.subject_id
        where fr.id = ${referenceId}`;
      const [row] = z.array(OwnerRow).parse(rows);
      return row === undefined ? null : { userId: row.user_id, eventId: row.event_id };
    },

    async add(referenceId, eventId, userId, photoKey) {
      const rows = await sql`
        select * from public.add_face_reference(
          p_reference_id => ${referenceId},
          p_event_id => ${eventId},
          p_user_id => ${userId},
          p_photo_key => ${photoKey}
        )`;
      const row = one('add_face_reference', z.array(AddRow).parse(rows));
      if (row.outcome === 'added' && row.message_id === null) {
        throw new Error('add_face_reference added a reference with no reference_process message');
      }
      return row.outcome;
    },

    async remove(referenceId, eventId, userId) {
      const rows = await sql`
        select * from public.delete_face_reference(
          p_reference_id => ${referenceId},
          p_event_id => ${eventId},
          p_user_id => ${userId}
        )`;
      const row = one('delete_face_reference', z.array(RemoveRow).parse(rows));
      if (row.outcome === 'removed') {
        if (row.photo_key === null) throw new Error('delete_face_reference removed no photo key');
        return { outcome: 'removed', photoKey: row.photo_key };
      }
      return { outcome: row.outcome };
    },
  };
}

export interface ReferenceDeps {
  events: EventStore;
  references: ReferenceStore;
  presignGet: PresignGet;
  presignPut: PresignPut;
  objectExists: ObjectExists;
  deleteObject: DeleteObject;
  logger: Logger;
}

const NOT_FOUND = 'No such reference photo in this event';
const TOO_MANY = `At most ${MAX_REFERENCES_PER_EVENT} reference photos in one event`;

// The caller's list, each photo presigned for them. Every caller of this has already checked the
// caller is an active member of the event, and the list holds the caller's rows only.
async function listFor(
  deps: ReferenceDeps,
  eventId: string,
  userId: string,
): Promise<ListReferencesResponse> {
  const rows = await deps.references.list(eventId, userId);
  return {
    references: await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        status: r.status,
        rejectReason: r.rejectReason,
        // The key carries the reference's own id, so it is the cache key (reference.ts).
        image: { url: await deps.presignGet(r.photoKey), cacheKey: r.photoKey },
        createdAt: r.createdAt,
      })),
    ),
  };
}

// GET /events/{eventId}/references
export async function listReferences(
  deps: ReferenceDeps,
  userId: string,
  eventId: string,
): Promise<ListReferencesResponse> {
  await requireMember(deps.events, eventId, userId);
  return listFor(deps, eventId, userId);
}

// POST /events/{eventId}/references/upload. A presigned PUT for a new key, and nothing written.
// The count here has no lock; PUT counts again inside add_face_reference under one (D-95).
export async function startReferenceUpload(
  deps: ReferenceDeps,
  userId: string,
  eventId: string,
): Promise<CreateReferenceUploadResponse> {
  await requireMember(deps.events, eventId, userId);
  if ((await deps.references.countKept(eventId, userId)) >= MAX_REFERENCES_PER_EVENT) {
    throw new ApiError('too_many_references', TOO_MANY);
  }
  const uploadId = randomUUID();
  return {
    uploadId,
    uploadUrl: await deps.presignPut(referenceKey(userId, eventId, uploadId), 'image/jpeg'),
  };
}

// PUT /events/{eventId}/references/{uploadId}. `created` is false for a repeat, which answers 200.
//
// The id is looked up before the HEAD, so a resend after a lost answer needs no object and an id
// someone else holds answers 404 as the contract says, not 409. The key is built from the caller,
// the path's event and the id, never read from the client (root invariant 12), so another user's
// uploadId points into the caller's own folder and finds nothing there.
export async function addReference(
  deps: ReferenceDeps,
  userId: string,
  eventId: string,
  referenceId: string,
): Promise<{ created: boolean; response: ListReferencesResponse }> {
  await requireMember(deps.events, eventId, userId);
  const owner = await deps.references.findOwner(referenceId);
  if (owner !== null) {
    if (owner.userId !== userId || owner.eventId !== eventId) {
      throw new ApiError('not_found', NOT_FOUND);
    }
    return { created: false, response: await listFor(deps, eventId, userId) };
  }
  const key = referenceKey(userId, eventId, referenceId);
  if (!(await deps.objectExists(key))) {
    throw new ApiError('upload_missing', 'No reference photo has been uploaded for this uploadId');
  }
  const outcome = await deps.references.add(referenceId, eventId, userId, key);
  switch (outcome) {
    case 'not_found':
      throw new ApiError('not_found', 'No such event');
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'taken':
      throw new ApiError('not_found', NOT_FOUND);
    case 'too_many':
      throw new ApiError('too_many_references', TOO_MANY);
    case 'repeat':
    case 'added':
      return { created: outcome === 'added', response: await listFor(deps, eventId, userId) };
  }
}

// DELETE /events/{eventId}/references/{referenceId}. The row goes first, with its embedding, so a
// failed R2 delete leaves an object nothing points at rather than a row with no photo. The failure
// is logged and changes nothing about the answer. Until S-25 no reprocess is sent, and until S-29
// the last accepted reference is not refused (D-172).
export async function removeReference(
  deps: ReferenceDeps,
  userId: string,
  eventId: string,
  referenceId: string,
): Promise<ListReferencesResponse> {
  await requireMember(deps.events, eventId, userId);
  const result = await deps.references.remove(referenceId, eventId, userId);
  switch (result.outcome) {
    case 'not_found':
      throw new ApiError('not_found', NOT_FOUND);
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'removed':
      break;
  }
  try {
    await deps.deleteObject(result.photoKey);
  } catch (error) {
    deps.logger.error(
      { err: error, referenceId, key: result.photoKey },
      'could not delete a removed reference photo from R2',
    );
  }
  return listFor(deps, eventId, userId);
}
