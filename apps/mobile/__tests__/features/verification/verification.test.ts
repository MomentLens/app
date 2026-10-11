import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GetEventResponse, GpsReading, SubEvent } from '@momentlens/shared-types';
import { DatabaseSync } from 'node:sqlite';

import { VerificationGate } from '@/features/verification/gate';
import { GpsCheck, type GpsCheckDeps } from '@/features/verification/gps-check';
import { GpsReadings } from '@/features/verification/readings';
import { QueueStore, type QueueDatabase } from '@/features/upload-queue/store';
import { UploadRunner, type RunnerDeps } from '@/features/upload-queue/runner';
import type { QueueItem } from '@/features/upload-queue/types';

const EVENT = '00000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '00000000-0000-4000-8000-000000000002';
const SUB = '00000000-0000-4000-8000-000000000003';
const OTHER_SUB = '00000000-0000-4000-8000-000000000004';
const AT = Date.parse('2026-10-11T12:30:00.000Z');
const subEvent = (id = SUB, lat = 31): SubEvent => ({
  id,
  name: 'Mehndi',
  description: null,
  startsAt: '2026-10-11T12:00:00.000Z',
  endsAt: '2026-10-11T13:00:00.000Z',
  verificationRadiusM: 200,
  venue: { id: EVENT, name: 'Hall', lat, lng: 74 },
});
const reading = (subEventId = SUB, at = AT): GpsReading => ({
  subEventId,
  lat: 31,
  lng: 74,
  accuracyM: 10,
  recordedAt: new Date(at).toISOString(),
});
const photo = { uri: 'file:///picker.jpg', capturedAt: null };
let database: DatabaseSync;
let store: QueueStore;
let readings: GpsReadings;
let user: string | null;
let serverState: GetEventResponse['verification'];
let schedule: SubEvent[];
let refetch: ReturnType<typeof jest.fn<(eventId: string) => void>>;
let verification: VerificationGate;

function createStore() {
  let id = 0;
  const db: QueueDatabase = {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, ...params) => ({
      changes: Number(database.prepare(sql).run(...params).changes),
    }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  };
  return new QueueStore(
    db,
    {
      copy: async (owner, queueId) => ({
        photoPath: `${owner}/${queueId}/photo.jpg`,
        thumbnailPath: `${owner}/${queueId}/thumb.webp`,
      }),
      delete: async () => undefined,
      list: async () => [],
      uri: (path) => `file:///queue/${path}`,
    },
    () => `photo-${++id}`,
  );
}

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  store = createStore();
  readings = new GpsReadings(store);
  user = 'A';
  serverState = { everySubEvent: false, subEventIds: [] };
  schedule = [subEvent(), subEvent(OTHER_SUB)];
  refetch = jest.fn();
  verification = new VerificationGate({
    readings: async () => readings,
    event: () => ({ verification: serverState }) as GetEventResponse,
    schedule: () => ({ subEvents: schedule }),
    refetch,
  });
});
afterEach(() => database.close());

