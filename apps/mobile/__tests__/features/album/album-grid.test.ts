import { expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { Text } from 'react-native';
import { AlbumGrid } from '@/features/album/album-grid';
import type { AlbumListItem } from '@/features/album/types';

let mockProps: Record<string, unknown>;
jest.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    mockProps = props;
    return null;
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component },
}));
let mockTileProps: Record<string, unknown> | undefined;
jest.mock('@/features/album/photo-tile', () => ({
  PhotoTile: (props: Record<string, unknown>) => {
    mockTileProps = props;
    return null;
  },
}));
interface Renderer {
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): { unmount(): void };
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
it('forwards native scroll and refresh props and places the top content in a full-span data row', async () => {
  const scroll = {
    contentInsetAdjustmentBehavior: 'automatic' as const,
    contentContainerStyle: { paddingBottom: 32 },
    scrollEventThrottle: 16,
  };
  const onRefresh = jest.fn();
  const props = {
    items: [{ type: 'header', key: 'section' } as AlbumListItem],
    images: {},
    stickyIndices: [0],
    isFetchingNextPage: false,
    onEndReached: jest.fn(),
    scroll,
    header: createElement(Text, null, 'Top'),
    refreshing: true,
    onRefresh,
    onImageError: jest.fn(),
    onPressPhoto: jest.fn(),
  };
  let tree: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(createElement(AlbumGrid, props));
  });
  expect(mockProps.contentInsetAdjustmentBehavior).toBe('automatic');
  expect(mockProps.contentContainerStyle).toBe(scroll.contentContainerStyle);
  expect(mockProps.refreshing).toBe(true);
  expect(mockProps.onRefresh).toBe(onRefresh);
  expect(mockProps.ListHeaderComponent).toBeUndefined();
  expect(mockProps.stickyHeaderIndices).toEqual([1]);
  expect((mockProps.data as { type: string }[]).map((row) => row.type)).toEqual(['top', 'header']);
  const layout = {};
  (mockProps.overrideItemLayout as (layout: object, item: object) => void)(layout, { type: 'top' });
  expect(layout).toEqual({ span: 3 });
  await renderer.act(async () => tree.unmount());
});

it('opens the single photo view on a tap and gives the tile no long press (S-22)', async () => {
  const onPressPhoto = jest.fn();
  const media = {
    id: 'photo-1',
    subEventId: 'sub-1',
    capturedAt: '2026-10-03T16:14:00Z',
    uploaderUserId: '11111111-1111-4111-8111-111111111111',
    uploaderName: 'Ayesha Khan',
    uploaderRole: 'guest' as const,
    width: 300,
    height: 400,
    variantVersion: 1,
  };
  const props = {
    items: [{ type: 'media', key: 'photo-1', media } as AlbumListItem],
    images: {},
    stickyIndices: [],
    isFetchingNextPage: false,
    onEndReached: jest.fn(),
    scroll: { contentContainerStyle: { paddingBottom: 0 }, scrollEventThrottle: 16 },
    header: createElement(Text, null, 'Top'),
    refreshing: false,
    onRefresh: jest.fn(),
    onImageError: jest.fn(),
    onPressPhoto,
  };
  let tree: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(createElement(AlbumGrid, props));
  });
  const renderItem = mockProps.renderItem as (info: { item: unknown }) => ReactElement;
  let row: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    row = renderer.create(renderItem({ item: props.items[0] }));
  });
  expect(mockTileProps?.mediaId).toBe('photo-1');
  expect(mockTileProps?.onPress).toBe(onPressPhoto);
  expect(mockTileProps).not.toHaveProperty('onLongPress');
  await renderer.act(async () => row.unmount());
  await renderer.act(async () => tree.unmount());
});
