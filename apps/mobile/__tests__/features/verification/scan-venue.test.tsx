import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { AppState } from 'react-native';
import type { SubEvent } from '@momentlens/shared-types';
import { ScanVenueScreen } from '@/features/verification/scan-venue-screen';

const EVENT = '11111111-1111-4111-8111-111111111111';
const VENUE = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';
const sub: SubEvent = {
  id: SUB,
  name: 'Mehndi',
  description: null,
  startsAt: '2026-10-11T12:00:00.000Z',
  endsAt: '2026-10-11T13:00:00.000Z',
  venue: { id: VENUE, name: 'Hall', lat: 31, lng: 74 },
  verificationRadiusM: 200,
};
let mockRole = 'guest';
let mockOwner = 'A';
let mockGranted = true;
let mockRefused = false;
let mockSchedule = [sub];
let mockCamera: { onBarcodeScanned?: (event: { data: string }) => void };
const mockPush = jest.fn();
const mockDismiss = jest.fn();
const mockSave = jest.fn(async () => sub);
const mockRelease = jest.fn(async () => 3);
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, dismissTo: mockDismiss }),
  useFocusEffect: (callback: () => unknown) =>
    jest
      .requireActual<typeof import('react')>('react')
      .useEffect(callback as () => void, [callback]),
}));
jest.mock('expo-camera', () => ({
  CameraView: (props: typeof mockCamera) => {
    mockCamera = props;
    return jest.requireActual<typeof import('react')>('react').createElement('CameraView', props);
  },
  useCameraPermissions: () => [
    { granted: mockGranted, canAskAgain: false },
    async () => {},
    async () => {},
  ],
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 24 }),
}));
jest.mock('@/components/ui/glyph', () => ({ GLYPH: { close: {}, check: {} }, Glyph: () => null }));
jest.mock('@/components/ui/button', () => ({
  Button: ({ label }: { label: string }) =>
    jest.requireActual<typeof import('react')>('react').createElement('Text', null, label),
}));
jest.mock('@/components/ui/form-message', () => ({
  FormMessage: ({ message }: { message: string }) =>
    jest.requireActual<typeof import('react')>('react').createElement('Text', null, message),
}));
jest.mock('@/features/event-shell/use-event', () => ({
  lostAccess: (error: unknown) => (error ? 'not_member' : null),
  useEvent: () => ({
    data: { event: { role: mockRole }, verification: { everySubEvent: false, subEventIds: [] } },
    isPending: false,
    error: mockRefused ? { status: 403 } : undefined,
  }),
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => new Date('2026-10-11T12:30:00.000Z') }));
jest.mock('@/features/schedule/use-sub-events', () => ({
  useSubEvents: () => ({ data: { subEvents: mockSchedule }, isPending: false }),
}));
jest.mock('@/features/upload-queue/queue', () => ({
  getQrScans: async () => ({ save: () => mockSave() }),
  release: () => mockRelease(),
}));
jest.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (state: { userId: string }) => unknown) => select({ userId: mockOwner }),
    { getState: () => ({ userId: mockOwner }) },
  ),
}));

interface Tree {
  toJSON(): unknown;
  unmount(): void;
}
const renderer = jest.requireActual<{
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): Tree;
}>(createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'));
let tree: Tree | undefined;
const payload = JSON.stringify({
  kind: 'venue_check_in',
  version: 1,
  venueId: VENUE,
  secret: 'a'.repeat(64),
});
async function flush(action: () => void = () => {}) {
  await renderer.act(async () => {
    action();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-11T12:30:00.000Z'));
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockRole = 'guest';
  mockOwner = 'A';
  mockGranted = true;
  mockRefused = false;
  mockSchedule = [sub];
  mockSave.mockReset().mockResolvedValue(sub);
  mockRelease.mockClear();
  mockPush.mockClear();
  mockCamera = {};
});
afterEach(async () => {
  await flush(() => tree?.unmount());
  tree = undefined;
  jest.restoreAllMocks();
});
async function open() {
  await flush(() => {
    tree = renderer.create(createElement(ScanVenueScreen, { eventId: EVENT }));
  });
}

describe('full-screen venue scanner', () => {
  it('refuses cached Guest access after the event endpoint removes membership', async () => {
    mockRefused = true;
    await open();
    expect(mockCamera.onBarcodeScanned).toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled();
  });
  it.each(['admin', 'photographer'])('refuses direct scanner entry for %s', async (role) => {
    mockRole = role;
    await open();
    expect(mockCamera.onBarcodeScanned).toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled();
  });
  it('leaves photos available when camera permission is denied', async () => {
    mockGranted = false;
    await open();
    expect(mockCamera.onBarcodeScanned).toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled();
  });
  it('rejects wrong-event and idle-venue scans without saving', async () => {
    await open();
    await flush(() => mockCamera.onBarcodeScanned?.({ data: payload.replace(VENUE, EVENT) }));
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
  it('admits one operation and waits for durable storage before release or success', async () => {
    let finish!: (value: SubEvent) => void;
    mockSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await open();
    const callback = mockCamera.onBarcodeScanned!;
    await flush(() => {
      callback({ data: payload });
      callback({ data: payload });
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    await flush(() => finish(sub));
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/scan-result/[eventId]',
      params: { eventId: EVENT, subEventId: SUB },
    });
  });
  it('storage failure reports no success and leaves the queue untouched', async () => {
    mockSave.mockRejectedValueOnce(new Error('disk full'));
    await open();
    await flush(() => mockCamera.onBarcodeScanned?.({ data: payload }));
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(JSON.stringify(tree?.toJSON())).toContain('could not be saved');
  });
  it('a saved old-account result cannot release or navigate under the new account', async () => {
    let finish!: (value: SubEvent) => void;
    mockSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await open();
    await flush(() => mockCamera.onBarcodeScanned?.({ data: payload }));
    mockOwner = 'B';
    await flush(() => finish(sub));
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
