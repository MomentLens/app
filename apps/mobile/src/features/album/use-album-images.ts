import {
  MAX_MEDIA_IMAGES_BATCH,
  type AlbumMediaItem,
  type MediaImage,
  type MediaImagesResponse,
} from '@momentlens/shared-types';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { getMediaImages } from '@/lib/api';

type Versioned = Pick<AlbumMediaItem, 'id' | 'variantVersion'>;

// The loaded photos in batches of at most 50, the serving endpoint's limit (D-148). Each batch is
// keyed on its ids and their versions, so a regenerated photo's batch is a new query and is signed
// again (D-60, root invariant 2).
export function thumbnailBatches(media: readonly Versioned[]): Versioned[][] {
  const batches: Versioned[][] = [];
  for (let i = 0; i < media.length; i += MAX_MEDIA_IMAGES_BATCH) {
    batches.push(media.slice(i, i + MAX_MEDIA_IMAGES_BATCH));
  }
  return batches;
}

function versionKey(item: Versioned): string {
  return `${item.id}:${item.variantVersion}`;
}

export interface ThumbnailMap {
  // Each photo's signed thumbnail, by media id.
  images: Readonly<Record<string, MediaImage>>;
  // Ids the serving endpoint answered without, whose tiles the app drops (D-148).
  omitted: ReadonlySet<string>;
}

// POST /events/{eventId}/media/images for the album's thumbnails.
//
// A photo arriving by Realtime shifts every later batch, which then loads under a new key. Until
// it answers, a tile keeps the image it had at the same version, so the grid does not blank. A
// photo whose version changed has no such image and waits for its new one, so the pre-blur file
// is never kept on purpose.
export function useThumbnailMap(eventId: string, media: readonly Versioned[]): ThumbnailMap {
  const batches = useMemo(() => thumbnailBatches(media), [media]);

  // Last image seen per id and version, for this mount. Media ids are uuids, so two events'
  // photos never share an entry. The Map is mutated in place: filling it never needs a re-render,
  // because the batch that fills it re-renders anyway.
  const [seen] = useState(() => new Map<string, MediaImage>());

  const combine = useCallback(
    (results: UseQueryResult<MediaImagesResponse>[]): ThumbnailMap => {
      const images: Record<string, MediaImage> = {};
      const omitted = new Set<string>();
      results.forEach((result, index) => {
        for (const item of batches[index] ?? []) {
          const image = result.data?.images[item.id];
          if (image !== undefined) {
            images[item.id] = image;
            seen.set(versionKey(item), image);
          } else if (result.isSuccess) {
            omitted.add(item.id);
          } else {
            const previous = seen.get(versionKey(item));
            if (previous !== undefined) images[item.id] = previous;
          }
        }
      });
      return { images, omitted };
    },
    [batches, seen],
  );

  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['media-images', eventId, 'thumbnail', batch.map(versionKey).join(',')],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getMediaImages(
          eventId,
          { mediaIds: batch.map((item) => item.id), size: 'thumbnail' },
          signal,
        ),
      // Presigned URLs live an hour, so a batch is signed again before its URLs run out.
      staleTime: 45 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
    })),
    combine,
  });
}
