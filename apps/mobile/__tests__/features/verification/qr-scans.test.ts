import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { QrScan, SubEvent } from '@momentlens/shared-types';
import { DatabaseSync } from 'node:sqlite';

import { QrScans, selectVenueScan } from '@/features/verification/qr-scans';
import { QueueStore, type QueueDatabase } from '@/features/upload-queue/store';

const EVENT = '00000000-0000-4000-8000-000000000001';
const VENUE = '00000000-0000-4000-8000-000000000002';
const SUB = '00000000-0000-4000-8000-000000000003';
const AT = new Date('2026-10-11T12:30:00.000Z');
const payload = { kind: 'venue_check_in', version: 1, venueId: VENUE, secret: 'a'.repeat(64) };
const scan: QrScan = {
  kind: 'qr',
  version: 1,
  venueId: VENUE,
  secret: payload.secret,
  recordedAt: AT.toISOString(),
};
const sub = (id = SUB, venueId = VENUE): SubEvent => ({
  id,
  name: 'Mehndi',
  description: null,
  startsAt: '2026-10-11T12:00:00.000Z',
  endsAt: '2026-10-11T13:00:00.000Z',
  verificationRadiusM: 200,
  venue: { id: venueId, name: 'Royal Palm Lawn', lat: 31, lng: 74 },
});
let db: DatabaseSync;
let store: QueueStore;
let scans: QrScans;
function reopened() {
  const adapter: QueueDatabase = {
    execAsync: async (sql) => db.exec(sql),
    runAsync: async (sql, ...params) => ({
      changes: Number(db.prepare(sql).run(...params).changes),
    }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      db.prepare(sql).all(...params) as T[],
  };
  return new QueueStore(
    adapter,
    {
      copy: async () => ({ photoPath: 'photo', thumbnailPath: 'thumb' }),
      delete: async () => {},
      list: async () => [],
      uri: (path) => path,
    },
    () => 'photo',
  );
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  store = reopened();
  scans = new QrScans(store);
});
afterEach(() => db.close());

describe('venue QR validation', () => {
  it.each([
    'not JSON',
    JSON.stringify({ ...payload, version: 2 }),
    JSON.stringify({ ...payload, secret: 'A'.repeat(64) }),
    JSON.stringify({ ...payload, subEventId: SUB }),
    JSON.stringify({ ...payload, venueId: EVENT }),
  ])('rejects malformed, unsupported and another event payload %s', (data) => {
    expect(selectVenueScan(data, [sub()], AT)).toBeNull();
  });
  it('records nothing when the venue has no live sub-event, including its end boundary', () => {
    expect(selectVenueScan(JSON.stringify(payload), [sub()], new Date(sub().endsAt))).toBeNull();
  });
  it('selects the scan-time winner at this venue, ignoring a newer session elsewhere', () => {
    const winner = { ...sub(EVENT), startsAt: '2026-10-11T12:10:00.000Z' };
    const elsewhere = { ...sub(VENUE, EVENT), startsAt: '2026-10-11T12:20:00.000Z' };
    expect(selectVenueScan(JSON.stringify(payload), [sub(), elsewhere, winner], AT)).toEqual({
      subEvent: winner,
      scan,
    });
    expect(
      selectVenueScan(JSON.stringify(payload), [sub()], new Date(sub().startsAt))?.subEvent.id,
    ).toBe(SUB);
  });
});

describe('durable account-owned QR scans', () => {
  it('keeps one scan per sub-event across restart and isolates account and event', async () => {
    await scans.save('A', EVENT, scan, [sub()]);
    const newer = { ...scan, recordedAt: new Date(AT.getTime() + 1).toISOString() };
    await scans.save('A', EVENT, newer, [sub()]);
    expect(await new QrScans(reopened()).list('A', EVENT)).toEqual([{ ...newer, subEventId: SUB }]);
    expect(await scans.list('B', EVENT)).toEqual([]);
    expect(await scans.list('A', VENUE)).toEqual([]);
  });
  it('never stores an invalid target or a sixteenth scan', async () => {
    const schedule = Array.from({ length: 16 }, (_, i) =>
      sub(
        `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    );
    for (const session of schedule.slice(0, 15))
      await scans.save('A', EVENT, { ...scan, venueId: session.venue.id }, schedule);
    await expect(
      scans.save('A', EVENT, { ...scan, venueId: schedule[15]!.venue.id }, schedule),
    ).rejects.toThrow();
    expect(await scans.list('A', EVENT)).toHaveLength(15);
    await expect(scans.save('A', EVENT, scan, [])).rejects.toThrow();
  });
  it('consumes only the sent snapshot and preserves a newer secret or time', async () => {
    await scans.save('A', EVENT, scan, [sub()]);
    await scans.save('A', EVENT, { ...scan, secret: 'b'.repeat(64) }, [sub()]);
    await scans.consume('A', EVENT, [scan]);
    expect(await scans.list('A', EVENT)).toHaveLength(1);
    await scans.consume('B', EVENT, [{ ...scan, secret: 'b'.repeat(64) }]);
    expect(await scans.list('A', EVENT)).toHaveLength(1);
    await scans.consume('A', EVENT, [{ ...scan, secret: 'b'.repeat(64) }]);
    expect(await scans.list('A', EVENT)).toEqual([]);
  });
  it('drops obsolete scans when a refreshed schedule changes their scan-time winner', async () => {
    await scans.save('A', EVENT, scan, [sub()]);
    const replacement = { ...sub(EVENT), startsAt: '2026-10-11T12:20:00.000Z' };
    expect(await scans.list('A', EVENT, [sub(), replacement])).toEqual([]);
    expect(await scans.eventIds('A')).toEqual([]);
  });
  it('a storage failure leaves waiting photos and records no success', async () => {
    const photo = await store.enqueue('A', EVENT, SUB, { uri: 'photo', capturedAt: null });
    await store.update('A', photo.id, { state: 'waiting_verification' });
    db.exec(
      "CREATE TRIGGER refuse_scan BEFORE INSERT ON qr_scan BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    await expect(scans.save('A', EVENT, scan, [sub()])).rejects.toThrow('disk full');
    expect(await scans.list('A', EVENT)).toEqual([]);
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'waiting_verification' }]);
  });
});
