import type {
  GetEventResponse,
  ListSubEventsResponse,
  VerificationRecords,
} from '@momentlens/shared-types';

import type { QueueItem, VerificationScope } from '@/features/upload-queue/types';
import { gpsRecords, type GpsReadings } from './readings';
import { qrRecords, type QrScans } from './qr-scans';

export interface VerificationGateDeps {
  readings(): Promise<GpsReadings>;
  scans(): Promise<QrScans>;
  event(eventId: string): GetEventResponse | undefined;
  eventRevision?(eventId: string): number | undefined;
  schedule(eventId: string): ListSubEventsResponse | undefined;
  refetch(eventId: string): void;
}

interface ServerSnapshot {
  state: GetEventResponse['verification'];
  revision: number | undefined;
}

export class VerificationGate {
  private attemptedStates = new Map<string, ServerSnapshot>();
  private refusedStates = new Map<string, ServerSnapshot>();
  private refusedRecords = new Map<string, VerificationRecords>();

  constructor(private deps: VerificationGateDeps) {}

  private key(userId: string, eventId: string): string {
    return `${userId}\0${eventId.toLowerCase()}`;
  }

  private serverState(userId: string, eventId: string) {
    const key = this.key(userId, eventId);
    const snapshot = {
      state: this.deps.event(eventId)?.verification,
      revision: this.deps.eventRevision?.(eventId),
    };
    const previous = this.refusedStates.get(key);
    const refused =
      previous !== undefined &&
      previous.state === snapshot.state &&
      previous.revision === snapshot.revision;
    if (!refused) this.refusedStates.delete(key);
    return { snapshot, state: refused ? undefined : snapshot.state, refused };
  }

  private async held(userId: string, eventId: string) {
    const schedule = this.deps.schedule(eventId);
    const [gps, qr] = await Promise.all([
      this.deps.readings().then((store) =>
        store.list(
          userId,
          eventId,
          schedule?.subEvents.map((sub) => sub.id),
        ),
      ),
      this.deps.scans().then((store) => store.list(userId, eventId, schedule?.subEvents)),
    ]);
    const refused = this.refusedRecords.get(this.key(userId, eventId)) ?? [];
    return {
      gps: gps.filter((fix) => !refused.some((sent) => sameGps(sent, fix))),
      qr: qr.filter((scan) => !refused.some((sent) => sameQr(sent, scan))),
    };
  }

  // Null holds this photo without a request. An empty array lets the API decide, including a
  // cache without S-15's state, a resume and a removed sub-event (D-122, D-155).
  async beforePreflight(row: QueueItem): Promise<VerificationRecords | null> {
    const held = await this.held(row.userId, row.eventId);
    const { snapshot, state, refused } = this.serverState(row.userId, row.eventId);
    const schedule = this.deps.schedule(row.eventId);
    const subEventId = row.subEventId.toLowerCase();
    const removed =
      schedule && !schedule.subEvents.some((sub) => sub.id.toLowerCase() === subEventId);
    if (
      (state || refused) &&
      !state?.everySubEvent &&
      !state?.subEventIds.some((id) => id.toLowerCase() === subEventId) &&
      ![...held.gps, ...held.qr].some((record) => record.subEventId === subEventId) &&
      row.mediaId === null &&
      !removed
    )
      return null;
    this.attemptedStates.set(this.key(row.userId, row.eventId), snapshot);
    return [...gpsRecords(held.gps), ...qrRecords(held.qr)];
  }

  async coverage(
    userId: string,
    eventId: string,
    refused: VerificationRecords = [],
  ): Promise<VerificationScope> {
    const { state } = this.serverState(userId, eventId);
    if (state?.everySubEvent) return 'all';
    const held = await this.held(userId, eventId);
    return [
      ...new Set([
        ...(state?.subEventIds ?? []).map((id) => id.toLowerCase()),
        ...held.gps
          .filter((fix) => !refused.some((sent) => sameGps(sent, fix)))
          .map((fix) => fix.subEventId),
        ...held.qr
          .filter((scan) => !refused.some((sent) => sameQr(sent, scan)))
          .map((scan) => scan.subEventId),
      ]),
    ];
  }

  async settled(
    userId: string,
    eventId: string,
    records: VerificationRecords,
    answer: { status?: number; code?: unknown } | null,
  ): Promise<void> {
    const key = this.key(userId, eventId);
    const snapshot = this.attemptedStates.get(key);
    this.attemptedStates.delete(key);
    const unverified = answer?.status === 409 && answer.code === 'unverified';
    // A refusal invalidates the snapshot used for this attempt. A newer response can still
    // release the photo if it arrived while pre-flight was running (D-155).
    if (unverified && snapshot?.state !== undefined) this.refusedStates.set(key, snapshot);
    if (unverified) this.refusedRecords.set(key, records);
    if (!records.length && !unverified) return;
    const consumed =
      answer === null ||
      answer.status === 200 ||
      answer.status === 201 ||
      answer.status === 422 ||
      (answer.status === 409 &&
        ['unverified', 'duplicate', 'sub_event_missing'].includes(String(answer.code)));
    try {
      if (consumed) {
        await Promise.all([
          this.deps.readings().then((store) =>
            store.consume(
              userId,
              eventId,
              records.filter((record) => record.kind === 'gps'),
            ),
          ),
          this.deps.scans().then((store) =>
            store.consume(
              userId,
              eventId,
              records.filter((record) => record.kind === 'qr'),
            ),
          ),
        ]);
      }
    } finally {
      // Every answered or interrupted pre-flight carrying a fix rechecks both server decisions
      // and venue edits. The next GPS attempt keeps its one-minute cadence (D-155).
      this.deps.refetch(eventId);
    }
  }
}

function sameGps(
  sent: VerificationRecords[number],
  fix: import('@momentlens/shared-types').GpsReading,
) {
  return (
    sent.kind === 'gps' &&
    sent.subEventId.toLowerCase() === fix.subEventId &&
    sent.recordedAt === fix.recordedAt &&
    sent.lat === fix.lat &&
    sent.lng === fix.lng &&
    sent.accuracyM === fix.accuracyM
  );
}
function sameQr(
  sent: VerificationRecords[number],
  scan: import('@momentlens/shared-types').QrScan,
) {
  return (
    sent.kind === 'qr' &&
    sent.version === scan.version &&
    sent.venueId.toLowerCase() === scan.venueId.toLowerCase() &&
    sent.secret === scan.secret &&
    sent.recordedAt === scan.recordedAt
  );
}
