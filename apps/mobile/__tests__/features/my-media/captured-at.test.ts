import { describe, expect, it, jest } from '@jest/globals';
import { pickedCapturedAt } from '@/features/my-media/picker';
jest.mock('expo-image-picker', () => ({}));

describe('picked capture timestamp', () => {
  it('keeps the capture instant with its EXIF offset and excludes GPS', () => {
    expect(
      pickedCapturedAt({
        DateTimeOriginal: '2026:10:05 13:00:00',
        OffsetTimeOriginal: '+05:00',
        GPSLatitude: 1,
      }),
    ).toBe('2026-10-05T08:00:00.000Z');
  });
  it('uses local calendar parts when EXIF has no offset', () => {
    expect(pickedCapturedAt({ DateTimeOriginal: '2026:10:05 13:00:00' })).toBe(
      new Date(2026, 9, 5, 13).toISOString(),
    );
  });
  it('leaves missing or malformed timestamps to the API fallback', () => {
    expect(pickedCapturedAt(null)).toBeNull();
    expect(pickedCapturedAt({ DateTimeOriginal: 'bad' })).toBeNull();
    expect(pickedCapturedAt({ DateTimeOriginal: '2026:02:30 13:00:00' })).toBeNull();
    expect(pickedCapturedAt({ DateTimeOriginal: '2026:10:05 99:00:00' })).toBeNull();
  });
});
