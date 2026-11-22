import { afterEach, describe, expect, it, jest } from '@jest/globals';

const OWNER = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const UPLOAD_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const UPLOAD_URL = 'https://account.r2.cloudflarestorage.com/momentlens-dev/put?X-Amz-Signature=1';
const LIST = { references: [] };

class MockApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const calls: string[] = [];
const mockApi = {
  createReferenceUpload: jest.fn((owner: string, eventId: string) => {
    calls.push(`presign ${owner} ${eventId}`);
    return Promise.resolve({ uploadId: UPLOAD_ID, uploadUrl: UPLOAD_URL });
  }),
  addReference: jest.fn((owner: string, eventId: string, uploadId: string) => {
    calls.push(`add ${owner} ${eventId} ${uploadId}`);
    return Promise.resolve(LIST);
  }),
  deleteReference: jest.fn(
    (_owner: string, _eventId: string, _referenceId: string): Promise<typeof LIST> =>
      Promise.resolve(LIST),
  ),
};
jest.mock('@/lib/api', () => ({
  ApiError: MockApiError,
  AccountChangedError: class extends Error {},
  listReferences: jest.fn(),
  createReferenceUpload: (o: string, e: string) => mockApi.createReferenceUpload(o, e),
  addReference: (o: string, e: string, u: string) => mockApi.addReference(o, e, u),
  deleteReference: (o: string, e: string, r: string) => mockApi.deleteReference(o, e, r),
}));

let mockPut: (uri: string, url: string) => Promise<void> = (uri, url) => {
  calls.push(`put ${uri} ${url}`);
  return Promise.resolve();
};
jest.mock('@/lib/put-jpeg', () => ({
  putJpeg: (uri: string, url: string) => mockPut(uri, url),
}));
jest.mock('@/lib/upload-jpeg', () => ({
  encodeUploadJpeg: (uri: string) => {
    calls.push(`encode ${uri}`);
    return Promise.resolve({ uri: 'file:///cache/reference.jpg', width: 1200, height: 1600 });
  },
}));
const mockSetQueryData = jest.fn();
const mockInvalidate = jest.fn((_filters: unknown) => Promise.resolve());
jest.mock('@/lib/query-client', () => ({
  queryClient: {
    setQueryData: (key: unknown, data: unknown) => mockSetQueryData(key, data),
    invalidateQueries: (filters: unknown) => mockInvalidate(filters),
  },
}));
jest.mock('@/stores/auth', () => ({ useAuthStore: () => OWNER }));

function load() {
  let mod!: typeof import('@/features/references/use-references');
  jest.isolateModules(() => {
    mod = jest.requireActual('@/features/references/use-references');
  });
  return mod;
}

afterEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockPut = (uri, url) => {
    calls.push(`put ${uri} ${url}`);
    return Promise.resolve();
  };
});

describe('addReferencePhoto', () => {
  it('runs Stage 1 first, PUTs the prepared JPEG to R2, then adds it, all under the owner', async () => {
    const { addReferencePhoto, referencesQueryKey } = load();
    await addReferencePhoto(EVENT_ID, OWNER, 'file:///picked/selfie.heic');
    expect(calls).toEqual([
      'encode file:///picked/selfie.heic',
      `presign ${OWNER} ${EVENT_ID}`,
      `put file:///cache/reference.jpg ${UPLOAD_URL}`,
      `add ${OWNER} ${EVENT_ID} ${UPLOAD_ID}`,
    ]);
    expect(mockSetQueryData).toHaveBeenCalledWith(referencesQueryKey(EVENT_ID, OWNER), LIST);
  });

  it('adds nothing when the PUT to R2 fails', async () => {
    mockPut = () => Promise.reject(new Error('refused'));
    const { addReferencePhoto } = load();
    await expect(addReferencePhoto(EVENT_ID, OWNER, 'file:///picked/a.jpg')).rejects.toThrow(
      'refused',
    );
    expect(mockApi.addReference).not.toHaveBeenCalled();
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});

describe('referencesQueryKey', () => {
  it('keeps one account’s references apart from another’s on a shared phone', () => {
    const { referencesQueryKey } = load();
    expect(referencesQueryKey(EVENT_ID, OWNER)).not.toEqual(
      referencesQueryKey(EVENT_ID, '22222222-2222-4222-8222-222222222222'),
    );
  });
});

describe('removeReferencePhoto', () => {
  it('treats a 404 as already deleted and reads the list again', async () => {
    mockApi.deleteReference.mockImplementationOnce(() =>
      Promise.reject(new MockApiError('gone', 404, 'not_found')),
    );
    const { removeReferencePhoto } = load();
    await expect(removeReferencePhoto(EVENT_ID, OWNER, UPLOAD_ID)).resolves.toBeUndefined();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('passes any other failure to the screen', async () => {
    mockApi.deleteReference.mockImplementationOnce(() =>
      Promise.reject(new MockApiError('no', 403, 'not_member')),
    );
    const { removeReferencePhoto } = load();
    await expect(removeReferencePhoto(EVENT_ID, OWNER, UPLOAD_ID)).rejects.toThrow('no');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
