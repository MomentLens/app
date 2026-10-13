import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { useMediaRealtime } from '@/features/event-shell/use-media-realtime';

const mockListeners = new Map<string, (payload?: unknown) => void>();
const mockInvalidate = jest.fn();
const mockRecheck = jest.fn();
const mockRemove = jest.fn();
const mockChannel = {
  on: (_kind: string, filter: { table: string }, callback: (payload?: unknown) => void) => {
    mockListeners.set(filter.table, callback);
    return mockChannel;
  },
  subscribe: () => mockChannel,
};
jest.mock('@/features/album/use-album-switch', () => ({
  albumStatusQueryKey: (id: string) => ['album-status', id],
}));
jest.mock('@/features/event-shell/use-event', () => ({
  recheckEvent: (id: string) => mockRecheck(id),
}));
jest.mock('@/features/my-media/status', () => ({ applyMediaChange: async () => undefined }));
jest.mock('@/features/upload-queue/queue', () => ({ getQueue: async () => ({}) }));
jest.mock('@/lib/query-client', () => ({
  queryClient: {
    invalidateQueries: (arg: unknown) => mockInvalidate(arg),
  },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    channel: () => mockChannel,
    removeChannel: (channel: unknown) => mockRemove(channel),
  },
}));
jest.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(() => 'A', { getState: () => ({ userId: 'A' }) }),
}));
interface Renderer {
  create(element: ReactElement): { unmount(): void };
  act(run: () => Promise<void>): Promise<void>;
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
let tree: ReturnType<Renderer['create']>;
function Probe() {
  useMediaRealtime('event');
  return null;
}
beforeEach(async () => {
  jest.useFakeTimers();
  mockListeners.clear();
  jest.clearAllMocks();
  await renderer.act(async () => {
    tree = renderer.create(createElement(Probe));
  });
});
afterEach(async () => {
  await renderer.act(async () => tree.unmount());
  jest.useRealTimers();
});

it('uses one channel for media and event, and an event change only refetches', () => {
  expect([...mockListeners.keys()]).toEqual(['media', 'event']);
  mockListeners.get('event')?.({ new: { album_open: true } });
  expect(mockRecheck).toHaveBeenCalledWith('event');
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['album-status', 'event'], exact: true });
});

it('refreshes the Manage upload count after a media change', async () => {
  mockListeners.get('media')?.({
    eventType: 'UPDATE',
    new: { id: 'media', uploader_user_id: 'A', processed_at: null, deleted_at: null },
  });
  await renderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['album-status', 'event'], exact: true });
});
