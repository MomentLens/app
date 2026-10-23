import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { useMediaRealtime } from '@/features/event-shell/use-media-realtime';

let mockStatus: (status: string) => void;
let mockUser = 'A';
const mockRefresh = jest.fn(async (..._args: unknown[]) => undefined);
const mockStatusRead = jest.fn(async () => ({ statuses: [] }));
const mockListeners = new Map<string, (payload?: unknown) => void>();
const mockInvalidate = jest.fn();
const mockRecheck = jest.fn();
const mockRemove = jest.fn();
const mockChannel = {
  on: (_kind: string, filter: { table: string }, callback: (payload?: unknown) => void) => {
    mockListeners.set(filter.table, callback);
    return mockChannel;
  },
  subscribe: (callback: (status: string) => void) => {
    mockStatus = callback;
    return mockChannel;
  },
};
jest.mock('@/features/album/use-album-switch', () => ({
  albumStatusQueryKey: (id: string) => ['album-status', id],
}));
jest.mock('@/features/event-shell/use-event', () => ({
  recheckEvent: (id: string) => mockRecheck(id),
}));
jest.mock('@/features/my-media/status', () => ({
  applyMediaChange: async () => undefined,
  refreshMediaStatus: (...args: unknown[]) => mockRefresh(...args),
}));
jest.mock('@/lib/api', () => ({ getMediaStatus: () => mockStatusRead() }));
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
  useAuthStore: Object.assign(() => mockUser, { getState: () => ({ userId: mockUser }) }),
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
  mockUser = 'A';
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

it('reconciles missed publication, unpublication and deletion on rejoin with a session guard', async () => {
  mockStatus('SUBSCRIBED');
  expect(mockRefresh).not.toHaveBeenCalled();
  await renderer.act(async () => {
    mockStatus('SUBSCRIBED');
  });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  const args = mockRefresh.mock.calls[0]!;
  expect(args.slice(1, 4)).toEqual(['A', 'event', true]);
  const current = args[5] as () => boolean;
  expect(current()).toBe(true);
  mockUser = 'B';
  expect(current()).toBe(false);
});
it('invalidates the prior reconciliation when another rejoin starts', async () => {
  await renderer.act(async () => {
    mockStatus('SUBSCRIBED');
    mockStatus('SUBSCRIBED');
  });
  const previous = mockRefresh.mock.calls[0]![5] as () => boolean;
  await renderer.act(async () => {
    mockStatus('SUBSCRIBED');
  });
  expect(previous()).toBe(false);
  expect((mockRefresh.mock.calls[1]![5] as () => boolean)()).toBe(true);
});
