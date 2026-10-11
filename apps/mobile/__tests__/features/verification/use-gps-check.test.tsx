import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GetEventResponse, GpsReading, SubEvent } from '@momentlens/shared-types';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { LocationObject } from 'expo-location';

import { useGpsCheck } from '@/features/verification/use-gps-check';

const EVENT = '00000000-0000-4000-8000-000000000001';
const SUB = '00000000-0000-4000-8000-000000000003';
const AT = Date.parse('2026-10-11T12:30:00.000Z');
const mockSchedule: { subEvents: SubEvent[] } = {
  subEvents: [
    {
      id: SUB,
      name: 'Mehndi',
      description: null,
      startsAt: '2026-10-11T12:00:00.000Z',
      endsAt: '2026-10-11T13:00:00.000Z',
      verificationRadiusM: 200,
      venue: { id: EVENT, name: 'Hall', lat: 31, lng: 74 },
    },
  ],
};
let mockEvent: Pick<GetEventResponse, 'verification'>;
let mockHeld: GpsReading[];
let mockAsked: boolean;
let mockChanged: (() => void) | undefined;
const mockPermission = jest.fn(async () => ({ granted: true, canAskAgain: true }));
const mockRequest = jest.fn(async () => ({ granted: false, canAskAgain: false }));
const mockPosition = jest.fn<() => Promise<LocationObject>>();
const mockRelease = jest.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(1);
const mockSave = jest.fn(async (_owner: string, _eventId: string, fixes: readonly GpsReading[]) => {
  mockHeld = [...fixes];
  mockChanged?.();
});

jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  getForegroundPermissionsAsync: () => mockPermission(),
  requestForegroundPermissionsAsync: () => mockRequest(),
  getCurrentPositionAsync: () => mockPosition(),
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getBoolean: () => mockAsked,
    set: (_key: string, value: boolean) => {
      mockAsked = value;
    },
  }),
}));
jest.mock('@/features/event-shell/use-event', () => ({ useEvent: () => ({ data: mockEvent }) }));
jest.mock('@/features/schedule/use-sub-events', () => ({
  useSubEvents: () => ({ data: mockSchedule }),
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => new Date('2026-10-11T12:30:00.000Z') }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (state: { userId: string }) => unknown) => select({ userId: 'A' }),
    { getState: () => ({ userId: 'A' }) },
  ),
}));
jest.mock('@/features/upload-queue/queue', () => ({
  getGpsReadings: async () => ({ list: async () => mockHeld, save: mockSave }),
  getQueue: async () => ({
    subscribe: (listener: () => void) => {
      mockChanged = listener;
      return () => {
        mockChanged = undefined;
      };
    },
  }),
  release: (...args: unknown[]) => mockRelease(...args),
}));

interface Tree {
  update(element: ReactElement): void;
  unmount(): void;
}
const renderer = jest.requireActual<{
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): Tree;
}>(createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'));
let tree: Tree | undefined;
let changeState: (state: AppStateStatus) => void;
const fix = (lat = 32): LocationObject => ({
  coords: {
    latitude: lat,
    longitude: 74,
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: Date.now(),
});
function Probe() {
  useGpsCheck(EVENT);
  return null;
}
async function flush(action: () => void = () => {}) {
  await renderer.act(async () => {
    action();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}
async function open() {
  await flush(() => {
    tree = renderer.create(createElement(Probe));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(AT);
  AppState.currentState = 'active';
  mockEvent = { verification: { everySubEvent: false, subEventIds: [] } };
  mockHeld = [];
  mockAsked = false;
  mockChanged = undefined;
  mockPermission.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  mockRequest.mockClear();
  mockRelease.mockClear();
  mockSave.mockClear();
  mockPosition.mockReset().mockImplementation(async () => fix());
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    changeState = listener;
    return { remove: jest.fn() };
  });
});
afterEach(async () => {
  await flush(() => tree?.unmount());
  tree = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('GPS lifecycle and cadence', () => {
  it('reads once on open and every 60 seconds despite cache and queue updates', async () => {
    await open();
    expect(mockPosition).toHaveBeenCalledTimes(1);
    await flush(() => {
      jest.advanceTimersByTime(30_000);
      mockEvent = { verification: { everySubEvent: false, subEventIds: [] } };
      tree!.update(createElement(Probe));
      mockChanged?.();
    });
    expect(mockPosition).toHaveBeenCalledTimes(1);
    await flush(() => jest.advanceTimersByTime(29_999));
    expect(mockPosition).toHaveBeenCalledTimes(1);
    await flush(() => jest.advanceTimersByTime(1));
    expect(mockPosition).toHaveBeenCalledTimes(2);
  });

  it('stops in the background and reads once on foreground', async () => {
    await open();
    await flush(() => {
      AppState.currentState = 'background';
      changeState('background');
    });
    await flush(() => jest.advanceTimersByTime(120_000));
    expect(mockPosition).toHaveBeenCalledTimes(1);
    await flush(() => {
      AppState.currentState = 'active';
      changeState('active');
    });
    expect(mockPosition).toHaveBeenCalledTimes(2);
  });

  it('stops after a local fix, resumes at the next minute when it is consumed, and stops on server coverage', async () => {
    mockPosition.mockImplementation(async () => fix(31));
    await open();
    expect(mockSave).toHaveBeenCalledTimes(1);
    await flush(() => jest.advanceTimersByTime(10_000));
    await flush(() => {
      mockHeld = [];
      mockChanged?.();
    });
    await flush(() => jest.advanceTimersByTime(49_999));
    expect(mockPosition).toHaveBeenCalledTimes(1);
    await flush(() => jest.advanceTimersByTime(1));
    expect(mockPosition).toHaveBeenCalledTimes(2);
    await flush(() => {
      mockHeld = [];
      mockEvent = { verification: { everySubEvent: true, subEventIds: [] } };
      tree!.update(createElement(Probe));
    });
    await flush(() => jest.advanceTimersByTime(120_000));
    expect(mockPosition).toHaveBeenCalledTimes(2);
  });

  it('never repeats the system permission prompt after denial or a hook remount', async () => {
    mockPermission.mockResolvedValue({ granted: false, canAskAgain: true });
    await open();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await flush(() => jest.advanceTimersByTime(60_000));
    await flush(() => tree!.unmount());
    await open();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockPosition).not.toHaveBeenCalled();
  });
});
