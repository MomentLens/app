import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import { createElement, useEffect, type ReactElement } from 'react';
import { useThumbnailMap } from '@/features/album/use-album-images';
import { getMediaImages } from '@/lib/api';

jest.mock('@/lib/api', () => ({ getMediaImages: jest.fn() }));
interface Renderer {
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): { update(element: ReactElement): void; unmount(): void };
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
const read = jest.mocked(getMediaImages);
let client: QueryClient;
let tree: ReturnType<Renderer['create']> | undefined;
let current: ReturnType<typeof useThumbnailMap>;
type Photo = { id: string; variantVersion: number };
function Probe({ photos }: { photos: Photo[] }) {
  const snapshot = useThumbnailMap('event', photos);
  useEffect(() => {
    current = snapshot;
  }, [snapshot]);
  return null;
}
const element = (photos: Photo[]) =>
  createElement(QueryClientProvider, { client }, createElement(Probe, { photos }));
const flush = async () => {
  await renderer.act(async () => {
    await jest.advanceTimersByTimeAsync(20);
  });
};
beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-23T00:00:00Z') });
  focusManager.setFocused(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  read.mockReset().mockImplementation(async (_event, body) => ({
    images: Object.fromEntries(
      body.mediaIds.map((id) => [
        id,
        { url: `https://example.test/${id}?signed=${Date.now()}`, cacheKey: `${id}#v1` },
      ]),
    ),
  }));
});
afterEach(async () => {
  await renderer.act(async () => {
    tree?.unmount();
  });
  tree = undefined;
  client.clear();
  jest.useRealTimers();
});
it('signs only the new photo when 1999 cached photos shift into new batches', async () => {
  const photos = Array.from({ length: 1999 }, (_, i) => ({ id: `photo-${i}`, variantVersion: 1 }));
  await renderer.act(async () => {
    tree = renderer.create(element(photos));
  });
  await flush();
  expect(Object.keys(current.images)).toHaveLength(1999);
  read.mockClear();
  await renderer.act(async () => {
    tree!.update(element([{ id: 'new', variantVersion: 1 }, ...photos]));
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![1].mediaIds).toEqual(['new']);
  expect(Object.keys(current.images)).toHaveLength(2000);
});
it('renews an active album before expiry without requiring another render or focus change', async () => {
  await renderer.act(async () => {
    tree = renderer.create(element([{ id: 'photo', variantVersion: 1 }]));
  });
  await flush();
  const first = current.images.photo!.url;
  await renderer.act(async () => {
    await jest.advanceTimersByTimeAsync(45 * 60 * 1000);
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(current.images.photo!.url).not.toBe(first);
});
it('keeps the original renewal deadline when another photo shifts the batch', async () => {
  const photo = { id: 'photo', variantVersion: 1 };
  await renderer.act(async () => {
    tree = renderer.create(element([photo]));
  });
  await flush();
  await renderer.act(async () => {
    await jest.advanceTimersByTimeAsync(40 * 60 * 1000);
    tree!.update(element([{ id: 'new', variantVersion: 1 }, photo]));
  });
  await flush();
  read.mockClear();
  await renderer.act(async () => {
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![1].mediaIds).toEqual(['photo']);
});
it('hides an old variant while its replacement loads, and honors a server omission', async () => {
  await renderer.act(async () => {
    tree = renderer.create(element([{ id: 'photo', variantVersion: 1 }]));
  });
  await flush();
  let release!: () => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ images: {} });
      }),
  );
  await renderer.act(async () => {
    tree!.update(element([{ id: 'photo', variantVersion: 2 }]));
  });
  expect(current.images.photo).toBeUndefined();
  await renderer.act(async () => {
    release();
  });
  await flush();
  expect(current.images.photo).toBeUndefined();
  expect(current.omitted.has('photo')).toBe(true);
});
it('retries an image error once within 30 seconds instead of looping on a missing object', async () => {
  await renderer.act(async () => {
    tree = renderer.create(element([{ id: 'photo', variantVersion: 1 }]));
  });
  await flush();
  read.mockClear();
  await renderer.act(async () => {
    current.retry('photo');
    current.retry('photo');
  });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
});
