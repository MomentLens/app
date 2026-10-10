import { describe, expect, it } from '@jest/globals';

import {
  distanceM,
  GetEventResponse,
  GpsReading,
  PreflightUploadRequest,
  readingMatches,
  VerificationRecords,
} from '@momentlens/shared-types';
import type { SubEvent } from '@momentlens/shared-types';

// The shared package has no test runner. Its contract and GPS logic use the API's Jest runner,
// as the shared sub-event helpers do (hb §11.2, D-155).
const subEvent: SubEvent = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Mehndi',
  description: null,
  startsAt: '2026-12-10T14:00:00.000Z',
  endsAt: '2026-12-10T18:00:00.000Z',
  verificationRadiusM: 200,
  venue: { id: 'b0000000-0000-4000-8000-000000000001', name: 'Hall', lat: 0, lng: 0 },
};

const reading: GpsReading = {
  subEventId: subEvent.id,
  lat: 0,
  lng: 0,
  accuracyM: 20,
  recordedAt: '2026-12-10T15:00:00.000Z',
};
const record = { ...reading, kind: 'gps' as const };
const preflight = { contentHash: 'a'.repeat(64), subEventId: subEvent.id };

describe('GPS contracts', () => {
  it('accepts zero accuracy and coordinate endpoints', () => {
    expect(GpsReading.safeParse({ ...reading, lat: 90, lng: 180, accuracyM: 0 }).success).toBe(
      true,
    );
    expect(GpsReading.safeParse({ ...reading, lat: -90, lng: -180 }).success).toBe(true);
  });

  it.each([
    { lat: 90.01 },
    { lng: -180.01 },
    { lat: NaN },
    { lng: Infinity },
    { accuracyM: -1 },
    { accuracyM: Infinity },
    { accuracyM: null },
    { subEventId: 'not-a-uuid' },
    { recordedAt: '2026-12-10T15:00:00Z' },
    { recordedAt: '2026-12-10T20:00:00.000+05:00' },
  ])('rejects a malformed reading with %j', (change) => {
    expect(GpsReading.safeParse({ ...reading, ...change }).success).toBe(false);
  });

  it('accepts an absent or empty list and at most 15 records', () => {
    expect(PreflightUploadRequest.parse(preflight)).toEqual(preflight);
    expect(VerificationRecords.parse([])).toEqual([]);
    expect(VerificationRecords.safeParse(Array.from({ length: 15 }, () => record)).success).toBe(
      true,
    );
    expect(VerificationRecords.safeParse(Array.from({ length: 16 }, () => record)).success).toBe(
      false,
    );
  });

  it('refuses an unknown record kind and a GPS record missing its accuracy', () => {
    expect(VerificationRecords.safeParse([{ ...record, kind: 'qr' }]).success).toBe(false);
    expect(VerificationRecords.safeParse([{ ...record, accuracyM: undefined }]).success).toBe(
      false,
    );
  });

  it('allows a reading for a different sub-event than the photo', () => {
    const body = { ...preflight, subEventId: 'a0000000-0000-4000-8000-000000000002' };
    expect(PreflightUploadRequest.parse({ ...body, verifications: [record] })).toEqual({
      ...body,
      verifications: [record],
    });
  });

  it('drops client-supplied verification and exemption flags', () => {
    expect(
      PreflightUploadRequest.parse({ ...preflight, verified: true, role: 'photographer' }),
    ).toEqual(preflight);
  });
});

describe('distanceM', () => {
  it('returns zero at the same coordinates', () => {
    expect(distanceM({ lat: 24.86, lng: 67.01 }, { lat: 24.86, lng: 67.01 })).toBe(0);
  });

  it('measures one equatorial degree and is symmetric', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0, lng: 1 };
    expect(distanceM(a, b)).toBeCloseTo(111_194.9266, 3);
    expect(distanceM(b, a)).toBeCloseTo(distanceM(a, b), 8);
  });

  it('takes the short path across the antimeridian', () => {
    expect(distanceM({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 })).toBeCloseTo(222.3899, 3);
  });

  it('returns a finite distance near antipodal points', () => {
    expect(distanceM({ lat: 89.999, lng: 0 }, { lat: -89.999, lng: 180 })).toBeCloseTo(
      20_015_086.796,
      2,
    );
  });
});

