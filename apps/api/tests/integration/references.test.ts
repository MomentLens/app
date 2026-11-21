// GET, POST .../upload, PUT and DELETE /events/{eventId}/references (spec §4.2, D-91, D-141,
// D-172, arch:face_reference). The stores are fakes: the event store answers findAccess from a
// membership table, and the reference store answers as add_face_reference and
// delete_face_reference do. rls.test.ts runs the real functions against the dev project. URLs are
// presigned by the real R2 presigner with test credentials.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  CreateReferenceUploadResponse,
  ErrorResponse,
  ListReferencesResponse,
  MAX_REFERENCES_PER_EVENT,
} from '@momentlens/shared-types';
import type {
  MembershipRole,
  MembershipStatus,
  ReferenceRejectReason,
  ReferenceStatus,
} from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type {
  AddReferenceOutcome,
  ReferenceOwner,
  ReferenceRecord,
  ReferenceStore,
  RemoveReferenceResult,
} from '../../src/services/references';
import { startApp, TEST_R2, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const OWNER: string = randomUUID();
const OTHER: string = randomUUID();
const ADMIN: string = randomUUID();
const PHOTOGRAPHER: string = randomUUID();
const PENDING: string = randomUUID();
const BLOCKED: string = randomUUID();
const REMOVED: string = randomUUID();
const OUTSIDER: string = randomUUID();

const EVENT: string = randomUUID();
const OTHER_EVENT: string = randomUUID();
const DELETED_EVENT: string = randomUUID();

const tokens = new Map([
  ['owner', OWNER],
  ['other', OTHER],
  ['admin', ADMIN],
  ['photographer', PHOTOGRAPHER],
  ['pending', PENDING],
  ['blocked', BLOCKED],
  ['removed', REMOVED],
  ['outsider', OUTSIDER],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

interface Membership {
  role: MembershipRole;
  status: MembershipStatus;
}

const memberships = new Map<string, Map<string, Membership>>([
  [
    EVENT,
    new Map<string, Membership>([
      [OWNER, { role: 'guest', status: 'active' }],
      [OTHER, { role: 'guest', status: 'active' }],
      [ADMIN, { role: 'admin', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'guest', status: 'removed' }],
    ]),
  ],
  [OTHER_EVENT, new Map<string, Membership>([[OWNER, { role: 'guest', status: 'active' }]])],
  [DELETED_EVENT, new Map<string, Membership>([[OWNER, { role: 'admin', status: 'active' }]])],
]);

// findAccess as the real store reads it; every other method fails, since no reference endpoint
// calls one.
const events: EventStore = {
  ...testDeps().events,
  findAccess: (eventId, userId) => {
    const members = memberships.get(eventId);
    if (members === undefined) return Promise.resolve(null);
    const access: MemberAccess = {
      deleted: eventId === DELETED_EVENT,
      membership: members.get(userId) ?? null,
      albumOpen: true,
    };
    return Promise.resolve(access);
  },
};

interface Row {
  id: string;
  userId: string;
  eventId: string;
  photoKey: string;
  status: ReferenceStatus;
  rejectReason: ReferenceRejectReason | null;
  createdAt: string;
}

function keyFor(userId: string, eventId: string, id: string): string {
  return `users/${userId}/events/${eventId}/reference_${id}.jpg`;
}

// face_reference as add_face_reference and delete_face_reference keep it. `forceAdd` and
// `forceRemove` make the next call answer as the function does when something changed between the
// service's checks and its lock.
class FakeReferences implements ReferenceStore {
  rows: Row[] = [];
  readonly adds: { referenceId: string; eventId: string; userId: string; photoKey: string }[] = [];
  readonly removes: { referenceId: string; eventId: string; userId: string }[] = [];
  forceAdd: AddReferenceOutcome | null = null;
  forceRemove: RemoveReferenceResult | null = null;
  private clock = Date.parse('2026-12-01T10:00:00Z');

  seed(userId: string, eventId: string, status: ReferenceStatus = 'pending'): Row {
    const id = randomUUID();
    this.clock += 1000;
    const row: Row = {
      id,
      userId,
      eventId,
      photoKey: keyFor(userId, eventId, id),
      status,
      rejectReason: status === 'rejected' ? 'multiple_faces' : null,
      createdAt: new Date(this.clock).toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  private mine(eventId: string, userId: string): Row[] {
    return this.rows.filter((r) => r.eventId === eventId && r.userId === userId);
  }

  list(eventId: string, userId: string): Promise<ReferenceRecord[]> {
    return Promise.resolve(
      this.mine(eventId, userId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(({ id, status, rejectReason, photoKey, createdAt }) => ({
          id,
          status,
          rejectReason,
          photoKey,
          createdAt,
        })),
    );
  }

  countKept(eventId: string, userId: string): Promise<number> {
    return Promise.resolve(
      this.mine(eventId, userId).filter((r) => r.status !== 'rejected').length,
    );
  }

  findOwner(referenceId: string): Promise<ReferenceOwner | null> {
    const row = this.rows.find((r) => r.id === referenceId);
    return Promise.resolve(row === undefined ? null : { userId: row.userId, eventId: row.eventId });
  }

  add(
    referenceId: string,
    eventId: string,
    userId: string,
    photoKey: string,
  ): Promise<AddReferenceOutcome> {
    this.adds.push({ referenceId, eventId, userId, photoKey });
    if (this.forceAdd !== null) return Promise.resolve(this.forceAdd);
    const existing = this.rows.find((r) => r.id === referenceId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.userId === userId && existing.eventId === eventId ? 'repeat' : 'taken',
      );
    }
    const kept = this.mine(eventId, userId).filter((r) => r.status !== 'rejected').length;
    if (kept >= MAX_REFERENCES_PER_EVENT) return Promise.resolve('too_many');
    this.clock += 1000;
    this.rows.push({
      id: referenceId,
      userId,
      eventId,
      photoKey,
      status: 'pending',
      rejectReason: null,
      createdAt: new Date(this.clock).toISOString(),
    });
    return Promise.resolve('added');
  }

  remove(referenceId: string, eventId: string, userId: string): Promise<RemoveReferenceResult> {
    this.removes.push({ referenceId, eventId, userId });
    if (this.forceRemove !== null) return Promise.resolve(this.forceRemove);
    const index = this.rows.findIndex(
      (r) => r.id === referenceId && r.eventId === eventId && r.userId === userId,
    );
    if (index === -1) return Promise.resolve({ outcome: 'not_found' });
    const [row] = this.rows.splice(index, 1);
    return Promise.resolve({ outcome: 'removed', photoKey: row?.photoKey ?? '' });
  }
}

const references = new FakeReferences();
const objects = new Set<string>();
const heads: string[] = [];
const deleted: string[] = [];
let failDeletes = false;

let app: RunningApp;

beforeAll(async () => {
  app = await startApp(
    testDeps({
      verifyToken,
      events,
      references,
      objectExists: (key) => {
        heads.push(key);
        return Promise.resolve(objects.has(key));
      },
      deleteObject: (key) => {
        deleted.push(key);
        return failDeletes ? Promise.reject(new Error('R2 is down')) : Promise.resolve();
      },
    }),
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  references.rows = [];
  references.adds.length = 0;
  references.removes.length = 0;
  references.forceAdd = null;
  references.forceRemove = null;
  objects.clear();
  heads.length = 0;
  deleted.length = 0;
  failDeletes = false;
});

function send(method: string, path: string, token?: string): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

const listPath = (eventId = EVENT) => `/events/${eventId}/references`;
const uploadPath = (eventId = EVENT) => `/events/${eventId}/references/upload`;
const onePath = (id: string, eventId = EVENT) => `/events/${eventId}/references/${id}`;

// Everyone who must get 403 not_member, by token.
const nonMembers = [
  ['a pending member', 'pending'],
  ['a blocked member', 'blocked'],
  ['a removed member', 'removed'],
  ['someone who never joined', 'outsider'],
] as const;

// The refusals every endpoint shares, in the contract's order (reference.ts).
describe.each([
  ['GET', (id: string) => listPath(id)],
  ['POST', (id: string) => uploadPath(id)],
  ['PUT', (id: string) => onePath(randomUUID(), id)],
  ['DELETE', (id: string) => onePath(randomUUID(), id)],
] as const)('%s refusals', (method, path) => {
  it('answers 401 no_session with no token', async () => {
    const response = await send(method, path(EVENT));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });

  it('answers 400 invalid_request for an event id that is not a uuid', async () => {
    const response = await send(method, path('not-a-uuid'), 'owner');
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
  });

  it.each([
    ['an unknown event', randomUUID()],
    ['a soft-deleted event', DELETED_EVENT],
  ])('answers 404 not_found for %s', async (_case, eventId) => {
    const response = await send(method, path(eventId), 'owner');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it.each(nonMembers)(
    'answers %s 403 not_member, and touches no row or object',
    async (_who, token) => {
      const response = await send(method, path(EVENT), token);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('not_member');
      expect(references.adds).toEqual([]);
      expect(references.removes).toEqual([]);
      expect(heads).toEqual([]);
      expect(deleted).toEqual([]);
    },
  );
});

describe('GET /events/{eventId}/references', () => {
  it("lists the caller's own references in this event, oldest first, presigned for them", async () => {
    const first = references.seed(OWNER, EVENT, 'accepted');
    const second = references.seed(OWNER, EVENT, 'rejected');
    const third = references.seed(OWNER, EVENT);
    references.seed(OWNER, OTHER_EVENT);
    references.seed(OTHER, EVENT);

    const response = await send('GET', listPath(), 'owner');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = ListReferencesResponse.parse(await response.json());
    expect(body.references.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    expect(body.references.map((r) => [r.status, r.rejectReason])).toEqual([
      ['accepted', null],
      ['rejected', 'multiple_faces'],
      ['pending', null],
    ]);
    for (const [index, row] of [first, second, third].entries()) {
      const image = body.references[index]?.image;
      expect(image?.cacheKey).toBe(row.photoKey);
      const url = new URL(image?.url ?? '');
      expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
      expect(url.pathname).toBe(`/${row.photoKey}`);
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('never sends an embedding or any field outside the contract', async () => {
    references.seed(OWNER, EVENT, 'accepted');
    const raw = (await (await send('GET', listPath(), 'owner')).json()) as {
      references: Record<string, unknown>[];
    };
    expect(Object.keys(raw.references[0] ?? {}).sort()).toEqual(
      ['createdAt', 'id', 'image', 'rejectReason', 'status'].sort(),
    );
  });

  it.each([
    ['the Admin', 'admin'],
    ['another Guest', 'other'],
    ['a Photographer', 'photographer'],
  ])("never presigns the owner's reference for %s", async (_who, token) => {
    const row = references.seed(OWNER, EVENT, 'accepted');
    const response = await send('GET', listPath(), token);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(ListReferencesResponse.parse(JSON.parse(text)).references).toEqual([]);
    expect(text).not.toContain(row.id);
    expect(text).not.toContain(OWNER);
  });

  it("lists none of the caller's references from another event (D-141)", async () => {
    references.seed(OWNER, OTHER_EVENT, 'accepted');
    const body = ListReferencesResponse.parse(
      await (await send('GET', listPath(), 'owner')).json(),
    );
    expect(body.references).toEqual([]);
  });
});

describe('POST /events/{eventId}/references/upload', () => {
  it("presigns a PUT to a new key in the caller's own folder for this event", async () => {
    const response = await send('POST', uploadPath(), 'owner');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = CreateReferenceUploadResponse.parse(await response.json());
    const url = new URL(body.uploadUrl);
    expect(url.pathname).toBe(`/${keyFor(OWNER, EVENT, body.uploadId)}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(references.adds).toEqual([]);
  });

  it('gives every upload a new id', async () => {
    const one = CreateReferenceUploadResponse.parse(
      await (await send('POST', uploadPath(), 'owner')).json(),
    );
    const two = CreateReferenceUploadResponse.parse(
      await (await send('POST', uploadPath(), 'owner')).json(),
    );
    expect(one.uploadId).not.toBe(two.uploadId);
  });

  it('lets a Photographer keep references too', async () => {
    expect((await send('POST', uploadPath(), 'photographer')).status).toBe(200);
  });

  it(`answers 422 too_many_references at ${MAX_REFERENCES_PER_EVENT} kept references`, async () => {
    for (let i = 0; i < MAX_REFERENCES_PER_EVENT; i += 1) references.seed(OWNER, EVENT);
    const response = await send('POST', uploadPath(), 'owner');
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('too_many_references');
  });

  it('does not count a rejected reference, so the owner can replace it', async () => {
    for (let i = 0; i < MAX_REFERENCES_PER_EVENT - 1; i += 1) references.seed(OWNER, EVENT);
    references.seed(OWNER, EVENT, 'rejected');
    expect((await send('POST', uploadPath(), 'owner')).status).toBe(200);
  });

  it("counts only this event's references", async () => {
    for (let i = 0; i < MAX_REFERENCES_PER_EVENT; i += 1) references.seed(OWNER, OTHER_EVENT);
    expect((await send('POST', uploadPath(), 'owner')).status).toBe(200);
  });
});

describe('PUT /events/{eventId}/references/{uploadId}', () => {
  it('answers 400 invalid_request for a reference id that is not a uuid', async () => {
    const response = await send('PUT', onePath('reference.jpg'), 'owner');
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
    expect(heads).toEqual([]);
  });

  it("inserts a pending reference at the caller's key and answers 201 with the list", async () => {
    const id = randomUUID();
    const key = keyFor(OWNER, EVENT, id);
    objects.add(key);
    const response = await send('PUT', onePath(id), 'owner');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = ListReferencesResponse.parse(await response.json());
    expect(body.references.map((r) => [r.id, r.status])).toEqual([[id, 'pending']]);
    expect(heads).toEqual([key]);
    expect(references.adds).toEqual([
      { referenceId: id, eventId: EVENT, userId: OWNER, photoKey: key },
    ]);
  });

  it('lowercases an uppercase id, so the key matches the row CHECK', async () => {
    const id = randomUUID();
    objects.add(keyFor(OWNER, EVENT, id));
    const response = await send('PUT', onePath(id.toUpperCase(), EVENT.toUpperCase()), 'owner');
    expect(response.status).toBe(201);
    expect(references.adds[0]?.photoKey).toBe(keyFor(OWNER, EVENT, id));
  });

  it('answers 409 upload_missing when the object is not in R2, and inserts nothing', async () => {
    const response = await send('PUT', onePath(randomUUID()), 'owner');
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('upload_missing');
    expect(references.adds).toEqual([]);
  });

  it("answers 409 for another user's uploadId, since the key is built in the caller's folder", async () => {
    const id = randomUUID();
    objects.add(keyFor(OTHER, EVENT, id));
    const response = await send('PUT', onePath(id), 'owner');
    expect(response.status).toBe(409);
    expect(heads).toEqual([keyFor(OWNER, EVENT, id)]);
    expect(references.adds).toEqual([]);
  });

  it('answers a retried complete 200 with the list, with no second insert or HEAD', async () => {
    const row = references.seed(OWNER, EVENT);
    objects.add(row.photoKey);
    const response = await send('PUT', onePath(row.id), 'owner');
    expect(response.status).toBe(200);
    const body = ListReferencesResponse.parse(await response.json());
    expect(body.references.map((r) => r.id)).toEqual([row.id]);
    expect(references.adds).toEqual([]);
    expect(heads).toEqual([]);
  });

  it("answers 404 not_found for another user's reference id, and writes nothing", async () => {
    const row = references.seed(OTHER, EVENT);
    objects.add(keyFor(OWNER, EVENT, row.id));
    const response = await send('PUT', onePath(row.id), 'owner');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
    expect(references.adds).toEqual([]);
    expect(heads).toEqual([]);
  });

  it("answers 404 not_found for the caller's own reference id from another event", async () => {
    const row = references.seed(OWNER, OTHER_EVENT);
    objects.add(keyFor(OWNER, EVENT, row.id));
    const response = await send('PUT', onePath(row.id), 'owner');
    expect(response.status).toBe(404);
    expect(references.adds).toEqual([]);
  });

  it(`answers 422 too_many_references for a ${MAX_REFERENCES_PER_EVENT + 1}th, and stores no row`, async () => {
    for (let i = 0; i < MAX_REFERENCES_PER_EVENT; i += 1) references.seed(OWNER, EVENT);
    const id = randomUUID();
    objects.add(keyFor(OWNER, EVENT, id));
    const response = await send('PUT', onePath(id), 'owner');
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('too_many_references');
    expect(references.rows.some((r) => r.id === id)).toBe(false);
  });

  // What add_face_reference answers when something changed between the service's checks and the
  // function's lock: a removal, an event deleted, or a second upload of the same id.
  it.each([
    ['not_found', 404, 'not_found'],
    ['not_member', 403, 'not_member'],
    ['taken', 404, 'not_found'],
    ['too_many', 422, 'too_many_references'],
  ] as const)("answers the function's %s with %i %s", async (outcome, status, code) => {
    const id = randomUUID();
    objects.add(keyFor(OWNER, EVENT, id));
    references.forceAdd = outcome;
    const response = await send('PUT', onePath(id), 'owner');
    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
  });

  it("answers the function's repeat 200, for two sends of one id that crossed", async () => {
    const id = randomUUID();
    objects.add(keyFor(OWNER, EVENT, id));
    references.forceAdd = 'repeat';
    expect((await send('PUT', onePath(id), 'owner')).status).toBe(200);
  });
});

describe('DELETE /events/{eventId}/references/{referenceId}', () => {
  it('answers 400 invalid_request for a reference id that is not a uuid', async () => {
    const response = await send('DELETE', onePath('x'), 'owner');
    expect(response.status).toBe(400);
    expect(references.removes).toEqual([]);
  });

  it('deletes the row, then the object, and answers 200 with the list after it', async () => {
    const gone = references.seed(OWNER, EVENT, 'accepted');
    const kept = references.seed(OWNER, EVENT, 'accepted');
    const response = await send('DELETE', onePath(gone.id), 'owner');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = ListReferencesResponse.parse(await response.json());
    expect(body.references.map((r) => r.id)).toEqual([kept.id]);
    expect(references.removes).toEqual([{ referenceId: gone.id, eventId: EVENT, userId: OWNER }]);
    expect(deleted).toEqual([gone.photoKey]);
  });

  it.each([
    ['another Guest', 'other'],
    ['the Admin', 'admin'],
  ])("answers %s 404 not_found for the owner's reference, which stays", async (_who, token) => {
    const row = references.seed(OWNER, EVENT, 'accepted');
    const response = await send('DELETE', onePath(row.id), token);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
    expect(references.rows.map((r) => r.id)).toEqual([row.id]);
    expect(deleted).toEqual([]);
  });

  it("answers 404 for the caller's reference from another event, which stays", async () => {
    const row = references.seed(OWNER, OTHER_EVENT, 'accepted');
    const response = await send('DELETE', onePath(row.id), 'owner');
    expect(response.status).toBe(404);
    expect(references.rows.map((r) => r.id)).toEqual([row.id]);
    expect(deleted).toEqual([]);
  });

  it('answers 404 for an unknown or already deleted reference, which the app treats as done', async () => {
    const response = await send('DELETE', onePath(randomUUID()), 'owner');
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it("answers the function's not_member 403, for a removal that crossed the delete", async () => {
    const row = references.seed(OWNER, EVENT);
    references.forceRemove = { outcome: 'not_member' };
    const response = await send('DELETE', onePath(row.id), 'owner');
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('not_member');
    expect(deleted).toEqual([]);
  });

  it('still answers 200 when R2 fails to delete the object, which is logged', async () => {
    const row = references.seed(OWNER, EVENT);
    failDeletes = true;
    const response = await send('DELETE', onePath(row.id), 'owner');
    expect(response.status).toBe(200);
    expect(deleted).toEqual([row.photoKey]);
  });

  it("keeps a removed member's references, and refuses them while removed (D-84)", async () => {
    const row = references.seed(REMOVED, EVENT, 'accepted');
    const response = await send('DELETE', onePath(row.id), 'removed');
    expect(response.status).toBe(403);
    expect(references.rows.map((r) => r.id)).toEqual([row.id]);
  });
});
