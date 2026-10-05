// GET /events/{eventId}/media and GET /events/{eventId}/media/uploaders (D-147, D-148, spec §2.5.2, §4.9).
// In-memory fakes for event store and album store.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { pino } from 'pino';

import { ErrorResponse, ListAlbumResponse, ListUploadersResponse } from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type {
  AlbumMediaRow,
  AlbumQueryResult,
  AlbumStore,
  UploaderRecord,
} from '../../src/services/album';
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
  albumOpen: boolean;
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

  findAccess(eventId: string, userId: string): Promise<MemberAccess | null> {
    const event = this.events.get(eventId);
    if (event === undefined) return Promise.resolve(null);
    return Promise.resolve({
      deleted: event.deleted,
      albumOpen: event.albumOpen,
      membership: event.members.get(userId) ?? null,
    });
  }
}

class FakeAlbumStore implements AlbumStore {
  rows: (AlbumMediaRow & {
    eventId: string;
    uploaderUserId: string;
    uploadedAt: string | null;
    processedAt: string | null;
    deletedAt: string | null;
  })[] = [];

  uploadersList: UploaderRecord[] = [];

  query(
    eventId: string,
    options: {
      subEventId?: string;
      uploaderId?: string;
      cursor?: {
        startsAt: string;
        subEventIdRow: string;
        capturedAt: string;
        mediaId: string;
      };
      limit: number;
    },
  ): Promise<AlbumQueryResult> {
    // Filter only published, non-deleted rows for this event
    const visible = this.rows.filter(
      (r) =>
        r.eventId === eventId &&
        r.uploadedAt !== null &&
        r.processedAt !== null &&
        r.deletedAt === null &&
        (options.subEventId === undefined || r.subEventId === options.subEventId) &&
        (options.uploaderId === undefined || r.uploaderUserId === options.uploaderId),
    );

    // Section counts only if cursor is not provided
    const sectionCounts =
      options.cursor === undefined
        ? [...new Set(visible.map((r) => r.subEventId))].map((seId) => ({
            subEventId: seId,
            count: visible.filter((r) => r.subEventId === seId).length,
          }))
        : null;

    // Filter by cursor if provided:
    let filtered = visible;
    if (options.cursor) {
      const c = options.cursor;
      filtered = visible.filter((r) => {
        if (r.startsAt > c.startsAt) return true;
        if (r.startsAt === c.startsAt && r.subEventId > c.subEventIdRow) return true;
        if (r.startsAt === c.startsAt && r.subEventId === c.subEventIdRow) {
          if (r.capturedAt < c.capturedAt) return true;
          if (r.capturedAt === c.capturedAt && r.id < c.mediaId) return true;
        }
        return false;
      });
    }

    const page = filtered.slice(0, options.limit + 1);
    return Promise.resolve({
      media: page.map((r) => ({
        id: r.id,
        subEventId: r.subEventId,
        capturedAt: r.capturedAt,
        uploaderRole: r.uploaderRole,
        width: r.width,
        height: r.height,
        startsAt: r.startsAt,
      })),
      sectionCounts,
    });
  }

  uploaders(): Promise<UploaderRecord[]> {
    return Promise.resolve(this.uploadersList);
  }
}

const logger = pino({ level: 'silent' });
let events: FakeEvents;
let albumStore: FakeAlbumStore;
let app: RunningApp;
let eventId: string;
let otherEventId: string;
let subEventId1: string;