describe('account-owned GPS records', () => {
  it('keeps one reading per account and sub-event across a restart', async () => {
    await readings.save('A', EVENT, [reading()], [SUB]);
    await readings.save('A', EVENT, [reading(SUB, AT + 1)], [SUB]);
    const restarted = new GpsReadings(createStore());
    expect(await restarted.list('A', EVENT)).toEqual([reading(SUB, AT + 1)]);
    expect(await restarted.list('B', EVENT)).toEqual([]);
    expect(await restarted.list('A', OTHER_EVENT)).toEqual([]);
  });

  it('keeps only the cached sub-events and never sends a sixteenth reading', async () => {
    const ids = Array.from(
      { length: 16 },
      (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await readings.save(
      'A',
      EVENT,
      ids.map((id) => reading(id)),
      ids,
    );
    expect(await readings.list('A', EVENT)).toHaveLength(15);
    expect(await readings.list('A', EVENT, [ids[0]!])).toEqual([reading(ids[0]!)]);
  });

  it('does not delete a newer reading when an older pre-flight settles', async () => {
    await readings.save('A', EVENT, [reading()], [SUB]);
    const sent = await readings.list('A', EVENT);
    await readings.save('A', EVENT, [reading(SUB, AT + 1)], [SUB]);
    await readings.consume('A', EVENT, sent);
    expect(await readings.list('A', EVENT)).toEqual([reading(SUB, AT + 1)]);
    await readings.consume('B', EVENT, [reading(SUB, AT + 1)]);
    expect(await readings.list('A', EVENT)).toHaveLength(1);
  });
});

describe('the upload check-in gate', () => {
  function runnerFor(preflight: RunnerDeps['preflight']) {
    return new UploadRunner({
      store: async () => store,
      userId: () => user,
      prepare: async (item) => ({ photoPath: item.photoPath!, contentHash: 'a'.repeat(64) }),
      discard: async () => undefined,
      preflight,
      complete: async () => ({ status: 'completed' }),
      put: async () => 'ok',
      gate: async () => 'open',
      verification,
      lostAccess: () => undefined,
      now: () => AT,
      schedule: () => () => undefined,
    });
  }
  const upload = {
    mediaId: SUB,
    photoUploadUrl: 'https://example.test/photo',
    thumbnailUploadUrl: 'https://example.test/thumb',
  };

  it('does not strand a photo when a fix is stored and released before its waiting write', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const before = verification.beforePreflight.bind(verification);
    verification.beforePreflight = async (row) => {
      const result = await before(row);
      if (result === null) {
        await readings.save('A', EVENT, [reading()], [SUB]);
        await store.release('A', EVENT, 'waiting_verification', [SUB]);
      }
      return result;
    };
    const preflight = jest.fn<RunnerDeps['preflight']>().mockResolvedValue(upload);
    await runnerFor(preflight).run();
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'uploaded' }]);
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it('does not strand a photo when server coverage arrives before the unverified waiting write', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    await readings.save('A', EVENT, [reading()], [SUB]);
    const preflight = jest
      .fn<RunnerDeps['preflight']>()
      .mockImplementationOnce(async () => {
        serverState = { everySubEvent: true, subEventIds: [] };
        await store.release('A', EVENT, 'waiting_verification', 'all');
        throw Object.assign(new Error('Unverified'), { status: 409, code: 'unverified' });
      })
      .mockResolvedValue(upload);
    await runnerFor(preflight).run();
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'uploaded' }]);
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it('never retries a refused fix at once when its local cleanup fails', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    await readings.save('A', EVENT, [reading()], [SUB]);
    jest.spyOn(readings, 'consume').mockRejectedValue(new Error('Local database unavailable'));
    const preflight = jest
      .fn<RunnerDeps['preflight']>()
      .mockRejectedValue({ status: 409, code: 'unverified' });
    await runnerFor(preflight).run();
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'waiting_verification' }]);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(await readings.list('A', EVENT)).toHaveLength(1);
  });

  it('holds a known unverified photo, but lets a seed without verification reach pre-flight', async () => {
    const item = await store.enqueue('A', EVENT, SUB, photo);
    expect(await verification.beforePreflight(item)).toBeNull();
    serverState = undefined;
    expect(await verification.beforePreflight(item)).toEqual([]);
  });

  it('accepts server coverage and resumes without a fresh GPS fix', async () => {
    const item = await store.enqueue('A', EVENT, SUB, photo);
    serverState = { everySubEvent: true, subEventIds: [] };
    expect(await verification.beforePreflight(item)).toEqual([]);
    serverState = { everySubEvent: false, subEventIds: [SUB] };
    expect(await verification.beforePreflight(item)).toEqual([]);
    serverState = { everySubEvent: false, subEventIds: [] };
    expect(await verification.beforePreflight({ ...item, mediaId: SUB })).toEqual([]);
  });

  it('leaves a removed sub-event to the existing sub_event_missing answer', async () => {
    const item = await store.enqueue('A', EVENT, SUB, photo);
    schedule = [];
    expect(await verification.beforePreflight(item)).toEqual([]);
  });

  it.each<[{ status?: number; code?: string } | null, boolean]>([
    [null, true],
    [{ status: 409, code: 'unverified' }, true],
    [{ status: 409, code: 'duplicate' }, true],
    [{ status: 409, code: 'sub_event_missing' }, true],
    [{ status: 422, code: 'event_full' }, true],
    [{ status: 422, code: 'too_many_unfinished' }, true],
    [{ status: 401, code: 'no_session' }, false],
    [{ status: 403, code: 'not_member' }, false],
    [{ status: 404, code: 'not_found' }, false],
    [{ status: 409, code: 'album_closed' }, false],
    [{ status: 400, code: 'invalid_request' }, false],
    [{ status: 503 }, false],
    [{}, false],
  ])('consumes a reading after %j only when start_upload ran', async (answer, consumed) => {
    await readings.save('A', EVENT, [reading()], [SUB]);
    const records = [{ ...reading(), kind: 'gps' as const }];
    await verification.settled('A', EVENT, records, answer);
    expect(await readings.list('A', EVENT)).toHaveLength(consumed ? 0 : 1);
    expect(refetch).toHaveBeenCalledWith(EVENT);
  });

  it('releases only named sub-events without touching another photo or account backoff', async () => {
    const first = await store.enqueue('A', EVENT, SUB, photo);
    const second = await store.enqueue('A', EVENT, OTHER_SUB, photo);
    const other = await store.enqueue('B', EVENT, SUB, photo);
    const backingOff = await store.enqueue('A', OTHER_EVENT, SUB, photo);
    for (const item of [first, second, other])
      await store.update(item.userId, item.id, { state: 'waiting_verification' });
    await store.update('A', backingOff.id, { nextRetryAt: AT + 60_000, retryCount: 4 });
    expect(await store.release('A', EVENT, 'waiting_verification', [SUB])).toBe(1);
    expect(await store.listForEvent('A', EVENT)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: 'queued' }),
        expect.objectContaining({ id: second.id, state: 'waiting_verification' }),
      ]),
    );
    expect(await store.listForEvent('B', EVENT)).toMatchObject([{ state: 'waiting_verification' }]);
    expect(await store.listForEvent('A', OTHER_EVENT)).toMatchObject([
      { nextRetryAt: AT + 60_000, retryCount: 4 },
    ]);
    expect(await store.release('A', EVENT, 'waiting_verification', [])).toBe(0);
  });

  it("account B's pre-flight never carries A's readings", async () => {
    await readings.save('A', EVENT, [reading()], [SUB]);
    await store.enqueue('A', EVENT, SUB, photo);
    await store.enqueue('B', EVENT, SUB, photo);
    user = 'B';
    serverState = undefined;
    const preflight = jest.fn<RunnerDeps['preflight']>().mockResolvedValue({
      mediaId: SUB,
      photoUploadUrl: 'https://example.test/photo',
      thumbnailUploadUrl: 'https://example.test/thumb',
    });
    const runner = new UploadRunner({
      store: async () => store,
      userId: () => user,
      prepare: async (item: QueueItem) => ({
        photoPath: item.photoPath!,
        contentHash: 'a'.repeat(64),
      }),
      discard: async () => undefined,
      preflight,
      complete: async () => ({ status: 'completed' }),
      put: async () => 'ok',
      gate: async () => 'open',
      verification,
      lostAccess: () => undefined,
      now: () => AT,
      schedule: () => () => undefined,
    });
    await runner.run();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight.mock.calls[0]![0]).toBe('B');
    expect(preflight.mock.calls[0]![2].verifications ?? []).toEqual([]);
    expect(await readings.list('A', EVENT)).toHaveLength(1);
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'queued' }]);
  });

  it('holds a photo before pre-flight without making a request', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const preflight = jest.fn<RunnerDeps['preflight']>();
    const runner = new UploadRunner({
      store: async () => store,
      userId: () => user,
      prepare: async (item) => ({ photoPath: item.photoPath!, contentHash: 'a'.repeat(64) }),
      discard: async () => undefined,
      preflight,
      complete: async () => ({ status: 'completed' }),
      put: async () => 'ok',
      gate: async () => 'open',
      verification,
      lostAccess: () => undefined,
      now: () => AT,
      schedule: () => () => undefined,
    });
    await runner.run();
    expect(preflight).not.toHaveBeenCalled();
    expect(await store.listForEvent('A', EVENT)).toMatchObject([
      { state: 'waiting_verification', step: 'preflight' },
    ]);
  });
});