describe('readingMatches', () => {
  it('includes the start and excludes the end', () => {
    expect(readingMatches({ ...reading, recordedAt: subEvent.startsAt }, subEvent)).toBe(true);
    expect(readingMatches({ ...reading, recordedAt: '2026-12-10T13:59:59.999Z' }, subEvent)).toBe(
      false,
    );
    expect(readingMatches({ ...reading, recordedAt: subEvent.endsAt }, subEvent)).toBe(false);
  });

  it('includes equal accuracy and refuses accuracy worse than the radius', () => {
    expect(readingMatches({ ...reading, accuracyM: 200 }, subEvent)).toBe(true);
    expect(readingMatches({ ...reading, accuracyM: 200.001 }, subEvent)).toBe(false);
    expect(readingMatches({ ...reading, accuracyM: -1 }, subEvent)).toBe(false);
  });

  it('refuses a fix outside the radius', () => {
    expect(readingMatches({ ...reading, lat: 0.001 }, subEvent)).toBe(true);
    expect(readingMatches({ ...reading, lat: 0.002 }, subEvent)).toBe(false);
  });

  it('includes the distance boundary', () => {
    const fix = { ...reading, lat: 0.001 };
    const boundary = distanceM(fix, subEvent.venue);
    expect(readingMatches(fix, { ...subEvent, verificationRadiusM: boundary })).toBe(true);
    expect(readingMatches(fix, { ...subEvent, verificationRadiusM: boundary - 0.001 })).toBe(false);
  });

  it('matches UUID spellings as Postgres does and refuses another sub-event', () => {
    expect(readingMatches({ ...reading, subEventId: subEvent.id.toUpperCase() }, subEvent)).toBe(
      true,
    );
    expect(
      readingMatches({ ...reading, subEventId: 'a0000000-0000-4000-8000-000000000002' }, subEvent),
    ).toBe(false);
  });

  it('judges overlapping sub-events separately', () => {
    const other = { ...subEvent, id: 'a0000000-0000-4000-8000-000000000002' };
    expect(readingMatches(reading, subEvent)).toBe(true);
    expect(readingMatches({ ...reading, subEventId: other.id }, other)).toBe(true);
  });

  it('uses the fix time after a delay and refuses a schedule edit that excludes it', () => {
    expect(readingMatches(reading, { ...subEvent, endsAt: '2026-12-10T20:00:00.000Z' })).toBe(true);
    expect(readingMatches(reading, { ...subEvent, startsAt: '2026-12-10T16:00:00.000Z' })).toBe(
      false,
    );
  });
});

describe('GetEventResponse verification', () => {
  const event = {
    id: 'c0000000-0000-4000-8000-000000000001',
    name: 'Wedding',
    type: 'wedding',
    role: 'guest',
    cover: null,
    startsAt: subEvent.startsAt,
    endsAt: subEvent.endsAt,
    archivedAt: null,
  };

  it('preserves absence for an old cache or an Events-list seed', () => {
    expect(GetEventResponse.parse({ event })).toEqual({ event });
  });

  it('carries an explicit server decision and no reading', () => {
    const verification = { everySubEvent: false, subEventIds: [subEvent.id] };
    expect(GetEventResponse.parse({ event, verification })).toEqual({ event, verification });
    expect(
      GetEventResponse.parse({ event, verification: { everySubEvent: true, subEventIds: [] } }),
    ).toEqual({ event, verification: { everySubEvent: true, subEventIds: [] } });
  });

  it('refuses an incomplete state and a 16th sub-event', () => {
    expect(GetEventResponse.safeParse({ event, verification: { subEventIds: [] } }).success).toBe(
      false,
    );
    expect(
      GetEventResponse.safeParse({
        event,
        verification: { everySubEvent: false, subEventIds: Array(16).fill(subEvent.id) },
      }).success,
    ).toBe(false);
  });
});
