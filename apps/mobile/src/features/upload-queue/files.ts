import { Directory, File, Paths } from 'expo-file-system';
import {
  ImageManipulator,
  SaveFormat,
  type ImageManipulatorContext,
  type ImageRef,
} from 'expo-image-manipulator';

import type { QueueFiles } from './store';

const root = () => new Directory(Paths.document, 'upload-queue');
const LIST_BATCH = 50;
const safeSegment = (value: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(value)) throw new Error('Invalid queue directory');
  return value;
};
function fileAt(path: string): File {
  if (
    path.split('/').some((part) => !/^[a-zA-Z0-9.-]+$/.test(part) || part === '..' || part === '.')
  ) {
    throw new Error('Invalid queue file path');
  }
  return new File(root(), ...path.split('/'));
}
// These files belong to the uploader on this phone. No URL or shared image cache belongs here.
export const queueFiles: QueueFiles = {
  async copy(owner, id, uri) {
    const relative = `${safeSegment(owner)}/${safeSegment(id)}`;
    const directory = new Directory(root(), relative);
    directory.create({ intermediates: true, idempotent: true });
    const extension = new File(uri).extension.replace(/^\./, '');
    const photoPath = `${relative}/source.${/^[a-zA-Z0-9]{1,8}$/.test(extension) ? extension : 'image'}`;
    const thumbnailPath = `${relative}/thumb.webp`;
    let cachedThumbnail: File | undefined;
    let context: ImageManipulatorContext | undefined;
    let image: ImageRef | undefined;
    let preview: ImageRef | undefined;
    try {
      await new File(uri).copy(fileAt(photoPath));
      context = ImageManipulator.manipulate(fileAt(photoPath).uri);
      image = await context.renderAsync();
      context.resize(
        image.width >= image.height
          ? { width: Math.min(300, image.width) }
          : { height: Math.min(300, image.height) },
      );
      preview = await context.renderAsync();
      const saved = await preview.saveAsync({ format: SaveFormat.WEBP, compress: 0.8 });
      cachedThumbnail = new File(saved.uri);
      await cachedThumbnail.copy(fileAt(thumbnailPath));
      return { photoPath, thumbnailPath };
    } catch (error) {
      // Nothing references this directory until the queue INSERT commits.
      try {
        if (directory.exists) directory.delete();
      } catch {
        /* The launch sweep retries. */
      }
      throw error;
    } finally {
      preview?.release();
      image?.release();
      context?.release();
      try {
        if (cachedThumbnail?.exists) cachedThumbnail.delete();
      } catch {
        /* The OS clears cache files. */
      }
    }
  },
  async delete(path) {
    const file = fileAt(path);
    if (file.exists) file.delete();
    const directory = file.parentDirectory;
    if (directory.exists && directory.list().length === 0) directory.delete();
  },
  async list() {
    const directory = root();
    if (!directory.exists) return [];
    const paths: string[] = [];
    const pending: [Directory, string][] = [[directory, '']];
    let listed = 0;
    while (pending.length) {
      const [at, prefix] = pending.pop()!;
      for (const entry of at.list()) {
        const path = `${prefix}${entry.name}`;
        if (entry instanceof Directory) pending.push([entry, `${path}/`]);
        else paths.push(path);
      }
      // Each list() blocks the JS thread, and a Photographer keeps one directory per photo, so
      // the walk hands the thread back between batches while the app starts.
      if (++listed % LIST_BATCH === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return paths;
  },
  uri: (path) => fileAt(path).uri,
};
