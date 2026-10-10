import { describe, expect, it } from '@jest/globals';
import { startingMode, noticeKey } from '@/features/capture/preferences';
describe('camera preferences', () => {
  it('defaults missing and invalid modes to Public', () => {
    expect(startingMode(undefined)).toBe('public');
    expect(startingMode('private')).toBe('public');
    expect(startingMode('local_only')).toBe('local_only');
  });
  it('remembers the Local Only notice per account', () => {
    expect(noticeKey('A')).not.toBe(noticeKey('B'));
  });
});
