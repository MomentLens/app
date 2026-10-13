import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import { createElement, useEffect, type ReactElement } from 'react';
import { Alert } from 'react-native';

import { useAlbumSwitch } from '@/features/album/use-album-switch';
import { ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

const mockClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});
const mockSet =
  jest.fn<
    (id: string, body: { open: boolean }, owner?: string) => Promise<{ albumOpen: boolean }>
  >();
const mockStatus = jest.fn<
  () => Promise<{
    albumOpen: boolean;
    uploadCount: number;
    photographersWithoutUploads: string[];
  }>
>();
const mockRemember = jest.fn();
jest.mock('@/lib/query-client', () => ({
  get queryClient() {
    return mockClient;
  },
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  setAlbum: (id: string, body: { open: boolean }, owner?: string) => mockSet(id, body, owner),
  getAlbumStatus: () => mockStatus(),
}));
jest.mock('@/features/events/use-events', () => ({
  EVENTS_QUERY_KEY: ['events'],
  rememberEventChanges: (...args: unknown[]) => mockRemember(...args),
}));
jest.mock('@/features/event-shell/use-event', () => ({
  eventQueryKey: (id: string) => ['event', id],
  recheckEvent: (id: string) => void mockClient.invalidateQueries({ queryKey: ['event', id] }),
  retryUnlessRefused: () => false,
  useEvent: (id: string) => ({ data: mockClient.getQueryData(['event', id]) }),
}));
interface Renderer {
  create(element: ReactElement): { unmount(): void };
  act(run: () => void | Promise<void>): Promise<void>;
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
let album: ReturnType<typeof useAlbumSwitch>;
let tree: ReturnType<Renderer['create']>;
function Probe() {
  const value = useAlbumSwitch('event');
  useEffect(() => {
    album = value;
  }, [value]);
  return null;
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
beforeEach(async () => {
  useAuthStore.setState({ status: 'signedIn', userId: 'A' });
  mockClient.setQueryData(['event', 'event'], { event: { id: 'event', albumOpen: true } });
  mockSet.mockReset();
  mockStatus.mockReset();
  mockRemember.mockClear();
  await renderer.act(async () => {
    tree = renderer.create(createElement(Probe));
  });
});
afterEach(async () => {
  await renderer.act(async () => tree.unmount());
  mockClient.clear();
  jest.restoreAllMocks();
});

describe('the album switch', () => {
  it('changes no cached state when the PUT is refused', async () => {
    mockClient.setQueryData(['event', 'event'], { event: { id: 'event', albumOpen: false } });
    mockSet.mockRejectedValue(new ApiError('refused', 403, 'wrong_role'));
    await renderer.act(async () => {
      album.setOpen(true);
      await settle();
    });
    expect(mockClient.getQueryData(['event', 'event'])).toEqual({
      event: { id: 'event', albumOpen: false },
    });
    expect(mockRemember).not.toHaveBeenCalled();
    expect(album.problem).toBe('You can no longer change this event.');
    expect(album.busy).toBe(false);
    expect(album.open).toBe(false);
  });

  it('reads the current Photographer list before closing, and Cancel sends no PUT', async () => {
    mockStatus.mockResolvedValue({
      albumOpen: true,
      uploadCount: 0,
      photographersWithoutUploads: ['Ali', 'Sara'],
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderer.act(async () => {
      album.setOpen(false);
      await settle();
    });
    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[1]).toContain("Ali and Sara haven't uploaded");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does not close if the fresh status read fails', async () => {
    mockStatus.mockRejectedValue(new ApiError('offline'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderer.act(async () => {
      album.setOpen(false);
      await settle();
    });
    expect(alert).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(album.problem).toContain('could not be reached');
  });

  it('ignores a PUT answer after switching accounts', async () => {
    let finish!: (value: { albumOpen: boolean }) => void;
    mockSet.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await renderer.act(async () => {
      album.setOpen(true);
    });
    await renderer.act(async () => {
      useAuthStore.setState({ status: 'signedIn', userId: 'B' });
    });
    mockClient.setQueryData(['event', 'event'], { event: { id: 'event', albumOpen: false } });
    await renderer.act(async () => {
      finish({ albumOpen: true });
      await settle();
    });
    expect(mockRemember).not.toHaveBeenCalled();
    expect(mockClient.getQueryData(['event', 'event'])).toEqual({
      event: { id: 'event', albumOpen: false },
    });
  });
});
