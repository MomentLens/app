import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { prepareCover, uploadCover } from '@/features/events/cover';

const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const UPLOAD_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const UPLOAD_URL = 'https://account.r2.cloudflarestorage.com/momentlens-dev/put?X-Amz-Signature=1';
const COVER = { url: 'https://r2.example.test/get?sig=2', cacheKey: 'events/e/cover_u.jpg' };

// lib/api is the MomentLens API. The upload itself goes to R2 through expo-file-system and must
// never pass through the API (root invariant 5) or carry the API's token.
const mockApi = {
  createCoverUpload: jest.fn((_eventId: string) =>
    Promise.resolve({ uploadId: UPLOAD_ID, uploadUrl: UPLOAD_URL }),
  ),
  setEventCover: jest.fn((_eventId: string, _uploadId: string) =>
    Promise.resolve({ cover: COVER }),
  ),
};
// The factory runs when cover.ts is imported, before mockApi is assigned, so it defers each call.
jest.mock('@/lib/api', () => ({
  createCoverUpload: (eventId: string) => mockApi.createCoverUpload(eventId),
  setEventCover: (eventId: string, uploadId: string) => mockApi.setEventCover(eventId, uploadId),
}));

type UploadOptions = { httpMethod?: string; headers?: Record<string, string> };
const mockUpload = jest.fn((_url: string, _options?: UploadOptions) =>
  Promise.resolve({ status: 200, body: '', headers: {} }),
);
const mockFiles: string[] = [];
jest.mock('expo-file-system', () => ({
  File: jest.fn((uri: string) => {
    mockFiles.push(uri);
    return { uri, upload: mockUpload };
  }),
}));

// A manipulator context whose first render reports the source's size and whose later renders
// report the size the resize asked for.
const mockResize = jest.fn();
const mockSave = jest.fn((_options: { format?: string; compress?: number }) =>
  Promise.resolve({ uri: 'file:///cache/cover.jpg', width: 0, height: 0 }),
);
let mockSource = { width: 3000, height: 2000 };
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: {
    manipulate: jest.fn(() => {
      let size = mockSource;
      const context = {
        resize: (next: { width?: number; height?: number }) => {
          mockResize(next);
          const scale = next.width ? next.width / size.width : next.height! / size.height;
          size = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
          return context;
        },
        renderAsync: () =>
          Promise.resolve({
            width: size.width,
            height: size.height,
            saveAsync: (options: { format?: string; compress?: number }) =>
              mockSave(options).then((saved) => ({ ...saved, ...size })),
          }),
      };
      return context;
    }),
  },
}));

afterEach(() => {
  jest.clearAllMocks();
  mockFiles.length = 0;
  mockSource = { width: 3000, height: 2000 };
});

describe('uploadCover', () => {
  const cover = { uri: 'file:///cache/cover.jpg', width: 3000, height: 2000 };

  it('PUTs the file to the presigned URL as it came, with the signed content type and no token', async () => {
    await expect(uploadCover(EVENT_ID, cover)).resolves.toEqual(COVER);

    expect(mockApi.createCoverUpload).toHaveBeenCalledWith(EVENT_ID);
    expect(mockFiles).toEqual([cover.uri]);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [url, options] = mockUpload.mock.calls[0]!;
    expect(url).toBe(UPLOAD_URL);
    expect(options?.httpMethod).toBe('PUT');
    // Exactly one header: the content type R2 checks against the signature. The Supabase access
    // token must never reach R2.
    expect(options?.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('sets the cover with the uploadId, never the URL or a key (root invariant 12)', async () => {
    await uploadCover(EVENT_ID, cover);
    expect(mockApi.setEventCover).toHaveBeenCalledWith(EVENT_ID, UPLOAD_ID);
  });

  it('does not set the cover when R2 refuses the upload', async () => {
    mockUpload.mockResolvedValueOnce({ status: 403, body: '<Error/>', headers: {} });

    await expect(uploadCover(EVENT_ID, cover)).rejects.toThrow('R2 refused the cover upload');
    expect(mockApi.setEventCover).not.toHaveBeenCalled();
  });

  it('does not set the cover when the upload cannot reach R2', async () => {
    mockUpload.mockRejectedValueOnce(new Error('The Internet connection appears to be offline.'));

    await expect(uploadCover(EVENT_ID, cover)).rejects.toThrow();
    expect(mockApi.setEventCover).not.toHaveBeenCalled();
  });
});

describe('prepareCover', () => {
  it('re-encodes to JPEG without resizing when the longest edge is 4096 or less', async () => {
    mockSource = { width: 4096, height: 3072 };

    await expect(prepareCover('file:///picked.heic')).resolves.toEqual({
      uri: 'file:///cache/cover.jpg',
      width: 4096,
      height: 3072,
    });
    expect(mockResize).not.toHaveBeenCalled();
    expect(mockSave.mock.calls[0]?.[0].format).toBe('jpeg');
  });

  it('shrinks a landscape photo to 4096 wide, the one resize root invariant 9 allows', async () => {
    mockSource = { width: 8192, height: 6144 };

    await expect(prepareCover('file:///picked.jpg')).resolves.toMatchObject({
      width: 4096,
      height: 3072,
    });
    expect(mockResize).toHaveBeenCalledWith({ width: 4096 });
  });

  it('shrinks a portrait photo to 4096 tall', async () => {
    mockSource = { width: 3000, height: 5000 };

    await expect(prepareCover('file:///picked.jpg')).resolves.toMatchObject({ height: 4096 });
    expect(mockResize).toHaveBeenCalledWith({ height: 4096 });
  });
});
