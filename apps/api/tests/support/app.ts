import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';

import { createApp } from '../../src/app';
import type { AppDeps } from '../../src/app';
import { createR2 } from '../../src/lib/r2';
import type { AlbumStore } from '../../src/services/album';
import type { BlurRegionStore } from '../../src/services/blur-regions';
import type { EventStore } from '../../src/services/events';
import type { FaceStore } from '../../src/services/faces';
import type { InviteStore } from '../../src/services/invites';
import type { MediaStore } from '../../src/services/media';
import type { MediaImagesStore } from '../../src/services/media-images';
import type { PhotoFlagStore } from '../../src/services/photo-flags';
import type { ReferenceStore } from '../../src/services/references';
import type { SubEventStore } from '../../src/services/sub-events';

// R2 settings that presign for real, with no network and no account. A URL signed with them
// fails at R2, which no test sends it to.
export const TEST_R2 = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessKeyId: 'test-access-key-id',
  secretAccessKey: 'test-secret-access-key',
  bucket: 'momentlens-test',
};

// An event store that knows no events and fails any write, for tests that do not reach one.
const noEvents: EventStore = {
  create: () => Promise.reject(new Error('no event store in this test')),
  listForMember: () => Promise.resolve([]),
  listJoinRequests: () => Promise.resolve([]),
  findForCaller: () => Promise.resolve(null),
  findAccess: () => Promise.resolve(null),
  setCover: () => Promise.resolve(false),
  settings: () => Promise.resolve(null),
  updateSettings: () => Promise.reject(new Error('no event store in this test')),
  albumStatus: () => Promise.resolve(null),
  setAlbum: () => Promise.resolve(null),
};

// An invite store where every invite is dead and no one has a join request.
const noInvites: InviteStore = {
  resolve: () => Promise.resolve(null),
  join: () => Promise.resolve({ outcome: 'dead' }),
  cancelJoinRequest: () => Promise.resolve(null),
};

// A sub-event store that knows no sub-events and fails any write.
const noSubEvents: SubEventStore = {
  findEventId: () => Promise.resolve(null),
  schedule: () => Promise.resolve(null),
  add: () => Promise.reject(new Error('no sub-event store in this test')),
  update: () => Promise.reject(new Error('no sub-event store in this test')),
  remove: () => Promise.reject(new Error('no sub-event store in this test')),
};

// A media store that knows no rows and fails any write.
const noMedia: MediaStore = {
  verificationSchedule: () => Promise.resolve(null),
  statuses: () => Promise.reject(new Error('no media store in this test')),
  start: () => Promise.reject(new Error('no media store in this test')),
  findUpload: () => Promise.resolve(null),
  complete: () => Promise.reject(new Error('no media store in this test')),
  detail: () => Promise.resolve({ outcome: 'not_found' }),
  remove: () => Promise.reject(new Error('no media store in this test')),
};

const noAlbum: AlbumStore = {
  query: () => Promise.reject(new Error('no album store in this test')),
  uploaders: () => Promise.reject(new Error('no album store in this test')),
};

const noFaces: FaceStore = {
  people: () => Promise.reject(new Error('no face store in this test')),
  photoFaces: () => Promise.reject(new Error('no face store in this test')),
};

const noMediaImages: MediaImagesStore = {
  findForServing: () => Promise.reject(new Error('no media images store in this test')),
};

const noPhotoFlags: PhotoFlagStore = {
  flag: () => Promise.reject(new Error('no photo flag store in this test')),
};

// A blur region store that knows no photos and fails any write.
const noBlurRegions: BlurRegionStore = {
  access: () => Promise.resolve({ outcome: 'not_found' }),
  list: () => Promise.reject(new Error('no blur region store in this test')),
  add: () => Promise.reject(new Error('no blur region store in this test')),
  remove: () => Promise.reject(new Error('no blur region store in this test')),
};

// A reference store with no rows that fails any write.
const noReferences: ReferenceStore = {
  list: () => Promise.resolve([]),
  countKept: () => Promise.resolve(0),
  findOwner: () => Promise.resolve(null),
  add: () => Promise.reject(new Error('no reference store in this test')),
  remove: () => Promise.reject(new Error('no reference store in this test')),
};

// Dependencies for createApp that need no Supabase project. Each test overrides what it checks.
// The token check rejects every token unless a test passes a real one, and R2 holds no objects.
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const r2 = createR2(TEST_R2);
  return {
    logger: pino({ level: 'silent' }),
    checkDatabase: () => Promise.resolve('ok'),
    verifyToken: () => Promise.resolve(null),
    findProfile: () => Promise.resolve(null),
    setAvatar: () => Promise.reject(new Error('no profile writes in this test')),
    consent: {
      accepted: () => Promise.resolve(false),
      accept: () => Promise.reject(new Error('no consent store in this test')),
    },
    events: noEvents,
    attendees: {
      list: () => Promise.reject(new Error('no attendee store in this test')),
      mutate: () => Promise.reject(new Error('no attendee store in this test')),
      forceVerify: () => Promise.reject(new Error('no attendee store in this test')),
    },
    joinRequests: {
      list: () => Promise.reject(new Error('no join request store in this test')),
      act: () => Promise.reject(new Error('no join request store in this test')),
    },
    invites: noInvites,
    inviteManagement: {
      list: () => Promise.reject(new Error('no invite management store in this test')),
      regenerate: () => Promise.reject(new Error('no invite management store in this test')),
    },
    venueQrs: {
      list: () => Promise.reject(new Error('no venue QR store in this test')),
      regenerate: () => Promise.reject(new Error('no venue QR store in this test')),
    },
    subEvents: noSubEvents,
    media: noMedia,
    album: noAlbum,
    faces: noFaces,
    mediaImages: noMediaImages,
    photoFlags: noPhotoFlags,
    blurRegions: noBlurRegions,
    references: noReferences,
    presignGet: r2.presignGet,
    presignPut: r2.presignPut,
    objectExists: () => Promise.resolve(false),
    objectSize: () => Promise.resolve(null),
    deleteObject: () => Promise.reject(new Error('no R2 deletes in this test')),
    ...overrides,
  };
}

export interface RunningApp {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startApp(deps: AppDeps): Promise<RunningApp> {
  const server = createApp(deps).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
