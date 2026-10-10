import { useEffect, useState } from 'react';
import { File } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { createMMKV } from 'react-native-mmkv';
import { excludeMediaFromBackup } from '../../../modules/local-media';
import { getQueue, runUploads } from '@/features/upload-queue/queue';
import { useAuthStore } from '@/stores/auth';
import { CaptureController } from './capture';
import { captureFiles } from './capture-files';
import { CaptureStore, type CaptureDraft, type GalleryState } from './capture-store';
import { galleryPermission, saveOriginalToGallery } from './gallery';
import { noticeKey, startingMode } from './preferences';

const preferences = createMMKV({ id: 'device-preferences' });
export const readStartingMode = () => startingMode(preferences.getString('cameraStartsIn'));
export const hasLocalNotice = (owner: string) => preferences.getBoolean(noticeKey(owner)) === true;
export const rememberLocalNotice = (owner: string) => preferences.set(noticeKey(owner), true);
export const getCaptures = async () => new CaptureStore(await getQueue(), captureFiles);
export function captureController(take: () => Promise<string>) {
  return new CaptureController({
    userId: () => useAuthStore.getState().userId,
    makeId: randomUUID,
    permission: galleryPermission,
    exclude: excludeMediaFromBackup,
    take,
    persist: async (id, shot, uri) => (await getCaptures()).persist(id, shot, uri),
    claimGallery: async (owner, id, explicit) =>
      (await getCaptures()).claimGallery(owner, id, explicit),
    saveGallery: async (owner, id) => {
      const uri = await (await getCaptures()).originalUri(owner, id);
      if (useAuthStore.getState().userId !== owner) throw new Error('Account changed');
      await saveOriginalToGallery(uri);
    },
    galleryResult: async (owner, id, saved) =>
      (await getCaptures()).galleryResult(owner, id, saved),
    handoff: async (owner, id) => {
      if (useAuthStore.getState().userId !== owner) return;
      await (await getCaptures()).handoff(owner, id);
      void runUploads();
    },
    discardTemporary: async (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  });
}
export async function retryCapture(draft: CaptureDraft): Promise<void> {
  if (useAuthStore.getState().userId !== draft.userId) return;
  if (draft.galleryState === 'saved') {
    await (await getCaptures()).handoff(draft.userId, draft.id);
    void runUploads();
    return;
  }
  const controller = captureController(async () => {
    throw new Error('Retry does not take another photo');
  });
  if (await controller.finishPublic(draft.userId, draft.id, true)) return;
  // The journal, not the draft, says how far the retry got: a save can succeed and the handoff fail.
  const state = await (await getCaptures()).galleryStateOf(draft.userId, draft.id);
  throw new Error(unqueuedMessage(state));
}
// Why a retry did not queue the photo, by the gallery state the journal holds after the attempt.
function unqueuedMessage(state: GalleryState | null): string {
  switch (state) {
    case 'saved':
      return 'The photo is in your gallery, but it could not be added to the upload queue. Try again.';
    case 'saving':
      return 'The gallery save is still in progress. Try again when it finishes.';
    case 'handed_off':
      return 'This photo is already in the upload queue.';
    case null:
      return 'This photo is no longer on this phone.';
    default:
      return 'The gallery save did not finish. The photo stays on this phone.';
  }
}
export function useCaptureDrafts(owner: string | null, eventId: string) {
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const reload = async () => {
      if (!owner) return;
      try {
        const items = await (await getCaptures()).list(owner, eventId);
        if (active && useAuthStore.getState().userId === owner) {
          setDrafts(items);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    void getQueue()
      .then((queue) => {
        if (!active) return;
        unsubscribe = queue.subscribe(() => void reload());
        void reload();
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [owner, eventId]);
  return {
    drafts: drafts.filter((draft) => draft.userId === owner && draft.eventId === eventId),
    error,
  };
}
