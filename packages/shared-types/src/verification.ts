import { z } from 'zod';

import { MAX_SUB_EVENTS, Timestamp, VenueInput } from './event';
import { subEventStatus } from './sub-event';
import type { SubEvent } from './sub-event';
import { VenueQrPayload } from './venue-qr';

/**
 * One location fix for a sub-event, held by the phone until pre-flight consumes it (D-89,
 * D-155). `recordedAt` is the fix's own time. The server stores neither that time nor coordinates.
 */
export const GpsReading = z.object({
  subEventId: z.uuid(),
  lat: VenueInput.shape.lat,
  lng: VenueInput.shape.lng,
  accuracyM: z.number().nonnegative(),
  recordedAt: Timestamp,
});
export type GpsReading = z.infer<typeof GpsReading>;

/** A submitted QR scan carries its own time; the server chooses its sub-event (D-85, D-156). */
export const QrScan = z.strictObject({
  kind: z.literal('qr'),
  version: VenueQrPayload.shape.version,
  venueId: VenueQrPayload.shape.venueId,
  secret: VenueQrPayload.shape.secret,
  recordedAt: Timestamp,
});
export type QrScan = z.infer<typeof QrScan>;

/** GPS and QR evidence keep their own times and fields (D-155, D-156). */
export const VerificationRecord = z.discriminatedUnion('kind', [
  GpsReading.extend({ kind: z.literal('gps') }),
  QrScan,
]);
export type VerificationRecord = z.infer<typeof VerificationRecord>;

/** A pre-flight carries at most 15 records per kind, 30 together (spec §4.17, D-156). */
export const VerificationRecords = z
  .array(VerificationRecord)
  .max(2 * MAX_SUB_EVENTS)
  .refine(
    (records) =>
      records.filter((record) => record.kind === 'gps').length <= MAX_SUB_EVENTS &&
      records.filter((record) => record.kind === 'qr').length <= MAX_SUB_EVENTS,
    { message: 'Expected at most 15 GPS records and 15 QR records' },
  );
export type VerificationRecords = z.infer<typeof VerificationRecords>;

interface Coordinates {
  lat: number;
  lng: number;
}

/** Haversine distance in metres, with a mean Earth radius of 6,371,000 m (hb §11.2). */
export function distanceM(from: Coordinates, to: Coordinates): number {
  const radians = Math.PI / 180;
  const latDifference = (to.lat - from.lat) * radians;
  const lngDifference = (to.lng - from.lng) * radians;
  const haversine =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(lngDifference / 2) ** 2;
  // Rounding near antipodal points can put the intermediate value outside [0, 1].
  const bounded = Math.min(1, Math.max(0, haversine));
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

/**
 * The phone and API judge the named sub-event at the fix's own time (D-155). A fix on the radius
 * or accuracy boundary passes. The sub-event's start is inside its interval and its end is not.
 */
export function readingMatches(
  reading: GpsReading,
  subEvent: Pick<SubEvent, 'id' | 'startsAt' | 'endsAt' | 'verificationRadiusM' | 'venue'>,
): boolean {
  return (
    reading.subEventId.toLowerCase() === subEvent.id.toLowerCase() &&
    subEventStatus(subEvent, new Date(reading.recordedAt)) === 'in_progress' &&
    reading.accuracyM >= 0 &&
    reading.accuracyM <= subEvent.verificationRadiusM &&
    distanceM(reading, subEvent.venue) <= subEvent.verificationRadiusM
  );
}
