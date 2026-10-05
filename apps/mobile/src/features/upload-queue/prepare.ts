import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

import type { QueueFiles } from './store';

// The longest edge the app sends, the one client-side resize root invariant 9 allows.
const MAX_EDGE_PX = 4096;
const JPEG_QUALITY = 0.9;
const UPLOAD_NAME = 'upload.jpg';

export interface PreparedUpload {
  photoPath: string;
  contentHash: string;
}

// SHA-256 as the 64 lower-case hex characters ContentHash takes.
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Stage 1, the same for every role (spec §4.8.1, D-58). expo-image-manipulator draws the photo
// upright, applying its EXIF orientation on both platforms, and saves a JPEG with no EXIF at all,
// the timestamp included (D-99, D-146). Only an edge past 4096px is shrunk. The result goes to
// upload.jpg in the photo's own queue folder, and the hash is taken over the bytes of that file,
// which are the bytes the PUT sends (root invariant 7). The caller stores both in one write before
// anything is sent, so Stage 1 never runs twice for a photo.
//
// The launch sweep has finished before the runner's first write, and the runner writes the path
// only after this resolves, so the sweep never deletes an upload.jpg in progress. One a kill left
// half written is replaced here.
export async function prepareUpload(
  sourcePath: string,
  files: Pick<QueueFiles, 'uri'>,
): Promise<PreparedUpload> {
  const photoPath = `${sourcePath.slice(0, sourcePath.lastIndexOf('/'))}/${UPLOAD_NAME}`;
  const context = ImageManipulator.manipulate(files.uri(sourcePath));
  const images: ImageRef[] = [];
  let cached: File | undefined;
  try {
    let image = await context.renderAsync();
    images.push(image);
    if (Math.max(image.width, image.height) > MAX_EDGE_PX) {
      context.resize(
        image.width >= image.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX },
      );
      image = await context.renderAsync();
      images.push(image);
    }
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
    cached = new File(saved.uri);
    const target = new File(files.uri(photoPath));
    await cached.copy(target, { overwrite: true });
    const bytes = await target.bytes();
    return { photoPath, contentHash: hex(await digest(CryptoDigestAlgorithm.SHA256, bytes)) };
  } finally {
    for (const image of images) image.release();
    context.release();
    try {
      if (cached?.exists) cached.delete();
    } catch {
      /* The OS clears cache files. */
    }
  }
}