beforeAll(async () => {
  events = new FakeEvents();
  albumStore = new FakeAlbumStore();
  app = await startApp(
    testDeps({
      logger,
      verifyToken,
      events,
      album: albumStore,
    }),
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  events.events.clear();
  albumStore.rows = [];
  albumStore.uploadersList = [];

  eventId = randomUUID();
  otherEventId = randomUUID();
  subEventId1 = randomUUID();

  events.events.set(eventId, {
    deleted: false,
    albumOpen: true,
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

describe('GET /events/:eventId/media (Album)', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media`);
    expect(res.status).toBe(401);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('no_session');
  });

  it('refuses an unknown event with 404 not_found', async () => {
    const unknownId = randomUUID();
    const res = await fetch(`${app.baseUrl}/events/${unknownId}/media`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  it('refuses a deleted event with 404 not_found', async () => {
    events.events.get(eventId)!.deleted = true;
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      const res = await fetch(`${app.baseUrl}/events/${eventId}/media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
      const body = ErrorResponse.parse(await res.json());
      expect(body.error.code).toBe('not_member');
    });
  }

  it('refuses a Photographer with 403 wrong_role', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media`, {
      headers: { Authorization: 'Bearer token-photographer' },
    });
    expect(res.status).toBe(403);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('wrong_role');
  });

  it('excludes another events row, unprocessed rows, rows with no uploaded_at, and soft-deleted rows', async () => {
    const publishedId = randomUUID();
    const anotherEventId = randomUUID();
    const unprocessedId = randomUUID();
    const ownUnprocessedId = randomUUID();
    const noUploadId = randomUUID();
    const softDeletedId = randomUUID();

    albumStore.rows = [
      // 1. Valid published row
      {
        id: publishedId,
        eventId,
        subEventId: subEventId1,
        uploaderUserId: GUEST,
        uploaderRole: 'guest',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: 1920,
        height: 1080,
        uploadedAt: '2026-10-06T10:01:00.000Z',
        processedAt: '2026-10-06T10:02:00.000Z',
        deletedAt: null,
      },
      // 2. Another event's row
      {
        id: anotherEventId,
        eventId: otherEventId,
        subEventId: subEventId1,
        uploaderUserId: GUEST,
        uploaderRole: 'guest',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: 1920,
        height: 1080,
        uploadedAt: '2026-10-06T10:01:00.000Z',
        processedAt: '2026-10-06T10:02:00.000Z',
        deletedAt: null,
      },
      // 3. Unprocessed row (another's)
      {
        id: unprocessedId,
        eventId,
        subEventId: subEventId1,
        uploaderUserId: ADMIN,
        uploaderRole: 'admin',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: null,
        height: null,
        uploadedAt: '2026-10-06T10:01:00.000Z',
        processedAt: null,
        deletedAt: null,
      },
      // 4. Unprocessed row (caller's own)
      {
        id: ownUnprocessedId,
        eventId,
        subEventId: subEventId1,
        uploaderUserId: GUEST,
        uploaderRole: 'guest',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: null,
        height: null,
        uploadedAt: '2026-10-06T10:01:00.000Z',
        processedAt: null,
        deletedAt: null,
      },
      // 5. No uploaded_at
      {
        id: noUploadId,
        eventId,
        subEventId: subEventId1,
        uploaderUserId: GUEST,
        uploaderRole: 'guest',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: null,
        height: null,
        uploadedAt: null,
        processedAt: null,
        deletedAt: null,
      },
      // 6. Soft-deleted row
      {
        id: softDeletedId,
        eventId,
        subEventId: subEventId1,
        uploaderUserId: GUEST,
        uploaderRole: 'guest',
        capturedAt: '2026-10-06T10:00:00.000Z',
        startsAt: '2026-10-06T09:00:00.000Z',
        width: 1920,
        height: 1080,
        uploadedAt: '2026-10-06T10:01:00.000Z',
        processedAt: '2026-10-06T10:02:00.000Z',
        deletedAt: '2026-10-06T10:05:00.000Z',
      },
    ];

    const res = await fetch(`${app.baseUrl}/events/${eventId}/media`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(200);
    const body = ListAlbumResponse.parse(await res.json());
    expect(body.media.map((m) => m.id)).toEqual([publishedId]);
    expect(body.sectionCounts).toEqual([{ subEventId: subEventId1, count: 1 }]);
    expect(body.nextCursor).toBeNull();
  });

  it('rejects a tampered or invalid cursor with 400 invalid_request', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media?cursor=not-a-valid-cursor`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(400);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('GET /events/:eventId/media/uploaders', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/uploaders`);
    expect(res.status).toBe(401);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('no_session');
  });

  it('refuses an unknown event with 404 not_found', async () => {
    const unknownId = randomUUID();
    const res = await fetch(`${app.baseUrl}/events/${unknownId}/media/uploaders`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  it('refuses a deleted event with 404 not_found', async () => {
    events.events.get(eventId)!.deleted = true;
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/uploaders`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      const res = await fetch(`${app.baseUrl}/events/${eventId}/media/uploaders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
      const body = ErrorResponse.parse(await res.json());
      expect(body.error.code).toBe('not_member');
    });
  }

  it('refuses a Photographer with 403 wrong_role', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/uploaders`, {
      headers: { Authorization: 'Bearer token-photographer' },
    });
    expect(res.status).toBe(403);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('wrong_role');
  });

  it('returns active uploaders with photo count, leaving off removed uploaders', async () => {
    albumStore.uploadersList = [
      {
        userId: GUEST,
        fullName: 'Active Guest',
        role: 'guest',
        photoCount: 5,
      },
    ];

    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/uploaders`, {
      headers: { Authorization: 'Bearer token-guest' },
    });
    expect(res.status).toBe(200);
    const body = ListUploadersResponse.parse(await res.json());
    expect(body.uploaders).toEqual([
      {
        userId: GUEST,
        fullName: 'Active Guest',
        role: 'guest',
        photoCount: 5,
        avatar: null,
      },
    ]);
  });
});
