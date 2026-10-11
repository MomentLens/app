import { subEventStatus, type GetEventResponse, type SubEvent } from '@momentlens/shared-types';

import type { QueueItem } from '@/features/upload-queue/types';

export interface CheckInNotice {
  liveNames: string[];
  endedPhotos: number;
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
  const liveNames = verification
    ? subEvents
        .filter(
          (sub) => subEventStatus(sub, at) === 'in_progress' && !covered.has(sub.id.toLowerCase()),
        )
        .map((sub) => sub.name)
    : [];
  const endedPhotos = photos.filter((photo) => {
    if (photo.state !== 'waiting_verification' || covered.has(photo.subEventId.toLowerCase()))
      return false;
    const sub = subEvents.find(
      (candidate) => candidate.id.toLowerCase() === photo.subEventId.toLowerCase(),
    );
    return sub && subEventStatus(sub, at) === 'completed';
  }).length;
  return liveNames.length || endedPhotos ? { liveNames, endedPhotos } : null;
}
