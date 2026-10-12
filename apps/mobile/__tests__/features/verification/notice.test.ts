import { describe, expect, it } from '@jest/globals';
import type { SubEvent } from '@momentlens/shared-types';

import { checkInNotice } from '@/features/verification/notice';
import type { QueueItem } from '@/features/upload-queue/types';

const sub: SubEvent = {
  id: 'sub',
  name: 'Mehndi',
  description: null,
  startsAt: '2026-10-11T12:00:00.000Z',
  endsAt: '2026-10-11T13:00:00.000Z',
  verificationRadiusM: 200,
  venue: { id: 'venue', name: 'Hall', lat: 31, lng: 74 },
};
const state = { everySubEvent: false, subEventIds: [] };
const at = new Date('2026-10-11T12:30:00.000Z');

describe('My Media check-in notice', () => {
  it('shows an unchecked live sub-event even when no photos are waiting', () => {
    expect(checkInNotice([sub], at, state, [], [])).toEqual({
      liveNames: ['Mehndi'],
      endedPhotos: 0,
      liveVenues: ['Hall'],
      waitingPhotos: 0,
      localNames: [],
    });
  });
  it('hides confirmed check-ins and distinguishes local recording', () => {
    expect(checkInNotice([sub], at, { everySubEvent: true, subEventIds: [] }, [], [])).toBeNull();
    expect(checkInNotice([sub], at, state, ['sub'], [])).toMatchObject({
      liveNames: [],
      localNames: ['Mehndi'],
    });
    expect(
      checkInNotice([sub], at, { everySubEvent: false, subEventIds: ['sub'] }, [], []),
    ).toBeNull();
  });
  it('leaves an Events-list seed to the server before showing a live notice', () => {
    expect(checkInNotice([sub], at, undefined, [], [])).toBeNull();
  });
  it('shows the organizer notice only for photos waiting on an ended sub-event', () => {
    const photos = [{ subEventId: 'sub', state: 'waiting_verification' }] as QueueItem[];
    const end = new Date(sub.endsAt);
    expect(checkInNotice([sub], end, state, [], photos)).toMatchObject({
      liveNames: [],
      endedPhotos: 1,
    });
    expect(checkInNotice([sub], end, state, [], [])).toBeNull();
    expect(checkInNotice([sub], end, state, ['sub'], photos)).toBeNull();
    expect(checkInNotice([], end, state, [], photos)).toBeNull();
  });
  it("counts only this notice's uncovered live photos and deduplicates venue names", () => {
    const photos = [
      { subEventId: 'sub', state: 'waiting_verification' },
      { subEventId: 'another', state: 'waiting_verification' },
      { subEventId: 'sub', state: 'uploaded' },
    ] as QueueItem[];
    expect(checkInNotice([sub], at, state, [], photos)).toMatchObject({
      waitingPhotos: 1,
      liveVenues: ['Hall'],
    });
  });
});
