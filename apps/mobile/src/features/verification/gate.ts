import type {
  GetEventResponse,
  ListSubEventsResponse,
  VerificationRecords,
} from '@momentlens/shared-types';

import type { QueueItem, VerificationScope } from '@/features/upload-queue/types';
import { gpsRecords, type GpsReadings } from './readings';

export interface VerificationGateDeps {
  readings(): Promise<GpsReadings>;
  event(eventId: string): GetEventResponse | undefined;
  schedule(eventId: string): ListSubEventsResponse | undefined;
  refetch(eventId: string): void;
}

export class VerificationGate {
  constructor(private deps: VerificationGateDeps) {}

  private async held(userId: string, eventId: string) {
    const schedule = this.deps.schedule(eventId);
    return (await this.deps.readings()).list(
      userId,
      eventId,
      schedule?.subEvents.map((sub) => sub.id),
    );
  }

  // Null holds this photo without a request. An empty array lets the API decide, including a
  // cache without S-15's state, a resume and a removed sub-event (D-122, D-155).
  async beforePreflight(row: QueueItem): Promise<VerificationRecords | null> {
    const held = await this.held(row.userId, row.eventId);
    const state = this.deps.event(row.eventId)?.verification;
    const schedule = this.deps.schedule(row.eventId);
    const subEventId = row.subEventId.toLowerCase();
    const removed =
      schedule && !schedule.subEvents.some((sub) => sub.id.toLowerCase() === subEventId);
    if (
      state &&
      !state.everySubEvent &&
      !state.subEventIds.some((id) => id.toLowerCase() === subEventId) &&
      !held.some((reading) => reading.subEventId === subEventId) &&
      row.mediaId === null &&
      !removed
    )
      return null;
    return gpsRecords(held);
  }

  async coverage(
    userId: string,
    eventId: string,
    refused: VerificationRecords = [],
  ): Promise<VerificationScope> {
    const state = this.deps.event(eventId)?.verification;
    if (state?.everySubEvent) return 'all';
    return [
      ...new Set([
        ...(state?.subEventIds ?? []).map((id) => id.toLowerCase()),
        ...(await this.held(userId, eventId))
          .filter(
            (fix) =>
              !refused.some(
                (sent) =>
                  sent.kind === 'gps' &&
                  sent.subEventId.toLowerCase() === fix.subEventId &&
                  sent.recordedAt === fix.recordedAt &&
                  sent.lat === fix.lat &&
                  sent.lng === fix.lng &&
                  sent.accuracyM === fix.accuracyM,
              ),
          )
          .map((reading) => reading.subEventId),
      ]),
    ];
  }

  async settled(
    userId: string,
    eventId: string,
    records: VerificationRecords,
    answer: { status?: number; code?: unknown } | null,
  ): Promise<void> {
    if (!records.length) return;
    const consumed =
      answer === null ||
      answer.status === 422 ||
      (answer.status === 409 &&
        ['unverified', 'duplicate', 'sub_event_missing'].includes(String(answer.code)));
    try {
      if (consumed) await (await this.deps.readings()).consume(userId, eventId, records);
    } finally {
      // Every answered or interrupted pre-flight carrying a fix rechecks both server decisions
      // and venue edits. The next GPS attempt keeps its one-minute cadence (D-155).
      this.deps.refetch(eventId);
    }
  }
}
