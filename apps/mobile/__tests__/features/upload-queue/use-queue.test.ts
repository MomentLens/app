import { expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { useQueue } from '@/features/upload-queue/use-queue';
import type { QueueItem } from '@/features/upload-queue/types';
let mockChanged: () => void;
const mockRead = jest.fn(async (): Promise<QueueItem[]> => []);
const mockUnsubscribe = jest.fn();
jest.mock('@/stores/auth', () => ({ useAuthStore: () => 'A' }));
jest.mock('@/features/upload-queue/queue', () => ({
  getQueue: async () => ({
    listForEvent: mockRead,
    subscribe: (callback: () => void) => {
      mockChanged = callback;
      return mockUnsubscribe;
    },
  }),
}));
interface Renderer {
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): { unmount(): void };
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
it('coalesces a notification burst during a read and discards its stale snapshot', async () => {
  let current: ReturnType<typeof useQueue>;
  function Probe() {
    current = useQueue('event');
    return null;
  }
  let tree: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(createElement(Probe));
  });
  mockRead.mockClear();
  let release!: (rows: QueueItem[]) => void;
  mockRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const latest = [{ id: 'latest', state: 'uploaded' } as QueueItem];
  mockRead.mockResolvedValue(latest);
  await renderer.act(async () => {
    mockChanged();
    await Promise.resolve();
  });
  await renderer.act(async () => {
    for (let i = 0; i < 2000; i++) mockChanged();
    release([{ id: 'stale', state: 'uploaded' } as QueueItem]);
  });
  expect(mockRead).toHaveBeenCalledTimes(2);
  expect(current!.items).toBe(latest);
  await renderer.act(async () => tree.unmount());
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});
