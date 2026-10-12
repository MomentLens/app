import {
  GpsReading,
  readingMatches,
  subEventStatus,
  type GetEventResponse,
  type SubEvent,
} from '@momentlens/shared-types';
import type { LocationObject, LocationPermissionResponse } from 'expo-location';

import type { GpsReadings } from './readings';
import type { QrScans } from './qr-scans';

export interface GpsContext {
  eventId: string;
  verification: GetEventResponse['verification'];
  subEvents: readonly SubEvent[];
}
type Permission = Pick<LocationPermissionResponse, 'granted' | 'canAskAgain' | 'android' | 'ios'>;
export interface GpsCheckDeps {
  userId(): string | null;
  active(): boolean;
  context(): GpsContext;
  readings(): Promise<GpsReadings>;
  scans(): Promise<QrScans>;
  permission(): Promise<Permission>;
  requestPermission(): Promise<Permission>;
  asked(): boolean;
  markAsked(): void;
  position(): Promise<LocationObject>;
  release(userId: string, eventId: string, subEventIds: readonly string[]): Promise<void>;
  now(): number;
}

export class GpsCheck {
  private disposed = false;
  private running: Promise<void> | null = null;
  constructor(private deps: GpsCheckDeps) {}

  dispose(): void {
    this.disposed = true;
  }

  private live(userId: string, eventId: string): boolean {
    return (
      !this.disposed &&
      this.deps.active() &&
      this.deps.userId() === userId &&
      this.deps.context().eventId === eventId
    );
  }

  private async needed(userId: string, context: GpsContext): Promise<SubEvent[]> {
    const state = context.verification;
    if (!state || state.everySubEvent || !this.live(userId, context.eventId)) return [];
    const held = await (
      await this.deps.readings()
    ).list(
      userId,
      context.eventId,
      context.subEvents.map((sub) => sub.id),
    );
    const covered = new Set(
      [
        ...state.subEventIds,
        ...held.map((fix) => fix.subEventId),
        ...(await (await this.deps.scans()).list(userId, context.eventId, context.subEvents)).map(
          (scan) => scan.subEventId,
        ),
      ].map((id) => id.toLowerCase()),
    );
    return context.subEvents.filter(
      (sub) =>
        !covered.has(sub.id.toLowerCase()) &&
        subEventStatus(sub, new Date(this.deps.now())) === 'in_progress',
    );
  }

  async pending(): Promise<boolean> {
    const userId = this.deps.userId();
    if (!userId) return false;
    return (await this.needed(userId, this.deps.context())).length > 0;
  }

  run(): Promise<void> {
    if (!this.running) {
      this.running = this.check().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async check(): Promise<void> {
    const userId = this.deps.userId();
    if (!userId) return;
    const context = this.deps.context();
    if (!(await this.needed(userId, context)).length || !this.live(userId, context.eventId)) return;
    let permission = await this.deps.permission();
    if (
      !(await this.needed(userId, this.deps.context())).length ||
      !this.live(userId, context.eventId)
    )
      return;
    if (!permission.granted && permission.canAskAgain && !this.deps.asked()) {
      // Mark before the native prompt, so a kill never prompts a second time (D-155).
      this.deps.markAsked();
      permission = await this.deps.requestPermission();
    }
    if (
      !permission.granted ||
      permission.android?.accuracy === 'coarse' ||
      permission.android?.accuracy === 'none' ||
      permission.ios?.accuracy === 'reduced' ||
      !this.live(userId, context.eventId)
    )
      return;
    if (
      !(await this.needed(userId, this.deps.context())).length ||
      !this.live(userId, context.eventId)
    )
      return;
    const fix = await this.deps.position();
    if (
      fix.mocked ||
      fix.coords.accuracy === null ||
      !Number.isFinite(fix.timestamp) ||
      Math.abs(fix.timestamp) > 8.64e15 ||
      !this.live(userId, context.eventId)
    )
      return;

    const latest = this.deps.context();
    if (!latest.verification || latest.verification.everySubEvent) return;
    const matches = latest.subEvents.flatMap((sub) => {
      const parsed = GpsReading.safeParse({
        subEventId: sub.id,
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracyM: fix.coords.accuracy,
        recordedAt: new Date(fix.timestamp).toISOString(),
      });
      return parsed.success && readingMatches(parsed.data, sub) ? [parsed.data] : [];
    });
    if (!matches.length) return;
    await (
      await this.deps.readings()
    ).save(
      userId,
      context.eventId,
      matches,
      latest.subEvents.map((sub) => sub.id),
    );
    if (this.live(userId, context.eventId))
      await this.deps.release(
        userId,
        context.eventId,
        matches.map((reading) => reading.subEventId),
      );
  }
}
