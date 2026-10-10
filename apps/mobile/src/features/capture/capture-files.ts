import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { queueFiles } from '@/features/upload-queue/files';
import type { CaptureFiles } from './capture-store';

export const captureFiles: CaptureFiles = {
  async original(owner, id, uri) {
    if (![owner, id].every((part) => /^[a-zA-Z0-9-]+$/.test(part)))
      throw new Error('Invalid capture directory');
    const directory = new Directory(Paths.document, 'upload-queue', owner, id);
    directory.create({ intermediates: true, idempotent: true });
    const photoPath = `${owner}/${id}/original.jpg`;
    await new File(uri).copy(new File(queueFiles.uri(photoPath)));
    return photoPath;
  },
  async thumbnail(original) {
    const path = original.replace(/\/original\.jpg$/, '/thumb.webp');
    if (path === original) throw new Error('Invalid capture path');
    const context = ImageManipulator.manipulate(queueFiles.uri(original));
    let full;
    let preview;
    let cached: File | undefined;
    try {
      full = await context.renderAsync();
      context.resize(
        full.width >= full.height
          ? { width: Math.min(300, full.width) }
          : { height: Math.min(300, full.height) },
      );
      preview = await context.renderAsync();
      const saved = await preview.saveAsync({ format: SaveFormat.WEBP, compress: 0.8 });
      cached = new File(saved.uri);
      await cached.copy(new File(queueFiles.uri(path)));
      return path;
    } finally {
      preview?.release();
      full?.release();
      context.release();
      try {
        if (cached?.exists) cached.delete();
      } catch {
        /* The OS clears the cache. */
      }
    }
  },
};
