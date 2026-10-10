import { describe, expect, it } from '@jest/globals';
import { admitShot, nativePictureSize, fitPreview } from '@/features/capture/context';

const first = {
  id: 'a',
  name: 'Nikah',
  startsAt: '2026-10-10T10:00:00Z',
  endsAt: '2026-10-10T11:00:00Z',
};
const second = { ...first, id: 'b', startsAt: '2026-10-10T10:30:00Z' };
describe('shutter context', () => {
  it('refuses inaccessible or schedule-less direct routes', () => {
    expect(admitShot(null, 'event', [first], 'public', new Date(first.startsAt), false)).toBeNull();
    expect(admitShot('A', 'event', [], 'public', new Date(first.startsAt), true)).toBeNull();
    expect(admitShot('A', 'event', [first], 'public', new Date(first.startsAt), false)).toBeNull();
  });
  it('admits the start, refuses the end, and picks the latest overlapping start', () => {
    expect(
      admitShot('A', 'event', [first], 'public', new Date(first.startsAt), true)?.subEventId,
    ).toBe('a');
    expect(admitShot('A', 'event', [first], 'public', new Date(first.endsAt), true)).toBeNull();
    expect(
      admitShot('A', 'event', [first, second], 'local_only', new Date(second.startsAt), true)
        ?.subEventId,
    ).toBe('b');
  });
  it('freezes the mode and sub-event for one shot without changing the next', () => {
    const cached = [{ ...first }];
    const shot = admitShot('A', 'event', cached, 'public', new Date(first.startsAt), true)!;
    cached[0] = { ...first, id: 'changed' };
    expect(Object.isFrozen(shot)).toBe(true);
    expect(shot.mode).toBe('public');
    expect(shot.subEventId).toBe('a');
    expect(
      admitShot('A', 'event', cached, 'local_only', new Date(first.startsAt), true),
    ).toMatchObject({ mode: 'local_only', subEventId: 'changed' });
  });
  it('selects the largest supported output and fits it without cropping', () => {
    expect(nativePictureSize(['1920x1080', '4000x3000', '640x480'])).toBe('4000x3000');
    expect(nativePictureSize(['High', 'Medium', 'Low'])).toBeNull();
    expect(fitPreview('4000x3000', 390, 450)).toEqual({ width: 337.5, height: 450 });
  });
  it('requests the 4:3 output CameraX binds, not a larger sensor-shaped one', () => {
    // A Pixel front camera lists its 3440x2448 sensor, but CameraX binds 3264x2448.
    expect(nativePictureSize(['1920x1080', '3264x2448', '3440x2448', '3264x1836'])).toBe(
      '3264x2448',
    );
    // CameraX counts the back camera's 4080x3072 as 4:3.
    expect(nativePictureSize(['4080x3072', '4000x2250', '1920x1440'])).toBe('4080x3072');
    expect(nativePictureSize(['3000x2000', '1920x1080'])).toBe('3000x2000');
  });
});
