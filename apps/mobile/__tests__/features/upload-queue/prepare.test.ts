import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

import { prepareUpload } from '@/features/upload-queue/prepare';

// A disk keyed by URI. The manipulator writes its JPEG into the cache, and the queue folder holds
// the copy that is hashed and PUT.
const mockDisk = new Map<string, Uint8Array>();
jest.mock('expo-file-system', () => ({
  File: jest.fn((uri: string) => ({
    uri,
    get exists() {
      return mockDisk.has(uri);
    },
    copy: async (destination: { uri: string }, options?: { overwrite?: boolean }) => {
      if (mockDisk.has(destination.uri) && !options?.overwrite) throw new Error('exists');
      mockDisk.set(destination.uri, mockDisk.get(uri)!);
    },
    bytes: async () => {
      const bytes = mockDisk.get(uri);
      if (!bytes) throw new Error(`no file at ${uri}`);
      return bytes;
    },
    delete: () => {
      mockDisk.delete(uri);
    },
  })),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, data: Uint8Array) => {
    const { createHash: hash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const out = hash('sha256').update(data).digest();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  },
}));

// A manipulator context whose first render is the source's upright size and whose later renders
// are the size the resize asked for. The saved JPEG's bytes name its size and settings.
const mockResize = jest.fn();
const mockSave = jest.fn();
const mockReleased: string[] = [];
let mockSource = { width: 3000, height: 4000 };
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: {
    manipulate: jest.fn(() => {
      let size = mockSource;
      let renders = 0;
      const context = {
        resize: (next: { width?: number; height?: number }) => {
          mockResize(next);
          const scale = next.width ? next.width / size.width : next.height! / size.height;
          size = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
          return context;
        },
        renderAsync: async () => {
          const rendered = { ...size };
          const name = `image-${++renders}`;
          return {
            ...rendered,
            saveAsync: async (options: { format: string; compress: number }) => {
              mockSave(options);
              const uri = 'file:///cache/manipulated.jpg';
              mockDisk.set(
                uri,
                new TextEncoder().encode(
                  `${options.format}:${options.compress}:${rendered.width}x${rendered.height}`,
                ),
              );
              return { uri, ...rendered };
            },
            release: () => mockReleased.push(name),
          };
        },
        release: () => mockReleased.push('context'),
      };
      return context;
    }),
  },
}));

const files = { uri: (path: string) => `file:///documents/upload-queue/${path}` };
const SOURCE = 'A/item-1/source.heic';

beforeEach(() => {
  mockDisk.clear();
  mockDisk.set(files.uri(SOURCE), new TextEncoder().encode('heic bytes'));
  mockResize.mockClear();
  mockSave.mockClear();
  mockReleased.length = 0;
  mockSource = { width: 3000, height: 4000 };
});

describe('Stage 1 (spec §4.8.1, D-146)', () => {
  it('writes upload.jpg as JPEG at 0.9 next to the source and hashes those exact bytes', async () => {
    const prepared = await prepareUpload(SOURCE, files);
    expect(prepared.photoPath).toBe('A/item-1/upload.jpg');
    expect(mockSave).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    const stored = mockDisk.get(files.uri(prepared.photoPath))!;
    expect(new TextDecoder().decode(stored)).toBe('jpeg:0.9:3000x4000');
    expect(prepared.contentHash).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(prepared.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the source alone and removes the cache copy', async () => {
    await prepareUpload(SOURCE, files);
    expect(mockDisk.has(files.uri(SOURCE))).toBe(true);
    expect(mockDisk.has('file:///cache/manipulated.jpg')).toBe(false);
    expect(mockReleased).toContain('context');
  });

  it('does not resize a photo whose longest edge is 4096px or less (root invariant 9)', async () => {
    mockSource = { width: 4096, height: 3072 };
    await prepareUpload(SOURCE, files);
    expect(mockResize).not.toHaveBeenCalled();
  });

  it.each([
    [{ width: 5712, height: 4284 }, { width: 4096 }, '4096x3072'],
    [{ width: 4284, height: 5712 }, { height: 4096 }, '3072x4096'],
  ])(
    'shrinks %o to 4096px on its longest edge, keeping its aspect',
    async (source, resize, size) => {
      mockSource = source;
      const prepared = await prepareUpload(SOURCE, files);
      expect(mockResize).toHaveBeenCalledWith(resize);
      expect(new TextDecoder().decode(mockDisk.get(files.uri(prepared.photoPath))!)).toBe(
        `jpeg:0.9:${size}`,
      );
    },
  );

  it('replaces an upload.jpg left by a kill mid-Stage 1', async () => {
    mockDisk.set(files.uri('A/item-1/upload.jpg'), new TextEncoder().encode('half written'));
    const prepared = await prepareUpload(SOURCE, files);
    expect(new TextDecoder().decode(mockDisk.get(files.uri(prepared.photoPath))!)).toBe(
      'jpeg:0.9:3000x4000',
    );
  });
});
