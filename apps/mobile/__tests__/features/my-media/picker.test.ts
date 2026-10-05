import { describe, expect, it, jest } from '@jest/globals';
const mockPick = jest.fn(() => Promise.resolve({ canceled: true, assets: null }));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: () => mockPick() }));

describe('Add Media picker', () => {
  it('requests full-quality images only without editing, capped at 50', async () => {
    jest.resetModules();
    const mockLaunch = jest.fn(() => Promise.resolve({ canceled: true, assets: null }));
    jest.doMock('expo-image-picker', () => ({ launchImageLibraryAsync: mockLaunch }));
    let pick!: typeof import('@/features/my-media/picker').pickMedia;
    jest.isolateModules(() => {
      pick = jest.requireActual<typeof import('@/features/my-media/picker')>(
        '@/features/my-media/picker',
      ).pickMedia;
    });
    expect(await pick()).toEqual([]);
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        quality: 1,
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 50,
      }),
    );
  });
});
