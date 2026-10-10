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
    const shot = admitShot('A', 'event', [first], 'public', new Date(first.startsAt), true)!;
    first.name = 'Changed name';
    expect(Object.isFrozen(shot)).toBe(true);
    expect(shot.mode).toBe('public');
    expect(
      admitShot('A', 'event', [first], 'local_only', new Date(first.startsAt), true)?.mode,
    ).toBe('local_only');
  });
  it('selects the largest supported output and fits it without cropping', () => {
    expect(nativePictureSize(['1920x1080', '4000x3000', '640x480'])).toBe('4000x3000');
    expect(nativePictureSize(['High', 'Medium', 'Low'])).toBeNull();
    expect(fitPreview('4000x3000', 390, 450)).toEqual({ width: 337.5, height: 450 });
  });
});
