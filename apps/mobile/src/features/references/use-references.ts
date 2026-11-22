import type { ListReferencesResponse } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import {
  AccountChangedError,
  ApiError,
  addReference,
  createReferenceUpload,
  deleteReference,
  listReferences,
} from '@/lib/api';
import { putJpeg } from '@/lib/put-jpeg';
import { queryClient } from '@/lib/query-client';
import { encodeUploadJpeg } from '@/lib/upload-jpeg';
import { useAuthStore } from '@/stores/auth';
import { REFERENCE_POLL_MS, isChecking } from './reference-state';

// The caller's reference photos in one event as server state. The key carries the account, so on
// a phone handed to someone else the next account never sees the last one's photos, which are
// presigned for their owner alone (D-109, D-141). Nothing is persisted to disk: every answer holds
// one-hour URLs of the owner's face, and the list is one quick read.
export function referencesQueryKey(eventId: string, owner: string | null) {
  return ['references', owner, eventId] as const;
}

export function useReferences(eventId: string) {
  const owner = useAuthStore((state) => state.userId);
  return useQuery({
    queryKey: referencesQueryKey(eventId, owner),
    queryFn: ({ signal }) => {
      if (owner === null) throw new AccountChangedError();
      return listReferences(owner, eventId, signal);
    },
    enabled: owner !== null,
    // Asks again every two seconds while any photo is still being checked, and stops once the
    // worker has decided them all (D-91). A failed final attempt arrives as `failed` (D-172).
    refetchInterval: (query) =>
      isChecking(query.state.data?.references) ? REFERENCE_POLL_MS : false,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status !== undefined && error.status < 500) &&
      failureCount < 1,
  });
}

function store(eventId: string, owner: string, list: ListReferencesResponse) {
  queryClient.setQueryData(referencesQueryKey(eventId, owner), list);
}

// Stage 1 (arch §4.1), presign, PUT to R2, then add. The worker reads the pixels as stored, so the
// photo is turned upright and every EXIF field stripped first (D-99, D-172). A picked photo from
// one account never lands under another, because every call is bound to the owner (D-146).
//
// Throws ApiError, PhotoUploadError or AccountChangedError. A photo whose PUT landed but whose add
// never answered stays an orphan object with no row, as a cover does (card edge case).
export async function addReferencePhoto(
  eventId: string,
  owner: string,
  pickedUri: string,
): Promise<ListReferencesResponse> {
  const jpeg = await encodeUploadJpeg(pickedUri);
  const { uploadId, uploadUrl } = await createReferenceUpload(owner, eventId);
  await putJpeg(jpeg.uri, uploadUrl);
  const list = await addReference(owner, eventId, uploadId);
  store(eventId, owner, list);
  return list;
}

// A 404 means the reference is already gone, which a resend of a delete that landed also gets,
// so the screen reads the list again rather than showing an error.
export async function removeReferencePhoto(
  eventId: string,
  owner: string,
  referenceId: string,
): Promise<void> {
  try {
    store(eventId, owner, await deleteReference(owner, eventId, referenceId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
      await queryClient.invalidateQueries({ queryKey: referencesQueryKey(eventId, owner) });
      return;
    }
    throw error;
  }
}
