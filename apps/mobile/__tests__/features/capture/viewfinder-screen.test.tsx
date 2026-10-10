import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type { CameraViewProps } from 'expo-camera';
import type { ViewfinderProps } from '@/features/capture/viewfinder';
import { ViewfinderScreen } from '@/features/capture/viewfinder-screen';

interface TestTree {
  root: {
    findByType(type: 'Viewfinder'): { props: ViewfinderProps };
    findByType(type: 'Camera'): { props: CameraViewProps };
  };
  unmount(): void;
}
const renderer = jest.requireActual<{
  act(action: () => Promise<void>): Promise<void>;
  create(
    element: ReactElement,
    options: { createNodeMock(element: { type: unknown }): unknown },
  ): TestTree;
}>(createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'));
const mockTake = jest.fn(async () => ({ uri: 'file:///photo.jpg', width: 4000, height: 3000 }));
const mockSizes = jest.fn(async () => ['4000x3000']);
const mockPermission = jest.fn(async () => true);
const mockDismiss = jest.fn();
const mockEvent = { event: { id: 'event' } };
const mockSchedule = {
  subEvents: [{ id: 'sub', startsAt: '2026-10-10T00:00:00Z', endsAt: '2026-10-11T00:00:00Z' }],
};

jest.mock('expo-camera', () => ({
  CameraView: 'Camera',
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: mockDismiss }),
  useFocusEffect: (callback: () => void) => {
    jest.requireActual<typeof import('react')>('react').useEffect(callback, [callback]);
  },
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: unknown }) => children,
  Gesture: {
    Pan: () => {
      const gesture = {
        activeOffsetX: () => gesture,
        failOffsetY: () => gesture,
        onEnd: () => gesture,
      };
      return gesture;
    },
  },
}));
jest.mock('../../../modules/local-media', () => ({ cameraStillSize: jest.fn() }));
jest.mock('@/components/ui/glyph', () => ({ Glyph: () => null }));
jest.mock('@/features/capture/viewfinder', () => ({
  __esModule: true,
  default: (props: { preview: unknown }) =>
    jest
      .requireActual<typeof import('react')>('react')
      .createElement('Viewfinder', props, props.preview as ReactElement),
}));
jest.mock('@/features/event-shell/use-event', () => ({
  useEvent: () => ({ data: mockEvent }),
  lostAccess: () => false,
  eventQueryKey: () => ['event'],
}));
jest.mock('@/features/schedule/use-sub-events', () => ({
  useSubEvents: () => ({ data: mockSchedule }),
  subEventsQueryKey: () => ['schedule'],
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => new Date('2026-10-10T01:00:00Z') }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (select: (state: { userId: string }) => unknown) => select({ userId: 'A' }),
    { getState: () => ({ userId: 'A' }) },
  ),
}));
jest.mock('@/lib/query-client', () => ({
  queryClient: {
    getQueryData: (key: string[]) => (key[0] === 'event' ? mockEvent : mockSchedule),
    getQueryState: () => ({}),
  },
}));
jest.mock('@/features/capture/runtime', () => ({
  hasLocalNotice: () => true,
  readStartingMode: () => 'public',
  rememberLocalNotice: jest.fn(),
  getCaptures: async () => ({ thumbnailUri: async () => null }),
  captureController: (take: () => Promise<string>) =>
    new (jest.requireActual<typeof import('@/features/capture/capture')>(
      '@/features/capture/capture',
    ).CaptureController)({
      userId: () => 'A',
      makeId: () => 'capture',
      permission: () => mockPermission(),
      exclude: async () => {},
      take,
      persist: async () => {},
      claimGallery: async () => true,
      saveGallery: async () => {},
      galleryResult: async () => {},
      handoff: async () => {},
      discardTemporary: async () => {},
    }),
}));

let tree: ReturnType<typeof renderer.create>;
let changeState: (state: AppStateStatus) => void;
let mounts: number;
const viewfinder = () => tree.root.findByType('Viewfinder');
const camera = () => tree.root.findByType('Camera');
async function flush(action: () => void = () => {}) {
  await renderer.act(async () => {
    action();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}
async function open() {
  await flush(() => {
    tree = renderer.create(createElement(ViewfinderScreen, { eventId: 'event' }), {
      createNodeMock: (element: { type: unknown }) => {
        if (element.type !== 'Camera') return null;
        mounts++;
        return { getAvailablePictureSizesAsync: mockSizes, takePictureAsync: mockTake };
      },
    });
  });
  await flush(() => camera().props.onCameraReady!());
  await flush(() => camera().props.onCameraReady!());
  expect(viewfinder().props.ready).toBe(true);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Platform.OS = 'android';
  AppState.currentState = 'active';
  mounts = 0;
  mockTake.mockClear();
  mockSizes.mockClear();
  mockPermission.mockReset().mockResolvedValue(true);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    changeState = listener;
    return { remove: jest.fn() };
  });
});
afterEach(async () => {
  if (tree) await flush(() => tree.unmount());
  jest.restoreAllMocks();
});

describe('native viewfinder lifecycle', () => {
  it('keeps one native view while choosing the output and switching lenses', async () => {
    await open();
    expect(mounts).toBe(1);
    mockSizes.mockResolvedValueOnce(['3000x2000']);
    await flush(() => viewfinder().props.onFlip());
    expect(viewfinder().props.ready).toBe(false);
    expect(camera().props.facing).toBe('front');
    await flush(() => camera().props.onCameraReady!());
    await flush(() => camera().props.onCameraReady!());
    expect(mounts).toBe(1);
    expect(camera().props.pictureSize).toBe('3000x2000');
    expect(mockSizes).toHaveBeenCalledTimes(2);
    expect(viewfinder().props.ready).toBe(true);
  });

  it('waits for the resumed camera after the gallery permission prompt', async () => {
    await open();
    let grant!: (allowed: boolean) => void;
    mockPermission.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          grant = resolve;
        }),
    );
    await flush(() => viewfinder().props.onShutter());
    await flush(() => changeState('background'));
    await flush(() => changeState('active'));
    await flush(() => grant(true));
    expect(mockTake).not.toHaveBeenCalled();
    expect(viewfinder().props.ready).toBe(false);
    await flush(() => camera().props.onCameraReady!());
    expect(mockTake).toHaveBeenCalledTimes(1);
  });

  it('ignores photo dimensions returned by a camera that has since paused', async () => {
    await open();
    let oldSizes!: (sizes: string[]) => void;
    mockSizes.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          oldSizes = resolve;
        }),
    );
    await flush(() => viewfinder().props.onFlip());
    await flush(() => camera().props.onCameraReady!());
    await flush(() => changeState('background'));
    await flush(() => changeState('active'));
    await flush(() => camera().props.onCameraReady!());
    await flush(() => camera().props.onCameraReady!());
    await flush(() => oldSizes(['1920x1080']));
    expect(camera().props.pictureSize).toBe('4000x3000');
    expect(viewfinder().props.ready).toBe(true);
  });

  it('does not take an admitted shot after the camera screen closes', async () => {
    await open();
    let grant!: (allowed: boolean) => void;
    mockPermission.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          grant = resolve;
        }),
    );
    await flush(() => viewfinder().props.onShutter());
    await flush(() => changeState('background'));
    await flush(() => changeState('active'));
    await flush(() => grant(true));
    await flush(() => tree.unmount());
    expect(mockTake).not.toHaveBeenCalled();
  });
});
