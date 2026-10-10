import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createElement, type ReactElement } from 'react';

import type { ShotContext } from '@/features/capture/context';
import {
  CaptureStore,
  type CaptureDraft,
  type CaptureFiles,
} from '@/features/capture/capture-store';
import { retryCapture, useCaptureDrafts } from '@/features/capture/runtime';
import { QueueStore, type QueueDatabase, type QueueFiles } from '@/features/upload-queue/store';
import { useAuthStore } from '@/stores/auth';

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const SUB = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const shot: ShotContext = {
  userId: 'A',
  eventId: EVENT,
  subEventId: SUB,
  capturedAt: '2026-10-10T10:00:00Z',
  mode: 'public',
};

// The queue's database, opened on node's SQLite as store.test.ts does.
let database: DatabaseSync;
let store: QueueStore;
function adapt(): QueueDatabase {
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...params) => ({
      changes: Number(database.prepare(sql).run(...params).changes),
    }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  };
}
const disk: QueueFiles = {
  copy: async (owner, id) => ({
    photoPath: `${owner}/${id}/source.jpg`,
    thumbnailPath: `${owner}/${id}/thumb.webp`,
  }),
  delete: async () => undefined,
  list: async () => [],
  uri: (path) => `file:///documents/upload-queue/${path}`,
};

// The same copies capture-files.ts makes, without the image and file modules.
const files: CaptureFiles = {
  original: async (owner, id) => `${owner}/${id}/original.jpg`,
  thumbnail: async (original) => original.replace('original.jpg', 'thumb.webp'),
};

const mockGallerySave = jest.fn(async (_uri: string) => undefined);
const mockGetQueue = jest.fn(async () => store);

jest.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    delete() {
      return undefined;
    }
  },
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: () => undefined,
    getBoolean: () => undefined,
    set: () => undefined,
  }),
}));
jest.mock('../../../modules/local-media', () => ({
  excludeMediaFromBackup: async () => undefined,
}));
jest.mock('@/features/upload-queue/queue', () => ({
  getQueue: () => mockGetQueue(),
  runUploads: async () => undefined,
}));
jest.mock('@/features/capture/capture-files', () => ({
  captureFiles: {
    original: async (owner: string, id: string) => `${owner}/${id}/original.jpg`,
    thumbnail: async (original: string) => original.replace('original.jpg', 'thumb.webp'),
  },
}));
jest.mock('@/features/capture/gallery', () => ({
  galleryPermission: async () => true,
  saveOriginalToGallery: (uri: string) => mockGallerySave(uri),
}));

beforeEach(async () => {
  database = new DatabaseSync(':memory:');
  store = new QueueStore(adapt(), disk, () => 'unused');
  await store.initialize();
  mockGallerySave.mockReset();
  mockGallerySave.mockResolvedValue(undefined);
  useAuthStore.setState({ status: 'signedIn', userId: 'A' });
});

// A Public draft as My Media lists it, with its gallery state read back from the journal.
async function draftInState(): Promise<CaptureDraft> {
  const captures = new CaptureStore(store, files);
  await captures.persist('capture-1', shot, 'file:///camera.jpg');
  const [draft] = await captures.list('A', EVENT);
  if (!draft) throw new Error('The draft was not persisted.');
  return draft;
}
const galleryState = () =>
  database.prepare('SELECT galleryState FROM capture_journal WHERE id = ?').get('capture-1');

// react-test-renderer ships with jest-expo, not as a direct dependency (see viewfinder-screen.test).
interface TestRenderer {
  act(action: () => Promise<void>): Promise<void>;
  create(element: ReactElement): { update(element: ReactElement): void; unmount(): void };
}
const renderer = jest.requireActual<TestRenderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
// Records what the hook returns on each render.
function DraftProbe({ owner, seen }: { owner: string; seen: CaptureDraft[][] }) {
  const { drafts } = useCaptureDrafts(owner, EVENT);
  seen.push(drafts);
  return null;
}
async function settle(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('retrying a Public draft', () => {
  it('says the photo is in the gallery when only the queue handoff fails', async () => {
    const draft = await draftInState();
    const handoff = jest
      .spyOn(CaptureStore.prototype, 'handoff')
      .mockRejectedValueOnce(new Error('The queue is full'));
    await expect(retryCapture(draft)).rejects.toThrow(
      'The photo is in your gallery, but it could not be added to the upload queue. Try again.',
    );
    expect(galleryState()).toEqual({ galleryState: 'saved' });
    handoff.mockRestore();
  });

  it('says the gallery save did not finish when the save fails', async () => {
    const draft = await draftInState();
    mockGallerySave.mockRejectedValueOnce(new Error('disk'));
    await expect(retryCapture(draft)).rejects.toThrow(
      'The gallery save did not finish. The photo stays on this phone.',
    );
    expect(galleryState()).toEqual({ galleryState: 'failed' });
  });
});

describe('the drafts My Media reads', () => {
  it('returns the same array when a render changes nothing in the drafts or their scope', async () => {
    await draftInState();
    const seen: CaptureDraft[][] = [];
    let tree: ReturnType<TestRenderer['create']> | undefined;
    await renderer.act(async () => {
      tree = renderer.create(createElement(DraftProbe, { owner: 'A', seen }));
      await settle(() => (seen.at(-1)?.length ?? 0) === 1);
    });
    const before = seen.at(-1);
    expect(before).toHaveLength(1);
    await renderer.act(async () => {
      tree?.update(createElement(DraftProbe, { owner: 'A', seen }));
    });
    expect(seen.at(-1)).toBe(before);
    await renderer.act(async () => {
      tree?.unmount();
    });
  });
});
