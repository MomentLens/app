import { describe, expect, it, jest } from '@jest/globals';

import { checkInRows } from '@/features/my-media/check-in-banner';
import { queueSummary } from '@/features/my-media/queue-banner';
import type { CheckInNotice } from '@/features/verification/notice';

// D-159 merges the queue and check-in banners into one. Which messages show, and the words D-157
// fixed, stay as they were.

const location = { off: false, busy: false, enable: async () => undefined };
const notice = (overrides: Partial<CheckInNotice> = {}): CheckInNotice => ({
  liveNames: [],
  endedPhotos: 0,
  liveVenues: [],
  waitingPhotos: 0,
  localNames: [],
  ...overrides,
});

describe('the queue summary', () => {
  it('counts each state once in D-157’s words and leaves out zeros', () => {
    expect(queueSummary({ queued: 3, waitingAlbum: 0, waitingVerification: 2, uploading: 1 })).toBe(
      '3 queued · 2 waiting to check in · 1 uploading',
    );
    expect(queueSummary({ queued: 0, waitingAlbum: 1, waitingVerification: 0, uploading: 0 })).toBe(
      '1 waiting for album',
    );
    expect(queueSummary({ queued: 0, waitingAlbum: 0, waitingVerification: 0, uploading: 0 })).toBe(
      '',
    );
  });
});

describe('the check-in rows', () => {
  it('shows nothing without a notice, as for an exempt role', () => {
    expect(checkInRows(null, location, () => undefined)).toEqual([]);
  });

  it('offers Scan Venue QR, the only way to the scanner, while a sub-event is live', () => {
    const onScan = jest.fn();
    const rows = checkInRows(notice({ liveNames: ['Mehndi'] }), location, onScan);
    expect(rows.map((row) => row.key)).toEqual(['scan']);
    expect(rows[0]!.title).toBe('Not checked in · Mehndi');
    expect(rows[0]!.detail).toBe('Still waiting? Ask the organizer to check you in.');
    rows[0]!.actions![0]!.onPress();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('puts Turn On Location first when location is off, and carries its error', () => {
    const rows = checkInRows(
      notice({ liveNames: ['Mehndi'] }),
      { ...location, off: true, error: 'Location could not be turned on.' },
      () => undefined,
    );
    expect(rows.map((row) => row.key)).toEqual(['location', 'scan']);
    expect(rows[1]!.detail).toBeUndefined();
    expect(rows[1]!.error).toBe('Location could not be turned on.');
  });

  it('keeps D-157’s words for photos held by a sub-event that has ended, with no button', () => {
    const rows = checkInRows(notice({ endedPhotos: 2 }), location, () => undefined);
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'ended',
        title: 'Ask the organizer to check you in.',
        detail: '2 photos from a sub-event that has ended',
      }),
    ]);
    expect(rows[0]!.actions).toBeUndefined();
  });

  it('says a check-in saved on this phone goes with the next upload', () => {
    const rows = checkInRows(notice({ localNames: ['Barat'] }), location, () => undefined);
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      ['Check-in saved · Barat', 'Sent with the next upload'],
    ]);
  });
});
