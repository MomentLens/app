import { MAX_MEDIA_IMAGES_BATCH, type MediaImage } from '@momentlens/shared-types';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getMediaImages } from '@/lib/api';

export function useThumbnailMap(
  eventId: string,
  mediaIds: readonly string[],
): {
  images: Record<string, MediaImage>;
  loadedChunkIds: Set<string>;
} {
  // Chunk IDs into batches of at most 50 (MAX_MEDIA_IMAGES_BATCH, D-148)
  const chunks = useMemo(() => {
    const list: string[][] = [];
    for (let i = 0; i < mediaIds.length; i += MAX_MEDIA_IMAGES_BATCH) {
      list.push(mediaIds.slice(i, i + MAX_MEDIA_IMAGES_BATCH));
    }
    return list;
  }, [mediaIds]);

  const queries = useQueries({
    queries: chunks.map((chunk) => {
      const chunkKey = chunk.join(',');
      return {
        queryKey: ['media-images', eventId, 'thumbnail', chunkKey],
        queryFn: ({ signal }: { signal?: AbortSignal }) =>
          getMediaImages(eventId, { mediaIds: chunk, size: 'thumbnail' }, signal),
        staleTime: 45 * 60 * 1000, // 45 minutes (presigned URLs live 1 hour)
        gcTime: 60 * 60 * 1000,
        enabled: Boolean(eventId) && chunk.length > 0,
      };
    }),
  });

  const { images, loadedChunkIds } = useMemo(() => {
    const map: Record<string, MediaImage> = {};
    const loaded = new Set<string>();

    queries.forEach((q, index) => {
      if (q.data?.images) {
        Object.assign(map, q.data.images);
      }
      if (q.isSuccess) {
        const chunk = chunks[index];
        if (chunk) {
          for (const id of chunk) {
            loaded.add(id);
          }
        }
      }
    });

    return { images: map, loadedChunkIds: loaded };
  }, [queries, chunks]);

  return { images, loadedChunkIds };
}
