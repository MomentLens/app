import type { PresignedImage, ProfileResponse } from '@momentlens/shared-types';
import type { ImageResult } from 'expo-image-manipulator';

import { PROFILE_QUERY_KEY } from '@/hooks/use-my-profile';
import { createAvatarUpload, setAvatar } from '@/lib/api';
import { putJpeg } from '@/lib/put-jpeg';
import { queryClient } from '@/lib/query-client';
import { encodeUploadJpeg } from '@/lib/upload-jpeg';
import { useAuthStore } from '@/stores/auth';

// A picked photo as the JPEG the profile photo uploads: upright, every EXIF field stripped, JPEG
// at 0.9, shrunk only past 4096px (arch §4.1, D-172). Signup prepares it before the account
// exists, so the upload after signUp has only the network left to do.
export function prepareProfilePhoto(pickedUri: string): Promise<ImageResult> {
  return encodeUploadJpeg(pickedUri);
}

// Uploads a prepared photo and makes it the owner's avatar. It is the avatar and nothing more: no
// face check, no reference, no job (D-141). Every call is bound to the owner, so a photo picked
// under one account never becomes another's (D-146).
//
// Throws ApiError, PhotoUploadError or AccountChangedError.
export async function uploadProfilePhoto(owner: string, jpegUri: string): Promise<PresignedImage> {
  const { uploadId, uploadUrl } = await createAvatarUpload(owner);
  await putJpeg(jpegUri, uploadUrl);
  const { avatar } = await setAvatar(owner, uploadId);
  // The profile query is not keyed by account, so it is written only while the owner is still the
  // one signed in. Logout clears the cache, which covers the rest.
  if (useAuthStore.getState().userId === owner) {
    queryClient.setQueryData<ProfileResponse>(PROFILE_QUERY_KEY, (profile) =>
      profile ? { ...profile, avatar } : profile,
    );
    // A profile read that started before the PUT would bring back the old avatar, as it can
    // right after signup, when the consent gate reads the profile at once.
    void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
  }
  return avatar;
}
