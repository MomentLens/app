// GET /events/{eventId}/media/people and GET /events/{eventId}/media/{mediaId}/faces (S-23, spec
// §2.5.2, §2.5.6, D-176). In-memory fakes for the event store and the face store. Who a viewer may
// see is decided in SQL and tested against the dev project in rls.test.ts; these check who reaches
// the store, which viewer it is given, and how its answer is shaped.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { pino } from 'pino';

import {
  ErrorResponse,
  ListPeopleResponse,
  ListPhotoFacesResponse,
} from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus, PhotoFace } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type { FaceStore, PersonRecord } from '../../src/services/faces';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
const GUEST = randomUUID();
const PHOTOGRAPHER = randomUUID();
const PENDING = randomUUID();
const BLOCKED = randomUUID();
const REMOVED = randomUUID();
const OUTSIDER = randomUUID();

const tokens = new Map([
  ['token-admin', ADMIN],
  ['token-guest', GUEST],
  ['token-photographer', PHOTOGRAPHER],
  ['token-pending', PENDING],
  ['token-blocked', BLOCKED],
  ['token-removed', REMOVED],
  ['token-outsider', OUTSIDER],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

const NOT_MEMBERS = [
  ['a pending member', 'token-pending'],
  ['a blocked member', 'token-blocked'],
  ['a removed member', 'token-removed'],
  ['someone with no membership', 'token-outsider'],
] as const;

interface FakeEvent {
  deleted: boolean;
  members: Map<string, { role: MembershipRole; status: MembershipStatus }>;
}

class FakeEvents implements EventStore {
  readonly events = new Map<string, FakeEvent>();

  create = () => Promise.reject(new Error('not used here'));
  listForMember = () => Promise.reject(new Error('not used here'));
  listJoinRequests = () => Promise.reject(new Error('not used here'));
  findForCaller = () => Promise.reject(new Error('not used here'));
  setCover = () => Promise.reject(new Error('not used here'));
  settings = () => Promise.reject(new Error('not used here'));
  updateSettings = () => Promise.reject(new Error('not used here'));
  albumStatus = () => Promise.reject(new Error('not used here'));
  setAlbum = () => Promise.reject(new Error('not used here'));

  findAccess(eventId: string, userId: string): Promise<MemberAccess | null> {
    const event = this.events.get(eventId);
    if (event === undefined) return Promise.resolve(null);
    return Promise.resolve({
      deleted: event.deleted,
      // An archived event reads like any other; the album state does not gate a read.
      albumOpen: false,
      membership: event.members.get(userId) ?? null,
    });
  }
}

// Answers per event and photo as the SQL functions would for the viewer recorded in `calls`.
class FakeFaces implements FaceStore {
  people_: PersonRecord[] = [];
  // A photo of this event that is published and not deleted, and its strip.
  strips = new Map<string, { eventId: string; faces: PhotoFace[] }>();
  calls: { fn: 'people' | 'photoFaces'; eventId: string; viewerId: string; mediaId?: string }[] =
    [];

  people(eventId: string, viewerId: string): Promise<PersonRecord[]> {
    this.calls.push({ fn: 'people', eventId, viewerId });
    return Promise.resolve(this.people_);
  }

  photoFaces(eventId: string, mediaId: string, viewerId: string): Promise<PhotoFace[] | null> {
    this.calls.push({ fn: 'photoFaces', eventId, viewerId, mediaId });
    const strip = this.strips.get(mediaId);
    return Promise.resolve(strip?.eventId === eventId ? strip.faces : null);
  }
}

const logger = pino({ level: 'silent' });
let events: FakeEvents;
let faces: FakeFaces;
let app: RunningApp;
let eventId: string;
let mediaId: string;

beforeAll(async () => {
  events = new FakeEvents();
  faces = new FakeFaces();
  app = await startApp(testDeps({ logger, verifyToken, events, faces }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  events.events.clear();
  faces.people_ = [];
  faces.strips.clear();
  faces.calls = [];
  eventId = randomUUID();
  mediaId = randomUUID();
  events.events.set(eventId, {
    deleted: false,
    members: new Map([
      [ADMIN, { role: 'admin', status: 'active' }],
      [GUEST, { role: 'guest', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'guest', status: 'removed' }],
    ]),
  });
});

async function get(path: string, token?: string): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(ErrorResponse.parse(await res.json()).error.code).toBe(code);
}

// The refusals both endpoints share, in hb §5.3's order. None of them reaches the store.
const endpoints = [
  ['GET /events/:eventId/media/people', () => `/events/${eventId}/media/people`],
  ['GET /events/:eventId/media/:mediaId/faces', () => `/events/${eventId}/media/${mediaId}/faces`],
] as const;

for (const [name, path] of endpoints) {
  describe(`${name} refusals`, () => {
    it('refuses an unauthenticated request with 401 no_session', async () => {
      await expectError(await get(path()), 401, 'no_session');
    });

    it('refuses an unknown event with 404 not_found', async () => {
      eventId = randomUUID();
      await expectError(await get(path(), 'token-guest'), 404, 'not_found');
    });

    it('refuses a deleted event with 404 not_found', async () => {
      events.events.get(eventId)!.deleted = true;
      await expectError(await get(path(), 'token-admin'), 404, 'not_found');
    });

    for (const [who, token] of NOT_MEMBERS) {
      it(`refuses ${who} with 403 not_member`, async () => {
        await expectError(await get(path(), token), 403, 'not_member');
      });
    }

    it('refuses a Photographer with 403 wrong_role', async () => {
      await expectError(await get(path(), 'token-photographer'), 403, 'wrong_role');
    });

    it('refuses a malformed event id with 400 invalid_request', async () => {
      eventId = 'not-a-uuid';
      await expectError(await get(path(), 'token-guest'), 400, 'invalid_request');
    });

    // The endpoint reads no query, so a viewer named there changes nothing: the store gets the
    // caller from the session.
    it('takes the viewer from the session, never from the query', async () => {
      faces.strips.set(mediaId, { eventId, faces: [] });
      const res = await get(`${path()}?viewerId=${ADMIN}&p_viewer_id=${ADMIN}`, 'token-guest');
      expect(res.status).toBe(200);
      expect(faces.calls).toEqual([expect.objectContaining({ eventId, viewerId: GUEST })]);
    });

    it('never reaches the store on a refusal', async () => {
      await get(path(), 'token-photographer');
      await get(path(), 'token-removed');
      expect(faces.calls).toEqual([]);
    });
  });
}

describe('GET /events/:eventId/media/people', () => {
  it('passes the caller from the session as the viewer and lists people with a null avatar', async () => {
    faces.people_ = [
      { userId: GUEST, fullName: 'Ayesha Khan', photoCount: 4 },
      { userId: ADMIN, fullName: 'Bilal Ahmed', photoCount: 1 },
    ];
    const res = await get(`/events/${eventId}/media/people`, 'token-guest');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ListPeopleResponse.parse(await res.json())).toEqual({
      people: [
        { userId: GUEST, fullName: 'Ayesha Khan', photoCount: 4, avatar: null },
        { userId: ADMIN, fullName: 'Bilal Ahmed', photoCount: 1, avatar: null },
      ],
    });
    expect(faces.calls).toEqual([{ fn: 'people', eventId, viewerId: GUEST }]);
  });

  it('answers the Admin with an empty list when nobody is matched', async () => {
    const res = await get(`/events/${eventId}/media/people`, 'token-admin');
    expect(res.status).toBe(200);
    expect(ListPeopleResponse.parse(await res.json())).toEqual({ people: [] });
    expect(faces.calls).toEqual([{ fn: 'people', eventId, viewerId: ADMIN }]);
  });
});

describe('GET /events/:eventId/media/:mediaId/faces', () => {
  const clusterId = randomUUID();

  it('passes the caller from the session as the viewer and returns the strip in order', async () => {
    const strip: PhotoFace[] = [
      { kind: 'unknown', clusterId },
      { kind: 'person', userId: ADMIN, fullName: 'Bilal Ahmed' },
    ];
    faces.strips.set(mediaId, { eventId, faces: strip });
    const res = await get(`/events/${eventId}/media/${mediaId}/faces`, 'token-guest');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ListPhotoFacesResponse.parse(await res.json())).toEqual({ faces: strip });
    expect(faces.calls).toEqual([{ fn: 'photoFaces', eventId, mediaId, viewerId: GUEST }]);
  });

  it('answers an empty strip for a published photo with no named or Unknown face', async () => {
    faces.strips.set(mediaId, { eventId, faces: [] });
    const res = await get(`/events/${eventId}/media/${mediaId}/faces`, 'token-admin');
    expect(res.status).toBe(200);
    expect(ListPhotoFacesResponse.parse(await res.json())).toEqual({ faces: [] });
  });

  // The store answers null for a photo that is not a published, undeleted photo of this event:
  // unknown, another event's, unprocessed or deleted alike.
  it("refuses another event's photo with 404 not_found", async () => {
    faces.strips.set(mediaId, { eventId: randomUUID(), faces: [{ kind: 'unknown', clusterId }] });
    await expectError(
      await get(`/events/${eventId}/media/${mediaId}/faces`, 'token-guest'),
      404,
      'not_found',
    );
  });

  it('refuses an unknown, unprocessed or deleted photo with 404 not_found', async () => {
    await expectError(
      await get(`/events/${eventId}/media/${mediaId}/faces`, 'token-guest'),
      404,
      'not_found',
    );
  });

  it('refuses a malformed photo id with 400 invalid_request', async () => {
    await expectError(
      await get(`/events/${eventId}/media/not-a-uuid/faces`, 'token-guest'),
      400,
      'invalid_request',
    );
    expect(faces.calls).toEqual([]);
  });
});
