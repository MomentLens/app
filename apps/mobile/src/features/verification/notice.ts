import { subEventStatus, type GetEventResponse, type SubEvent } from '@momentlens/shared-types';

import type { QueueItem } from '@/features/upload-queue/types';

export interface CheckInNotice {
  liveNames: string[];
  endedPhotos: number;
  liveVenues: string[];
  waitingPhotos: number;
  localNames: string[];
}

export function checkInNotice(
  subEvents: readonly SubEvent[],
  at: Date,
  verification: GetEventResponse['verification'],
  heldIds: readonly string[],
  photos: readonly QueueItem[],
): CheckInNotice | null {
  if (verification?.everySubEvent) return null;
  const covered = new Set(
    [...(verification?.subEventIds ?? []), ...heldIds].map((id) => id.toLowerCase()),
  );
  const live = verification
    ? subEvents.filter(
        (sub) => subEventStatus(sub, at) === 'in_progress' && !covered.has(sub.id.toLowerCase()),
      )
    : [];
  const liveNames = live.map((sub) => sub.name);
  const confirmed = new Set((verification?.subEventIds ?? []).map((id) => id.toLowerCase()));
  const localNames = verification
    ? subEvents
        .filter(
          (sub) =>
            subEventStatus(sub, at) === 'in_progress' &&
            !confirmed.has(sub.id.toLowerCase()) &&
            heldIds.includes(sub.id.toLowerCase()),
        )
        .map((sub) => sub.name)
    : [];
  const liveIds = new Set(live.map((sub) => sub.id.toLowerCase()));
  const waitingPhotos = photos.filter(
    (photo) =>
      photo.state === 'waiting_verification' && liveIds.has(photo.subEventId.toLowerCase()),
  ).length;
  const endedPhotos = photos.filter((photo) => {
    if (photo.state !== 'waiting_verification' || covered.has(photo.subEventId.toLowerCase()))
      return false;
    const sub = subEvents.find(
      (candidate) => candidate.id.toLowerCase() === photo.subEventId.toLowerCase(),
    );
    return sub && subEventStatus(sub, at) === 'completed';
  }).length;
  return liveNames.length || endedPhotos || localNames.length
    ? {
        liveNames,
        endedPhotos,
        waitingPhotos,
        localNames,
        liveVenues: [...new Set(live.map((sub) => sub.venue.name))],
      }
    : null;
}
