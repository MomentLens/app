import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';

import { encodeUploadJpeg } from '@/lib/upload-jpeg';

import type { QueueFiles } from './store';

const UPLOAD_NAME = 'upload.jpg';

export interface PreparedUpload {
  photoPath: string;
  contentHash: string;
}

// SHA-256 as the 64 lower-case hex characters ContentHash takes.
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Stage 1, the same for every role (spec §4.8.1, D-58). encodeUploadJpeg draws the photo upright
// with no EXIF and shrinks only an edge past 4096px (D-99, D-146). The result goes to
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
  const cached = new File((await encodeUploadJpeg(files.uri(sourcePath))).uri);
  try {
    const target = new File(files.uri(photoPath));
    await cached.copy(target, { overwrite: true });
    const bytes = await target.bytes();
    return { photoPath, contentHash: hex(await digest(CryptoDigestAlgorithm.SHA256, bytes)) };
  } finally {
    try {
      if (cached.exists) cached.delete();
    } catch {
      /* The OS clears cache files. */
    }
  }
}
