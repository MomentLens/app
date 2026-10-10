import { requestPermissionsAsync, saveToLibraryAsync } from 'expo-media-library/legacy';

export async function galleryPermission(): Promise<boolean> {
  return (await requestPermissionsAsync(true, ['photo'])).granted;
}
// Keep the original camera bytes. Upload preparation happens after this save (D-90).
export async function saveOriginalToGallery(uri: string): Promise<void> {
  await saveToLibraryAsync(uri);
}
