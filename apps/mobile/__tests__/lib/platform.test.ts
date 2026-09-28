import { describe, expect, it } from '@jest/globals';

import { tabBarHasActionSlot } from '@/lib/platform';

describe('tabBarHasActionSlot', () => {
  it('is true from iOS 26, where the search-role item sits apart', () => {
    expect(tabBarHasActionSlot('ios', '26.0')).toBe(true);
    expect(tabBarHasActionSlot('ios', '26.5')).toBe(true);
    expect(tabBarHasActionSlot('ios', '27')).toBe(true);
  });

  it('is false before iOS 26, where the item would sit among the tabs as "Search"', () => {
    expect(tabBarHasActionSlot('ios', '18.6')).toBe(false);
    expect(tabBarHasActionSlot('ios', '25.9')).toBe(false);
  });

  it('is false on Android whatever its API level, since Android gets the FAB', () => {
    expect(tabBarHasActionSlot('android', 36)).toBe(false);
  });

  it('is false for a version it cannot read', () => {
    expect(tabBarHasActionSlot('ios', '')).toBe(false);
  });
});
