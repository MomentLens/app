import { GpsReading, MAX_SUB_EVENTS, type VerificationRecords } from '@momentlens/shared-types';

import type { QueueStore } from '@/features/upload-queue/store';

export const GPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS gps_reading (
  userId TEXT NOT NULL, eventId TEXT NOT NULL, subEventId TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracyM REAL NOT NULL CHECK(accuracyM >= 0),
  recordedAt TEXT NOT NULL,
  PRIMARY KEY(userId, eventId, subEventId)
);
`;

// The queue and readings share the database and mutation chain. A fix is durable before its
// waiting photos are released, and every operation names its account (D-89, D-155).
export class GpsReadings {
  constructor(private store: QueueStore) {}

  eventIds(userId: string): Promise<string[]> {
    return this.store.verificationRead(async (db) => {
      const rows = await db.getAllAsync<{ eventId: string }>(
        'SELECT DISTINCT eventId FROM gps_reading WHERE userId = ?',
        userId,
      );
      return rows.map((row) => row.eventId);
    });
  }

  async list(
    userId: string,
    eventId: string,
    cachedIds?: readonly string[],
  ): Promise<GpsReading[]> {
    if (cachedIds) await this.prune(userId, eventId, cachedIds);
    return this.store.verificationRead(async (db) => {
      const rows = await db.getAllAsync<GpsReading>(
        'SELECT subEventId, lat, lng, accuracyM, recordedAt FROM gps_reading WHERE userId = ? AND eventId = ? ORDER BY subEventId LIMIT ?',
        userId,
        eventId,
        MAX_SUB_EVENTS,
      );
      return rows.flatMap((row) => {
        const parsed = GpsReading.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    });
  }

  private prune(userId: string, eventId: string, cachedIds: readonly string[]): Promise<void> {
    const ids = [...new Set(cachedIds.map((id) => id.toLowerCase()))].slice(0, MAX_SUB_EVENTS);
    return this.store.verificationMutation(async (db) => {
      await db.runAsync(
        `DELETE FROM gps_reading WHERE userId = ? AND eventId = ?${ids.length ? ` AND subEventId NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
        userId,
        eventId,
        ...ids,
      );
    }, false);
  }

  async save(
    userId: string,
    eventId: string,
    fixes: readonly GpsReading[],
    cachedIds: readonly string[],
  ): Promise<void> {
    const ids = new Set(cachedIds.slice(0, MAX_SUB_EVENTS).map((id) => id.toLowerCase()));
    await this.prune(userId, eventId, [...ids]);
    await this.store.verificationMutation(async (db) => {
      for (const fix of fixes) {
        const parsed = GpsReading.parse(fix);
        const subEventId = parsed.subEventId.toLowerCase();
        if (!ids.has(subEventId)) continue;
        await db.runAsync(
          'INSERT OR REPLACE INTO gps_reading (userId,eventId,subEventId,lat,lng,accuracyM,recordedAt) VALUES (?,?,?,?,?,?,?)',
          userId,
          eventId,
          subEventId,
          parsed.lat,
          parsed.lng,
          parsed.accuracyM,
          parsed.recordedAt,
        );
      }
    });
  }

  consume(userId: string, eventId: string, sent: readonly GpsReading[]): Promise<void> {
    return this.store.verificationMutation(async (db) => {
      for (const fix of sent) {
        // A later fix can arrive during pre-flight. Delete only the snapshot the request carried.
        await db.runAsync(
          'DELETE FROM gps_reading WHERE userId = ? AND eventId = ? AND subEventId = ? AND recordedAt = ? AND lat = ? AND lng = ? AND accuracyM = ?',
          userId,
          eventId,
          fix.subEventId.toLowerCase(),
          fix.recordedAt,
          fix.lat,
          fix.lng,
          fix.accuracyM,
        );
      }
    });
  }
}

export function gpsRecords(readings: readonly GpsReading[]): VerificationRecords {
  return readings.map((reading) => ({ ...reading, kind: 'gps' }));
}
