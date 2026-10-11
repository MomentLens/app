import { describe, expect, it } from '@jest/globals';

import {
  ErrorResponse,
  ListVenueQrsResponse,
  ManagedVenueQr,
  MAX_SUB_EVENTS,
  PreflightUploadRequest,
  QrScan,
  RegenerateVenueQrRequest,
  RegenerateVenueQrResponse,
  VenueQrPayload,
  VerificationRecords,
} from '@momentlens/shared-types';

import { ApiError } from '../../src/middleware/errors';

const venueId = 'b0000000-0000-4000-8000-000000000001';
const payload = {
  kind: 'venue_check_in',
  version: 1,
  venueId,
  secret: 'ab'.repeat(32),
};
const managed = { venueId, venueName: 'Hall', payload };
const scan = { ...payload, kind: 'qr', recordedAt: '2026-12-10T15:00:00.000Z' };
const gps = {
  kind: 'gps',
  subEventId: 'a0000000-0000-4000-8000-000000000001',
  lat: 24.86,
  lng: 67.01,
  accuracyM: 20,
  recordedAt: '2026-12-10T15:00:00.000Z',
};

describe('printed Venue QR payload', () => {
  it('round-trips the versioned JSON without adding a time or sub-event', () => {
    expect(VenueQrPayload.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(QrScan.parse(scan)).toEqual(scan);
  });

  it.each([
    { kind: 'qr' },
    { version: 2 },
    { version: '1' },
    { venueId: 'bad' },
    { secret: 'a'.repeat(63) },
    { secret: 'a'.repeat(65) },
    { secret: 'AB'.repeat(32) },
    { secret: 'g'.repeat(64) },
    { subEventId: gps.subEventId },
    { userId: venueId },
    { recordedAt: scan.recordedAt },
  ])('refuses a malformed or extra printed field %j', (change) => {
    expect(VenueQrPayload.safeParse({ ...payload, ...change }).success).toBe(false);
  });

  it.each(['kind', 'version', 'venueId', 'secret'])('requires printed %s', (field) => {
    const incomplete: Record<string, unknown> = { ...payload };
    delete incomplete[field];
    expect(VenueQrPayload.safeParse(incomplete).success).toBe(false);
  });

  it.each([
    { kind: 'venue_check_in' },
    { version: 2 },
    { venueId: 'bad' },
    { secret: 'AB'.repeat(32) },
    { recordedAt: undefined },
    { recordedAt: '2026-12-10T15:00:00Z' },
    { recordedAt: '2026-12-10T20:00:00.000+05:00' },
    { subEventId: gps.subEventId },
    { userId: venueId },
    { verified: true },
  ])('refuses malformed or client-selected scan evidence %j', (change) => {
    expect(QrScan.safeParse({ ...scan, ...change }).success).toBe(false);
  });
});

describe('QR management contracts', () => {
  it('accepts the list, conditional request and replacement envelopes', () => {
    expect(ListVenueQrsResponse.parse({ venueQrs: [managed] })).toEqual({ venueQrs: [managed] });
    expect(RegenerateVenueQrRequest.parse({ expectedSecret: payload.secret })).toEqual({
      expectedSecret: payload.secret,
    });
    expect(RegenerateVenueQrResponse.parse({ venueQr: managed })).toEqual({ venueQr: managed });
  });

  it('requires a venue name and a payload for that same venue', () => {
    expect(ManagedVenueQr.safeParse({ ...managed, venueName: '' }).success).toBe(false);
    expect(ManagedVenueQr.safeParse({ ...managed, venueName: undefined }).success).toBe(false);
    expect(ManagedVenueQr.safeParse({ ...managed, payload: undefined }).success).toBe(false);
    expect(
      ManagedVenueQr.safeParse({
        ...managed,
        payload: { ...payload, venueId: 'b0000000-0000-4000-8000-000000000002' },
      }).success,
    ).toBe(false);
    expect(ManagedVenueQr.safeParse({ ...managed, venueId: venueId.toUpperCase() }).success).toBe(
      true,
    );
  });

  it('refuses duplicate venues, an empty list and a 16th venue', () => {
    const venues = Array.from({ length: MAX_SUB_EVENTS }, (_, index) => {
      const id = `b0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return { ...managed, venueId: id, payload: { ...payload, venueId: id } };
    });
    expect(ListVenueQrsResponse.safeParse({ venueQrs: venues }).success).toBe(true);
    const sixteenth = 'b0000000-0000-4000-8000-000000000016';
    for (const venueQrs of [
      [],
      [managed, { ...managed, venueId: venueId.toUpperCase() }],
      [...venues, { ...managed, venueId: sixteenth, payload: { ...payload, venueId: sixteenth } }],
    ]) {
      expect(ListVenueQrsResponse.safeParse({ venueQrs }).success).toBe(false);
    }
  });

  it.each([
    {},
    { expectedSecret: 'bad' },
    { expectedSecret: 'AB'.repeat(32) },
    { expectedSecret: payload.secret, actorId: venueId },
    { expectedSecret: payload.secret, venueId },
  ])('refuses malformed or extra rotation input %j', (input) => {
    expect(RegenerateVenueQrRequest.safeParse(input).success).toBe(false);
  });

  it('carries venue_qr_changed with HTTP 409 in the shared error envelope', () => {
    const error = new ApiError('venue_qr_changed', 'Refresh the venue QR');
    expect(error.status).toBe(409);
    expect(ErrorResponse.parse({ error: { code: error.code, message: error.message } })).toEqual({
      error: { code: 'venue_qr_changed', message: 'Refresh the venue QR' },
    });
  });
});

describe('mixed verification limits', () => {
  const records = (count: number, record: typeof scan | typeof gps) =>
    Array.from({ length: count }, () => record);

  it('accepts 15 of either kind and all 30 together', () => {
    for (const verifications of [
      records(MAX_SUB_EVENTS, gps),
      records(MAX_SUB_EVENTS, scan),
      [...records(MAX_SUB_EVENTS, scan), ...records(MAX_SUB_EVENTS, gps)],
    ]) {
      expect(VerificationRecords.parse(verifications)).toEqual(verifications);
      const body = { contentHash: 'a'.repeat(64), subEventId: gps.subEventId, verifications };
      expect(PreflightUploadRequest.parse(body)).toEqual(body);
    }
  });

  it('refuses a 16th of either kind even below the total cap, and a 31st record', () => {
    for (const verifications of [
      records(MAX_SUB_EVENTS + 1, gps),
      records(MAX_SUB_EVENTS + 1, scan),
      [...records(MAX_SUB_EVENTS + 1, gps), scan],
      [...records(MAX_SUB_EVENTS, gps), ...records(MAX_SUB_EVENTS + 1, scan)],
    ]) {
      expect(VerificationRecords.safeParse(verifications).success).toBe(false);
    }
  });

  it('keeps each record time and refuses an unsupported kind', () => {
    const laterScan = { ...scan, recordedAt: '2026-12-11T15:00:00.000Z' };
    expect(VerificationRecords.parse([gps, laterScan])).toEqual([gps, laterScan]);
    expect(VerificationRecords.safeParse([{ ...scan, kind: 'manual' }]).success).toBe(false);
  });
});
