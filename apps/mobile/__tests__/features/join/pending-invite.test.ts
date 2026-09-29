import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  clearPendingInvite,
  readPendingInvite,
  savePendingInvite,
} from '@/features/join/pending-invite';

// One Map stands in for the MMKV instance, so a test can put a corrupt value where the module
// reads.
const mockStorage = new Map<string, string>();
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => {
      mockStorage.set(key, value);
    },
    remove: (key: string) => mockStorage.delete(key),
  }),
  useMMKVString: () => [undefined, () => undefined],
}));

const TOKEN = 'a'.repeat(43);

beforeEach(() => {
  mockStorage.clear();
});

describe('pending invite', () => {
  it('reads back a saved link invite', () => {
    savePendingInvite({ lookup: { token: TOKEN }, eventName: 'Mehndi', role: 'guest' });
    expect(readPendingInvite()).toEqual({
      lookup: { token: TOKEN },
      eventName: 'Mehndi',
      role: 'guest',
    });
  });

  it('reads back a saved code invite', () => {
    savePendingInvite({ lookup: { code: 'AB3K7X' }, eventName: 'Walima', role: 'photographer' });
    expect(readPendingInvite()?.lookup).toEqual({ code: 'AB3K7X' });
  });

  it('is gone after it is cleared', () => {
    savePendingInvite({ lookup: { token: TOKEN }, eventName: 'Mehndi', role: 'guest' });
    clearPendingInvite();
    expect(readPendingInvite()).toBeNull();
  });

  it('reads nothing when nothing was saved', () => {
    expect(readPendingInvite()).toBeNull();
  });

  it('drops a stored value that is not JSON', () => {
    const [key] = saveThenKey();
    mockStorage.set(key, '{not json');
    expect(readPendingInvite()).toBeNull();
  });

  it('drops a stored invite with both a token and a code, which no lookup may carry', () => {
    const [key] = saveThenKey();
    mockStorage.set(
      key,
      JSON.stringify({
        lookup: { token: TOKEN, code: 'AB3K7X' },
        eventName: 'Mehndi',
        role: 'guest',
      }),
    );
    expect(readPendingInvite()).toBeNull();
  });

  it('drops a stored invite for the admin role, which no invite joins as (D-102)', () => {
    const [key] = saveThenKey();
    mockStorage.set(
      key,
      JSON.stringify({ lookup: { token: TOKEN }, eventName: 'Mehndi', role: 'admin' }),
    );
    expect(readPendingInvite()).toBeNull();
  });
});

// The key the module writes under, found by saving once rather than by importing a constant the
// tests would then only repeat.
function saveThenKey(): string[] {
  savePendingInvite({ lookup: { token: TOKEN }, eventName: 'Mehndi', role: 'guest' });
  return [...mockStorage.keys()];
}