describe('foreground GPS checks', () => {
  let deps: GpsCheckDeps;
  let release: ReturnType<typeof jest.fn<GpsCheckDeps['release']>>;
  let asked: boolean;
  beforeEach(() => {
    asked = false;
    release = jest.fn<GpsCheckDeps['release']>().mockResolvedValue(undefined);
    deps = {
      userId: () => user,
      active: () => true,
      context: () => ({ eventId: EVENT, verification: serverState, subEvents: schedule }),
      readings: async () => readings,
      permission: async () => ({ granted: true, canAskAgain: true, status: 'granted' }),
      requestPermission: async () => ({ granted: false, canAskAgain: true, status: 'denied' }),
      asked: () => asked,
      markAsked: () => {
        asked = true;
      },
      position: async () => ({
        coords: {
          latitude: 31,
          longitude: 74,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: AT,
      }),
      release,
      now: () => AT,
    };
  });

  it('checks every overlapping sub-event at the fix time, then stops reading GPS', async () => {
    const position = jest.fn(deps.position);
    const check = new GpsCheck({ ...deps, position });
    await check.run();
    expect((await readings.list('A', EVENT)).map((entry) => entry.subEventId)).toEqual([
      SUB,
      OTHER_SUB,
    ]);
    expect(release).toHaveBeenCalledWith('A', EVENT, [SUB, OTHER_SUB]);
    expect(await check.pending()).toBe(false);
    await check.run();
    expect(position).toHaveBeenCalledTimes(1);
  });

  it.each(['mocked', 'poor accuracy', 'unknown accuracy', 'outside', 'before start', 'at end'])(
    'rejects a fix (%s)',
    async (reason) => {
      const fix = await deps.position();
      if (reason === 'mocked') fix.mocked = true;
      if (reason === 'poor accuracy') fix.coords.accuracy = 201;
      if (reason === 'unknown accuracy') fix.coords.accuracy = null;
      if (reason === 'outside') fix.coords.latitude = 32;
      if (reason === 'before start') fix.timestamp = Date.parse('2026-10-11T11:59:59.999Z');
      if (reason === 'at end') fix.timestamp = Date.parse('2026-10-11T13:00:00.000Z');
      await new GpsCheck({ ...deps, position: async () => fix }).run();
      expect(await readings.list('A', EVENT)).toEqual([]);
      expect(release).not.toHaveBeenCalled();
    },
  );

  it('checks each venue instead of only the most recently started sub-event', async () => {
    schedule = [subEvent(), subEvent(OTHER_SUB, 32)];
    await new GpsCheck(deps).run();
    expect(await readings.list('A', EVENT)).toEqual([reading()]);
    expect(release).toHaveBeenCalledWith('A', EVENT, [SUB]);
  });

  it('never asks or reads GPS for server-exempt members, background or upcoming sub-events', async () => {
    const position = jest.fn(deps.position);
    const permission = jest.fn(deps.permission);
    serverState = { everySubEvent: true, subEventIds: [] };
    await new GpsCheck({ ...deps, position, permission }).run();
    serverState = { everySubEvent: false, subEventIds: [] };
    await new GpsCheck({ ...deps, position, permission, active: () => false }).run();
    await new GpsCheck({ ...deps, position, permission, now: () => AT - 3_600_000 }).run();
    expect(position).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });

  it('asks once across checker restarts and leaves denied permission in the waiting state', async () => {
    const requestPermission = jest.fn(deps.requestPermission);
    const position = jest.fn(deps.position);
    const permission: GpsCheckDeps['permission'] = async () => ({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
    });
    await new GpsCheck({ ...deps, permission, requestPermission, position }).run();
    await new GpsCheck({ ...deps, permission, requestPermission, position }).run();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(asked).toBe(true);
    expect(position).not.toHaveBeenCalled();
  });

  it.each([
    { android: { accuracy: 'coarse' as const } },
    { ios: { accuracy: 'reduced' as const, scope: 'whenInUse' as const } },
  ])('never accepts approximate permission %j', async (detail) => {
    const position = jest.fn(deps.position);
    await new GpsCheck({
      ...deps,
      position,
      permission: async () => ({ granted: true, canAskAgain: true, status: 'granted', ...detail }),
    }).run();
    expect(position).not.toHaveBeenCalled();
    expect(await readings.list('A', EVENT)).toEqual([]);
  });

  it('ignores a GPS result after an account change or a checker teardown', async () => {
    let finish!: (fix: Awaited<ReturnType<GpsCheckDeps['position']>>) => void;
    const position = jest.fn(
      () =>
        new Promise<Awaited<ReturnType<GpsCheckDeps['position']>>>((resolve) => {
          finish = resolve;
        }),
    );
    const check = new GpsCheck({ ...deps, position });
    const running = check.run();
    while (!position.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
    user = 'B';
    check.dispose();
    finish(await deps.position());
    await running;
    expect(await readings.list('A', EVENT)).toEqual([]);
    expect(await readings.list('B', EVENT)).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });
});
