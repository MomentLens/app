import {
  currentSubEvent,
  MAX_SUB_EVENTS,
  QrScan,
  VenueQrPayload,
  type SubEvent,
} from '@momentlens/shared-types';

import type { QueueDatabase, QueueStore } from '@/features/upload-queue/store';

export const QR_SCHEMA = `
CREATE TABLE IF NOT EXISTS qr_scan (
  userId TEXT NOT NULL, eventId TEXT NOT NULL, subEventId TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version = 1), venueId TEXT NOT NULL,
  secret TEXT NOT NULL, recordedAt TEXT NOT NULL,
  PRIMARY KEY(userId, eventId, subEventId)
);
`;
export type HeldQrScan = QrScan & { subEventId: string };

function target(scan: QrScan, subEvents: readonly SubEvent[]): SubEvent | null {
  return currentSubEvent(
    subEvents.filter((sub) => sub.venue.id.toLowerCase() === scan.venueId.toLowerCase()),
    new Date(scan.recordedAt),
  );
}

// Read only the versioned poster format. A URL, another event's venue or an idle venue records
// nothing. The phone supplies the time; the server rechecks the secret and selection (D-156).
export function selectVenueScan(data: string, subEvents: readonly SubEvent[], at: Date) {
  try {
    if (data.length > 1024 || !Number.isFinite(at.getTime())) return null;
    const parsed = VenueQrPayload.safeParse(JSON.parse(data));
    if (!parsed.success) return null;
    const scan = QrScan.parse({ ...parsed.data, kind: 'qr', recordedAt: at.toISOString() });
    const subEvent = target(scan, subEvents);
    return subEvent ? { subEvent, scan } : null;
  } catch {
    return null;
  }
}

// Only scanned credentials enter SQLite. Admin management reads stay in Query memory (D-17).
export class QrScans {
  constructor(private store: QueueStore) {}

  eventIds(userId: string): Promise<string[]> {
    return this.store.verificationRead(async (db) =>
      (
        await db.getAllAsync<{ eventId: string }>(
          'SELECT DISTINCT eventId FROM qr_scan WHERE userId = ?',
          userId,
        )
      ).map((row) => row.eventId),
    );
  }

  list(userId: string, eventId: string, subEvents?: readonly SubEvent[]): Promise<HeldQrScan[]> {
    const read = async (db: QueueDatabase) => {
      const rows = await db.getAllAsync<Omit<HeldQrScan, 'kind'>>(
        'SELECT subEventId, version, venueId, secret, recordedAt FROM qr_scan WHERE userId = ? AND eventId = ? ORDER BY subEventId LIMIT ?',
        userId,
        eventId,
        MAX_SUB_EVENTS,
      );
      const valid: HeldQrScan[] = [];
      for (const row of rows) {
        const { subEventId, ...fields } = row;
        const parsed = QrScan.safeParse({ ...fields, kind: 'qr' });
        if (
          parsed.success &&
          (!subEvents || target(parsed.data, subEvents)?.id.toLowerCase() === subEventId)
        ) {
          valid.push({ ...parsed.data, subEventId });
        } else if (subEvents) {
          await db.runAsync(
            'DELETE FROM qr_scan WHERE userId = ? AND eventId = ? AND subEventId = ?',
            userId,
            eventId,
            subEventId,
          );
        }
      }
      return valid;
    };
    return subEvents
      ? this.store.verificationMutation(read, false)
      : this.store.verificationRead(read);
  }

  async save(
    userId: string,
    eventId: string,
    evidence: QrScan,
    subEvents: readonly SubEvent[],
  ): Promise<SubEvent> {
    const scan = QrScan.parse(evidence);
    const allowed = subEvents.slice(0, MAX_SUB_EVENTS);
    const subEvent = target(scan, allowed);
    if (!subEvent) throw new Error('No sub-event is live at this venue at the scan time.');
    await this.store.verificationMutation(async (db) => {
      const ids = allowed.map((sub) => sub.id.toLowerCase());
      await db.runAsync(
        `DELETE FROM qr_scan WHERE userId = ? AND eventId = ? AND subEventId NOT IN (${ids.map(() => '?').join(',')})`,
        userId,
        eventId,
        ...ids,
      );
      await db.runAsync(
        'INSERT OR REPLACE INTO qr_scan (userId,eventId,subEventId,version,venueId,secret,recordedAt) VALUES (?,?,?,?,?,?,?)',
        userId,
        eventId,
        subEvent.id.toLowerCase(),
        scan.version,
        scan.venueId.toLowerCase(),
        scan.secret,
        scan.recordedAt,
      );
    });
    return subEvent;
  }

  consume(userId: string, eventId: string, sent: readonly QrScan[]): Promise<void> {
    return this.store.verificationMutation(async (db) => {
      for (const scan of sent) {
        await db.runAsync(
          'DELETE FROM qr_scan WHERE userId = ? AND eventId = ? AND version = ? AND venueId = ? AND secret = ? AND recordedAt = ?',
          userId,
          eventId,
          scan.version,
          scan.venueId.toLowerCase(),
          scan.secret,
          scan.recordedAt,
        );
      }
    });
  }
}

export function qrRecords(scans: readonly HeldQrScan[]): QrScan[] {
  return scans.map(({ subEventId: _localTarget, ...scan }) => scan);
}
