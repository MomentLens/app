import {
  ImageManipulator,
  SaveFormat,
  type ImageRef,
  type ImageResult,
} from 'expo-image-manipulator';

// The longest edge the app sends, the one client-side resize root invariant 9 allows.
const MAX_EDGE_PX = 4096;
const JPEG_QUALITY = 0.9;

// A picked photo as the JPEG the app uploads, for a queued photo (spec §4.8.1) and an event cover
// alike. expo-image-manipulator draws the photo upright, applying its EXIF orientation on both
// platforms, and saves a JPEG at 0.9 with no EXIF at all, GPS and the timestamp included (D-99,
// D-146). Only an edge past 4096px is shrunk. The context decodes the photo once and resizes the
// bitmap it holds. The JPEG lands in the cache, and the caller copies it or leaves it to the OS.
export async function encodeUploadJpeg(uri: string): Promise<ImageResult> {
  const context = ImageManipulator.manipulate(uri);
  const images: ImageRef[] = [];
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
    return await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  } finally {
    for (const image of images) image.release();
    context.release();
  }
}
