import { afterEach, describe, expect, it, jest } from '@jest/globals';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const UPLOAD_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const UPLOAD_URL = 'https://account.r2.cloudflarestorage.com/momentlens-dev/put?X-Amz-Signature=1';
const AVATAR = {
  url: 'https://r2.example.test/get?sig=2',
  cacheKey: `users/${OWNER}/avatar_${UPLOAD_ID}.jpg`,
};

const mockCreate = jest.fn((_owner: string) =>
  Promise.resolve({ uploadId: UPLOAD_ID, uploadUrl: UPLOAD_URL }),
);
const mockSet = jest.fn((_owner: string, _uploadId: string) => Promise.resolve({ avatar: AVATAR }));
jest.mock('@/lib/api', () => ({
  createAvatarUpload: (owner: string) => mockCreate(owner),
  setAvatar: (owner: string, uploadId: string) => mockSet(owner, uploadId),
}));
const mockPut = jest.fn((_uri: string, _url: string) => Promise.resolve());
jest.mock('@/lib/put-jpeg', () => ({
  putJpeg: (uri: string, url: string) => mockPut(uri, url),
}));
jest.mock('@/lib/upload-jpeg', () => ({ encodeUploadJpeg: jest.fn() }));
jest.mock('@/hooks/use-my-profile', () => ({ PROFILE_QUERY_KEY: ['profiles', 'me'] }));
const mockSetQueryData = jest.fn();
const mockInvalidate = jest.fn((_filters: unknown) => Promise.resolve());
jest.mock('@/lib/query-client', () => ({
  queryClient: {
    setQueryData: (key: unknown, update: unknown) => mockSetQueryData(key, update),
    invalidateQueries: (filters: unknown) => mockInvalidate(filters),
  },
}));
let mockSignedIn: string | null = OWNER;
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ userId: mockSignedIn }) },
}));

function load() {
  let mod!: typeof import('@/features/profile/profile-photo');
  jest.isolateModules(() => {
    mod = jest.requireActual('@/features/profile/profile-photo');
  });
  return mod;
}

afterEach(() => {
  jest.clearAllMocks();
  mockSignedIn = OWNER;
});

describe('uploadProfilePhoto', () => {
  it('presigns, PUTs and sets under the owner, sending only the uploadId back', async () => {
    const { uploadProfilePhoto } = load();
    await expect(uploadProfilePhoto(OWNER, 'file:///cache/avatar.jpg')).resolves.toEqual(AVATAR);
    expect(mockCreate).toHaveBeenCalledWith(OWNER);
    expect(mockPut).toHaveBeenCalledWith('file:///cache/avatar.jpg', UPLOAD_URL);
    expect(mockSet).toHaveBeenCalledWith(OWNER, UPLOAD_ID);
    expect(mockSetQueryData).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('leaves the profile cache alone once another account is signed in', async () => {
    mockSignedIn = OTHER;
    const { uploadProfilePhoto } = load();
    await uploadProfilePhoto(OWNER, 'file:///cache/avatar.jpg');
    expect(mockSetQueryData).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('sets nothing when the PUT fails', async () => {
    mockPut.mockImplementationOnce(() => Promise.reject(new Error('unreachable')));
    const { uploadProfilePhoto } = load();
    await expect(uploadProfilePhoto(OWNER, 'file:///cache/avatar.jpg')).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
  });
});
